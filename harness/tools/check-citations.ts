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
/** Safety cap for a citation that follows a quote: beyond this it is not the quote's citation. */
const CITATION_DISTANCE = 1_500;
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
 * Lowercase, unify quote marks and apostrophes, unify hyphens and dashes, drop
 * the quote marks that are punctuation, join a hyphen to what follows it
 * (`self- promote` and `prac-\ntices` become `self-promote` and `prac-tices`),
 * collapse whitespace and strip trailing punctuation. Comparing quotes through
 * this makes an attribution robust to the typography and line wrapping of the
 * citation without ever dropping an intra-word hyphen: `re-sign` stays
 * `re-sign`, so a quote of `resign` cannot match it.
 *
 * A quotation mark that is not between two letters is typography, not words -
 * `about 'who we are' as an organization` and `about "who we are" as an
 * organization` are the same sentence - while an apostrophe between two letters
 * is part of the word, so `it's` never becomes `its`.
 */
export function normaliseForQuote(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u02bc']/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033"`]/g, '"')
    // An en/em dash set off by spaces is punctuation standing in for a space.
    .replace(/\s+[\u2013\u2014\u2015]\s+/g, " ")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    // A hyphen keeps its place but loses the whitespace after it, so
    // `self- promote`, `prac-\ntices` and their unbroken spellings agree.
    .replace(/-\s+/g, "-")
    // Keep only apostrophes that sit between two letters; every other quotation
    // mark is the source's typography and is dropped.
    .replace(/(?<!\p{L})['"]|['"](?!\p{L})/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?")\]]+$/, "")
    .trim();
}

/**
 * The form a quote is matched in. Quotation marks that are not part of a word
 * are already gone in `normaliseForQuote`, so only a stray quote between two
 * letters (never an apostrophe) is dropped here.
 */
function quoteKey(s: string): string {
  return normaliseForQuote(s).replace(/"/g, "");
}

/**
 * Every form of a text that a quote may be compared against: the plain
 * normalised key, plus - when the *original* text hyphenates across a line break
 * - the key with each hyphen that was followed by whitespace removed entirely.
 * That second key is what lets a quote of `practices` match a source written
 * `prac-\ntices`. A hyphen the original does not follow with whitespace
 * (`re-sign`, `co-op`, an unspaced en dash `10\u201320`) yields no such key, so a
 * quote that drops or changes it can never match.
 */
function quoteKeys(s: string): string[] {
  const keys = [quoteKey(s)];
  const joined = quoteKey(s.replace(/[-\u2010\u2011\u2012\u2013\u2014\u2015\u2212]\s+/g, ""));
  if (!keys.includes(joined)) keys.push(joined);
  return keys;
}

/** Fenced code is not prose: blank it out, but keep every newline so line numbers survive. */
function stripFences(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, (fence) => fence.replace(/[^\n]/g, " "));
}

/** The quoted spans of a markdown document, paired left to right, one paragraph at a time. */
function quotedSpans(markdown: string): { start: number; end: number }[] {
  const clean = stripFences(markdown);
  const spans: { start: number; end: number }[] = [];
  let straightOpen = -1;
  let curlyOpen = -1;
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (char === "\n" && /^\n[ \t]*\n/.test(clean.slice(i))) {
      // A paragraph break resets straight-quote pairing: one stray `"` must not
      // flip every later pair in the file.
      straightOpen = -1;
    }
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

/** One citation group: brackets separated only by whitespace and `,`/`;`, so `[@1] [@2]` and `[@1], [@2]` are one group. */
interface CitationGroup {
  start: number;
  end: number;
  ids: string[];
}

/**
 * The citation groups of the sentence `[start, end)`, skipping any brackets that
 * fall inside a quoted span. Two citation brackets are in the same group when
 * only whitespace and `,`/`;` separate them.
 */
function citationGroupsIn(
  clean: string,
  start: number,
  end: number,
  spans: { start: number; end: number }[],
): CitationGroup[] {
  const brackets: { start: number; end: number; ids: string[] }[] = [];
  for (let i = start; i < end; i++) {
    const span = spans.find((candidate) => i >= candidate.start && i <= candidate.end);
    if (span !== undefined) {
      i = span.end;
      continue;
    }
    if (clean[i] !== "[") continue;
    const bracket = /^\[[^\]]*\]/.exec(clean.slice(i, end));
    if (bracket === null) continue;
    const ids = citationIdsInBracket(bracket[0].slice(1, -1));
    if (ids.length > 0) brackets.push({ start: i, end: i + bracket[0].length, ids });
    i += bracket[0].length - 1;
  }

  const groups: CitationGroup[] = [];
  for (const bracket of brackets) {
    const previous = groups.at(-1);
    if (previous !== undefined && /^[\s,;]*$/.test(clean.slice(previous.end, bracket.start))) {
      previous.end = bracket.end;
      previous.ids.push(...bracket.ids);
    } else {
      groups.push({ ...bracket });
    }
  }
  return groups;
}

/** True when `index` is inside one of the quoted spans. */
function insideSpan(spans: { start: number; end: number }[], index: number): boolean {
  return spans.some((span) => index >= span.start && index <= span.end);
}

/** The start of the sentence containing `from`, skipping quotes and brackets. */
function sentenceStart(clean: string, spans: { start: number; end: number }[], from: number): number {
  let start = 0;
  for (let i = 0; i < from; i++) {
    if (insideSpan(spans, i)) continue;
    const char = clean[i];
    if (char === "[") {
      const close = clean.indexOf("]", i);
      if (close >= 0) i = close;
      continue;
    }
    if (
      (char === "." || char === "!" || char === "?") &&
      (i + 1 >= clean.length || /\s/.test(clean[i + 1] ?? ""))
    ) {
      start = i + 1;
    } else if (char === "\n" && /^\n[ \t]*\n/.test(clean.slice(i))) {
      start = i + 1;
    }
  }
  return start;
}

/** The end of the sentence containing `from`, skipping quotes and brackets. */
function sentenceEnd(clean: string, spans: { start: number; end: number }[], from: number): number {
  for (let i = from; i < clean.length; i++) {
    if (insideSpan(spans, i)) continue;
    const char = clean[i];
    if (char === "[") {
      const close = clean.indexOf("]", i);
      if (close >= 0) i = close;
      continue;
    }
    if (
      (char === "." || char === "!" || char === "?") &&
      (i + 1 >= clean.length || /\s/.test(clean[i + 1] ?? ""))
    ) {
      return i + 1;
    }
    if (char === "\n" && /^\n[ \t]*\n/.test(clean.slice(i))) return i;
  }
  return clean.length;
}

/**
 * The citation group a quote at `span` attaches to in its sentence. The quote
 * takes the first group that follows it in that sentence, however far away it
 * is; only when the sentence cites nothing after the quote does the nearest
 * preceding group carry it. A following group more than `CITATION_DISTANCE`
 * characters away means the quote has no citation, rather than being an excuse
 * to fall back to an earlier group the sentence does not attribute it to.
 */
function groupForQuote(
  clean: string,
  spans: { start: number; end: number }[],
  span: { start: number; end: number },
): CitationGroup | null {
  const start = sentenceStart(clean, spans, span.start);
  const end = sentenceEnd(clean, spans, span.end + 1);
  const groups = citationGroupsIn(clean, start, end, spans);
  const following = groups.find((group) => group.start >= span.end);
  if (following !== undefined) {
    return following.start - span.end <= CITATION_DISTANCE ? following : null;
  }
  return groups.filter((group) => group.end <= span.start).at(-1) ?? null;
}

/**
 * The quotes of `markdown` that attach to a citation. Quotes are paired left to
 * right within a paragraph - a short quotation inside a sentence never
 * mismatches the spans around it - spans are 15-600 characters, and fenced code
 * blocks are ignored. Every quote in a sentence attaches to the first citation
 * group *after* it in that sentence at any distance, and only to the nearest
 * group *before* it when the sentence cites nothing after it (see
 * `groupForQuote`).
 */
export function extractQuotedCitations(markdown: string): QuotedCitation[] {
  const clean = stripFences(markdown);
  const spans = quotedSpans(markdown);
  const found: QuotedCitation[] = [];
  for (const span of spans) {
    const quote = clean.slice(span.start + 1, span.end);
    if (quote.length < 15 || quote.length > 600) continue;
    const group = groupForQuote(clean, spans, span);
    if (group === null) continue;
    found.push({ quote, ids: group.ids, line: clean.slice(0, span.start).split("\n").length });
  }
  return found;
}

/**
 * The quote's fragments that are long enough to check: split at `...`/`\u2026` and
 * at editorial insertions in square brackets such as `[their]` - a bracketed word
 * is the quoting author's, not the source's, exactly as an ellipsis marks elided
 * text - then keep \u2265 8 normalised chars. When every fragment is shorter than
 * that, the whole quote is the fragment: a quote must never pass vacuously.
 */
function quoteFragments(quote: string): string[] {
  const fragments = quote
    .split(/\.\.\.|\u2026|\[[^\]]*\]/)
    .map((fragment) => quoteKey(fragment))
    .filter((fragment) => fragment.length >= 8);
  if (fragments.length > 0) return fragments;
  const whole = quoteKey(quote);
  return whole.length > 0 ? [whole] : [];
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
    const texts = item.ids.flatMap((id) => quoteKeys(fetchChunk(id) ?? ""));
    const passes = fragments.every((fragment) => texts.some((text) => text.includes(fragment)));
    if (passes) continue;

    let foundIn: string | null = null;
    for (const id of item.ids) {
      for (const neighbour of fetchNeighbours(id)) {
        if (neighbour.id === id) continue;
        const texts = quoteKeys(neighbour.text);
        if (fragments.every((fragment) => texts.some((text) => text.includes(fragment)))) {
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
    const stderr = (result.stderr ?? "").trim();
    // `deepis context <unknown id>` exits 1 with `Error: Chunk <id> not found`.
    // That is an absent chunk, not an unreachable deepis: return no chunks so the
    // quote check reports it as missing rather than telling the worker to retry.
    if (/chunk\b.*\bnot found/i.test(stderr) || /chunk\b.*\bnot found/i.test(result.stdout ?? "")) return [];
    throw new DeepisUnavailable(`deepis context exited ${result.status}: ${stderr}`);
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
    const missingSet = new Set(missing);
    const checked = quoted
      .map((item) => ({ ...item, ids: item.ids.filter((id) => !missingSet.has(id)) }))
      .filter((item) => item.ids.length > 0);
    if (checked.length > 0) bad = checkQuotes(checked, deepisChunk, deepisNeighbours).bad;
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
