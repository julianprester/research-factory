// Deterministic citation check: every `[@chunk_id]` in a markdown paper must be
// a chunk that deepis knows about, and every sentence in quotation marks must be
// verbatim in the chunk it cites (workers were citing the chunk they searched
// for while quoting the neighbouring chunk they read).
//
// Observed `deepis metadata` shape (verified with
// `deepis metadata 144636,999999999 -f json`):
//
//   {
//     "papers": [
//       {
//         "paper_id": 1411,
//         "chunk_ids": [144636],          // ints: one entry per requested chunk that exists
//         "doi": "10.2307/4132331",
//         "title": "Studying Knowledge Management ...",
//         "authors": "[{\"name\": ...}]",  // a JSON-encoded string, not an array
//         "year": 2002,
//         "journal": "MIS Quarterly",
//         "abstract": "..."
//       }
//     ]
//   }
//
// An unknown chunk id is simply absent from every paper's `chunk_ids` - a query
// for only unknown ids returns `{"papers": []}` - and deepis still exits 0. So
// the comparison here, not the exit code, is what decides whether a citation is
// missing. (`deepis metadata` with no ids at all is a usage error, exit 120;
// this tool never makes that call.)
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** deepis metadata accepts a bounded comma-separated id list, so resolve in batches. */
const BATCH_SIZE = 50;
/** Every deepis call is bounded; a hung database must not hang the tool. */
const DEEPIS_TIMEOUT_MS = 60_000;
/** A quoted sentence must be followed by its citation within this many characters. */
const CITATION_WINDOW = 60;
/** How far on each side of a cited chunk the neighbour search looks. */
const NEIGHBOUR_WINDOW = 4;

/** deepis could not be reached or answered with something unusable (exit 2, not exit 1). */
export class DeepisUnavailable extends Error {}

/**
 * The chunk ids cited by `markdown`, unique and in first-seen order.
 * Citation forms: `[@123]`, `[@1;@2]` and `[-@3, p. 4]`. An `@` is only a
 * citation inside square brackets and after `[` (via `^`), `;`, `,` or `-`, so
 * an email such as `foo@123.com` and prose brackets like `[see above]` are ignored.
 */
export function extractChunkIds(markdown: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const bracket of markdown.matchAll(/\[[^\]]*\]/g)) {
    for (const id of citationIdsInBracket(bracket[0].slice(1, -1))) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

/** The ids of the citations in one square bracket's body (`[@1;@2, p. 4]` ends up here as `@1;@2, p. 4`). */
function citationIdsInBracket(body: string): string[] {
  const ids: string[] = [];
  for (const citation of body.matchAll(/(?:^|[;,\-])\s*@(\d+)/g)) {
    const id = citation[1];
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/** Which of `ids` the resolver does not know about, in input order. */
export function checkCitations(
  ids: string[],
  resolve: (ids: string[]) => Set<string>,
): { missing: string[] } {
  const resolved = resolve(ids);
  return { missing: ids.filter((id) => !resolved.has(id)) };
}

/**
 * Resolve chunk ids through `deepis metadata <ids> -f json`, in batches of 50,
 * collecting every `papers[].chunk_ids` entry. Throws DeepisUnavailable for any
 * infrastructure failure (not installed, timeout, non-zero exit, bad JSON).
 */
export function deepisResolver(ids: string[]): Set<string> {
  const resolved = new Set<string>();
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const result = spawnSync("deepis", ["metadata", batch.join(","), "-f", "json"], {
      encoding: "utf8",
      timeout: DEEPIS_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new DeepisUnavailable("deepis is not installed or not on PATH");
      if (code === "ETIMEDOUT") {
        throw new DeepisUnavailable(`deepis did not answer within ${DEEPIS_TIMEOUT_MS / 1000}s`);
      }
      throw new DeepisUnavailable(`could not run deepis: ${result.error.message}`);
    }
    if (result.status === null) {
      throw new DeepisUnavailable(`deepis did not answer within ${DEEPIS_TIMEOUT_MS / 1000}s`);
    }
    if (result.status !== 0) {
      throw new DeepisUnavailable(
        `deepis metadata exited ${result.status}: ${(result.stderr ?? "").trim()}`,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      throw new DeepisUnavailable("deepis metadata returned invalid JSON");
    }
    const papers = (payload as { papers?: { chunk_ids?: unknown }[] }).papers;
    if (!Array.isArray(papers)) throw new DeepisUnavailable("deepis metadata returned no papers array");
    for (const paper of papers) {
      if (!Array.isArray(paper.chunk_ids)) continue;
      for (const id of paper.chunk_ids) resolved.add(String(id));
    }
  }
  return resolved;
}

/** A quoted sentence and the ids of the citation bracket that follows it. */
export interface QuotedCitation {
  quote: string;
  ids: string[];
  line: number;
}

/** A quote that is not verbatim in any of its cited chunks, and where it lives instead. */
export interface BadQuote extends QuotedCitation {
  /** The neighbour chunk that holds the quote, or null when no neighbour (±4) does. */
  foundIn: string | null;
}

/**
 * Lowercase, unify quote marks and apostrophes (single or double, straight or
 * curly) to one character, unify dashes, collapse whitespace and strip trailing
 * punctuation. Comparing quotes through this makes an attribution robust to the
 * typography and line wrapping of the citation.
 */
export function normaliseForQuote(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u02bc\u201c\u201d\u201e\u201f\u2033'"`]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?")\]]+$/, "")
    .trim();
}

/**
 * The form a quote is matched in: normalised, then with every quote mark and
 * apostrophe dropped. Inner quotation marks are the source's typography, not its
 * words, so `the organization "is"` and `the organization 'is'` agree.
 */
function quoteKey(s: string): string {
  return normaliseForQuote(s).replace(/"/g, "");
}

/** Fenced code is not prose: blank it out, but keep every newline so line numbers survive. */
function stripFences(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, (fence) => fence.replace(/[^\n]/g, " "));
}

/** The quoted spans of a markdown document, paired left to right. */
function quotedSpans(markdown: string): { start: number; end: number }[] {
  const clean = stripFences(markdown);
  const spans: { start: number; end: number }[] = [];
  let straightOpen = -1;
  let curlyOpen = -1;
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (char === "\u201c") {
      curlyOpen = i;
    } else if (char === "\u201d") {
      if (curlyOpen >= 0) {
        spans.push({ start: curlyOpen, end: i });
        curlyOpen = -1;
      }
    } else if (char === '"') {
      if (straightOpen < 0) {
        straightOpen = i;
      } else {
        spans.push({ start: straightOpen, end: i });
        straightOpen = -1;
      }
    }
  }
  return spans;
}

/**
 * The quotes of `markdown` that are followed, within 60 characters on the same
 * paragraph, by a citation bracket. Quotes are paired left to right - a short
 * quotation inside a sentence never mismatches the spans around it - spans are
 * 15-600 characters, and fenced code blocks are ignored.
 */
export function extractQuotedCitations(markdown: string): QuotedCitation[] {
  const clean = stripFences(markdown);
  const found: QuotedCitation[] = [];
  for (const span of quotedSpans(markdown)) {
    const quote = clean.slice(span.start + 1, span.end);
    if (quote.length < 15 || quote.length > 600) continue;
    const paragraphEnd = clean.indexOf("\n\n", span.end + 1);
    const windowEnd = Math.min(
      span.end + 1 + CITATION_WINDOW,
      paragraphEnd < 0 ? clean.length : paragraphEnd,
    );
    const bracket = /\[[^\]]*@\d+[^\]]*\]/.exec(clean.slice(span.end + 1, windowEnd));
    if (bracket === null) continue;
    const ids = citationIdsInBracket(bracket[0].slice(1, -1));
    if (ids.length === 0) continue;
    found.push({ quote, ids, line: clean.slice(0, span.start).split("\n").length });
  }
  return found;
}

/** The quote's fragments that are long enough to check: split at `...`/`\u2026`, keep \u2265 8 normalised chars. */
function quoteFragments(quote: string): string[] {
  return quote
    .split(/\.\.\.|\u2026/)
    .map((fragment) => quoteKey(fragment))
    .filter((fragment) => fragment.length >= 8);
}

/**
 * A quote passes when, after the quote-normalising comparison, every fragment of
 * it occurs in the text of at least one of its cited chunks. A failure is looked
 * up in the cited chunks' neighbours (which the caller fetches) and reported as
 * `foundIn`. Any DeepisUnavailable thrown by the fetchers escapes to the caller.
 */
export function checkQuotes(
  items: { quote: string; ids: string[]; line: number }[],
  fetchChunk: (id: string) => string | null,
  fetchNeighbours: (id: string) => { id: string; text: string }[],
): { bad: BadQuote[] } {
  const bad: BadQuote[] = [];
  for (const item of items) {
    const fragments = quoteFragments(item.quote);
    if (fragments.length === 0) continue;
    const texts = item.ids.map((id) => quoteKey(fetchChunk(id) ?? ""));
    const passes = fragments.every((fragment) => texts.some((text) => text.includes(fragment)));
    if (passes) continue;

    let foundIn: string | null = null;
    for (const id of item.ids) {
      for (const neighbour of fetchNeighbours(id)) {
        if (neighbour.id === id) continue;
        const text = quoteKey(neighbour.text);
        if (fragments.every((fragment) => text.includes(fragment))) {
          foundIn = neighbour.id;
          break;
        }
      }
      if (foundIn !== null) break;
    }
    bad.push({ quote: item.quote, ids: item.ids, line: item.line, foundIn });
  }
  return { bad };
}

/** One chunk of `deepis context <id> --before N --after N -f json`. */
interface DeepisChunk {
  chunk_id: string;
  target: boolean;
  content: string;
}

/**
 * Run `deepis context <id> --before N --after N -f json` and return its chunks.
 * Throws DeepisUnavailable for any infrastructure failure, exactly as the
 * metadata resolver does.
 */
function deepisContext(id: string, before: number, after: number): DeepisChunk[] {
  const result = spawnSync(
    "deepis",
    ["context", id, "--before", String(before), "--after", String(after), "-f", "json"],
    { encoding: "utf8", timeout: DEEPIS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new DeepisUnavailable("deepis is not installed or not on PATH");
    if (code === "ETIMEDOUT") {
      throw new DeepisUnavailable(`deepis did not answer within ${DEEPIS_TIMEOUT_MS / 1000}s`);
    }
    throw new DeepisUnavailable(`could not run deepis: ${result.error.message}`);
  }
  if (result.status === null) {
    throw new DeepisUnavailable(`deepis did not answer within ${DEEPIS_TIMEOUT_MS / 1000}s`);
  }
  if (result.status !== 0) {
    throw new DeepisUnavailable(
      `deepis context exited ${result.status}: ${(result.stderr ?? "").trim()}`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new DeepisUnavailable("deepis context returned invalid JSON");
  }
  const chunks = (payload as { chunks?: unknown }).chunks;
  if (!Array.isArray(chunks)) throw new DeepisUnavailable("deepis context returned no chunks array");
  return chunks.map((chunk) => {
    const entry = chunk as { chunk_id?: unknown; target?: unknown; content?: unknown };
    return {
      chunk_id: String(entry.chunk_id),
      target: entry.target === true,
      content: typeof entry.content === "string" ? entry.content : "",
    };
  });
}

const chunkCache = new Map<string, string | null>();

/** The text of the cited chunk itself: the one chunk `deepis context` marks `target`. */
function deepisChunk(id: string): string | null {
  const cached = chunkCache.get(id);
  if (cached !== undefined) return cached;
  const target = deepisContext(id, 0, 0).find((chunk) => chunk.target);
  const text = target === undefined ? null : target.content;
  chunkCache.set(id, text);
  return text;
}

const neighbourCache = new Map<string, { id: string; text: string }[]>();

/** The chunks within ±4 of `id`, the window the misattribution hint is read from. */
function deepisNeighbours(id: string): { id: string; text: string }[] {
  const cached = neighbourCache.get(id);
  if (cached !== undefined) return cached;
  const list = deepisContext(id, NEIGHBOUR_WINDOW, NEIGHBOUR_WINDOW)
    .filter((chunk) => !chunk.target && chunk.chunk_id !== id)
    .map((chunk) => ({ id: chunk.chunk_id, text: chunk.content }));
  neighbourCache.set(id, list);
  return list;
}

function main(argv: string[]): number {
  const file = argv[0];
  if (file === undefined || argv.length > 1) {
    console.error("usage: node harness/tools/check-citations.ts <file.md>");
    return 2;
  }
  let markdown: string;
  try {
    markdown = fs.readFileSync(file, "utf8");
  } catch (error) {
    console.error(`check-citations: cannot read ${file}: ${(error as Error).message}`);
    return 2;
  }

  const ids = extractChunkIds(markdown);
  const quoted = extractQuotedCitations(markdown);
  if (ids.length === 0 && quoted.length === 0) {
    console.log("ok 0 citations");
    return 0;
  }

  let missing: string[] = [];
  try {
    if (ids.length > 0) missing = checkCitations(ids, deepisResolver).missing;
  } catch (error) {
    if (error instanceof DeepisUnavailable) {
      console.error(`check-citations: deepis is not reachable: ${error.message}`);
      return 2;
    }
    throw error;
  }

  let bad: BadQuote[] = [];
  try {
    if (quoted.length > 0) bad = checkQuotes(quoted, deepisChunk, deepisNeighbours).bad;
  } catch (error) {
    if (error instanceof DeepisUnavailable) {
      console.error(`check-citations: deepis is not reachable: ${error.message}`);
      return 2;
    }
    throw error;
  }

  if (missing.length === 0 && bad.length === 0) {
    console.log(`ok ${ids.length} citations, ${quoted.length} quotes`);
    return 0;
  }
  for (const id of missing) console.error(`missing chunk id ${id}`);
  for (const item of bad) {
    const where = item.foundIn === null ? "not found nearby" : `found in chunk ${item.foundIn}`;
    const preview = item.quote.replace(/\s+/g, " ").slice(0, 80);
    console.error(
      `quote not in cited chunk ${item.ids.join(";")} (line ${item.line}): "${preview}" — ${where}`,
    );
  }
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
