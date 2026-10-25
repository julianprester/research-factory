// The handbook quotations of a paper (design §5.4): `quoteSource` copies a verbatim
// line range of the exploration copy into `workspace/embeds/quotes/` as a block
// quotation, and `verifyQuotes` checks every fragment against that copy again.
//
// The writer's `write` tool cannot reach `embeds/quotes/` (the paper lane), so the
// fragments and `quotes.json` are written here, after every check, through
// `writeAtomic`. The exploration copy, the hold-out list and the paper's quotes are
// read without following a link (`locate`, `readRegular`). A hold-out file is
// refused by its name in the list and by the file it is: a link to a listed file,
// or a hard link to one, in the dataset or in the copy.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { locate, readRegular, writeAtomic } from "../explain/rounds.ts";
import { readRun } from "../tree.ts";

export interface Quote {
  id: string;
  source: string;
  start: number;
  end: number;
  fileSha256: string;
  text: string;
}

/** The most lines one quotation may carry. */
export const MAX_QUOTE_LINES = 20;

/** The exploration copy, relative to the run. */
const EXPLORATION = "analysis-data/exploration";
/** The hold-out list, relative to the run. */
const HOLDOUT_LIST = "prep/Z01-profile/workspace/split/holdout.txt";
/** The quotes folder, relative to the paper node. */
const QUOTES_DIR = "workspace/embeds/quotes";
const QUOTES_INDEX = "quotes.json";
const FRAGMENT = /^(Q\d+)\.qmd$/;

/** What `readSource` returns: the file's bytes, its lines (LF, trailing whitespace trimmed) and sha256. */
interface Source {
  lines: string[];
  sha256: string;
}

/** The exploration copy with its hold-out list, as one check reads them. */
interface Exploration {
  root: string;
  realRoot: string;
  holdoutNames: Set<string>;
  /** Identities of the listed hold-out files: `dev:ino` and `real:<path>` keys. */
  holdoutFiles: Set<string>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isInside(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function embedOf(id: string): string {
  return `{{< include embeds/quotes/${id}.qmd >}}`;
}

function idOf(n: number): string {
  return `Q${String(n).padStart(2, "0")}`;
}

/**
 * The relative path of a quotation's source, as `/`-separated segments with no `.`.
 * Refused: an absolute path, a `..` segment, an empty segment, NUL or another control
 * character, `-->` (the fragment's header is an HTML comment), and a path naming nothing.
 */
function sourceOf(input: unknown): string {
  if (typeof input !== "string" || input === "") throw new Error("path must be a non-empty string");
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new Error(`${JSON.stringify(input)} contains a control character`);
  if (path.isAbsolute(input)) throw new Error(`${input} is absolute: give a path relative to the exploration copy`);
  if (input.includes("-->")) throw new Error(`${input} contains -->, which cannot sit in a fragment's header`);
  const parts = input.split("/");
  if (parts.some((part) => part === "")) throw new Error(`${input} has an empty segment`);
  if (parts.includes("..")) throw new Error(`${input} has a .. segment: refusing to leave the exploration copy`);
  const kept = parts.filter((part) => part !== ".");
  if (kept.length === 0) throw new Error(`${input} names no file`);
  return kept.join("/");
}

function checkRange(start: unknown, end: unknown): void {
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error("start and end must be whole line numbers");
  if (start < 1 || end < start) throw new Error(`lines ${start}-${end}: start is at least 1 and no later than end`);
  if (end - start + 1 > MAX_QUOTE_LINES) {
    throw new Error(`a quotation takes at most ${MAX_QUOTE_LINES} lines: lines ${start}-${end} are ${end - start + 1}`);
  }
}

/** The lines of a file, LF endings and trailing whitespace trimmed per line; the final newline ends the last line. */
function linesOf(bytes: Buffer): string[] {
  const lines = bytes.toString("utf8").replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => line.trimEnd());
}

/** Lines `start` to `end` (1-based, inclusive) of a file's lines; refused when past the end or blank. */
function sliceOf(lines: string[], start: number, end: number): string[] {
  checkRange(start, end);
  if (end > lines.length) throw new Error(`lines ${start}-${end}: the file has ${lines.length} lines`);
  const slice = lines.slice(start - 1, end);
  if (slice.every((line) => line === "")) throw new Error(`lines ${start}-${end} are blank`);
  return slice;
}

/**
 * The fragment for a quotation: the header comment, the lines as a block quotation
 * (`> ` on each, `>` for an empty line), and the source line. LF endings.
 */
function fragmentOf(quote: Quote, slice: string[]): string {
  const header = `<!-- quote ${quote.id} source=${quote.source} lines=${quote.start}-${quote.end} sha256=${quote.fileSha256} -->`;
  const block = slice.map((line) => (line === "" ? ">" : `> ${line}`));
  return [header, ...block, `— ${quote.source}, lines ${quote.start}–${quote.end}`, ""].join("\n");
}

/** Records one listed hold-out file (if it exists and is a file) by its inode and by its real path. */
function addIdentity(out: Set<string>, file: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!stat.isFile()) return;
  out.add(`${stat.dev}:${stat.ino}`);
  out.add(`real:${fs.realpathSync(file)}`);
}

/**
 * The exploration copy and the hold-out list of a run. Refused, so nothing is quoted,
 * when the copy is missing or is a link, or when the hold-out list is missing, a link,
 * or unreadable: without the list the check cannot run.
 */
function explorationOf(runDir: string): Exploration {
  const root = path.join(runDir, ...EXPLORATION.split("/"));
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(root);
  } catch {
    throw new Error(`${EXPLORATION} is missing: there is no exploration copy to quote from`);
  }
  if (!rootStat.isDirectory()) throw new Error(`${EXPLORATION} is not a real folder`);
  const realRoot = fs.realpathSync(root);

  const list = readRegular(runDir, HOLDOUT_LIST);
  if (list === undefined) throw new Error(`${HOLDOUT_LIST} is missing: refusing to quote without the hold-out list`);
  const holdoutNames = new Set(
    list
      .toString("utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => path.posix.normalize(line)),
  );

  const dataset = path.resolve(runDir, readRun(runDir).dataset);
  const holdoutFiles = new Set<string>();
  for (const name of holdoutNames) {
    addIdentity(holdoutFiles, path.join(dataset, name));
    addIdentity(holdoutFiles, path.join(root, name));
  }
  return { root, realRoot, holdoutNames, holdoutFiles };
}

/**
 * The verbatim source of a quotation, read from the exploration copy. Refused: a
 * hold-out file (by name, or as a file it resolves to), a missing file, a link anywhere
 * on the path, a folder, or a file whose real path leaves the copy.
 */
function readSource(ctx: Exploration, rel: string): Source {
  if (ctx.holdoutNames.has(rel)) throw new Error(`${rel} is in the hold-out list: quotes may not read it`);
  const target = path.join(ctx.root, ...rel.split("/"));
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(target);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (stat?.isFile() && (ctx.holdoutFiles.has(`${stat.dev}:${stat.ino}`) || ctx.holdoutFiles.has(`real:${fs.realpathSync(target)}`))) {
    throw new Error(`${rel} is the same file as a hold-out file: quotes may not read it`);
  }

  const found = locate(ctx.root, rel);
  if (found.kind === "absent") throw new Error(`${rel} does not exist in the exploration copy`);
  if (found.kind === "refused") throw new Error(found.problem);
  if (found.kind === "folder") throw new Error(`${rel} is a folder, not a regular file`);
  if (!isInside(ctx.realRoot, fs.realpathSync(target))) throw new Error(`${rel} resolves outside the exploration copy`);
  const bytes = readRegular(ctx.root, rel);
  if (bytes === undefined) throw new Error(`${rel} does not exist in the exploration copy`);
  return { lines: linesOf(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** The quotes folder of a paper, refused when a link or a file stands where it belongs. */
function quotesFolderOf(nodeDir: string): string {
  const found = locate(nodeDir, QUOTES_DIR);
  if (found.kind === "refused") throw new Error(found.problem);
  if (found.kind === "file") throw new Error(`${QUOTES_DIR} is a file, not a folder`);
  return path.join(nodeDir, ...QUOTES_DIR.split("/"));
}

/** The entries of `quotes.json`; none when the file is absent. Throws on a file or an entry that is malformed. */
function indexOf(nodeDir: string): Quote[] {
  const bytes = readRegular(nodeDir, `${QUOTES_DIR}/${QUOTES_INDEX}`);
  if (bytes === undefined) return [];
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (typeof value !== "object" || value === null || !Array.isArray((value as { quotes?: unknown }).quotes)) {
    throw new Error("quotes.json has no quotes list");
  }
  return (value as { quotes: unknown[] }).quotes.map((entry) => {
    const q = entry as Partial<Record<keyof Quote, unknown>> | null;
    if (
      typeof q !== "object" ||
      q === null ||
      typeof q.id !== "string" ||
      !/^Q\d+$/.test(q.id) ||
      typeof q.source !== "string" ||
      !Number.isInteger(q.start) ||
      !Number.isInteger(q.end) ||
      typeof q.fileSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(q.fileSha256) ||
      typeof q.text !== "string"
    ) {
      throw new Error("a quotes.json entry is malformed");
    }
    return { id: q.id, source: q.source, start: q.start as number, end: q.end as number, fileSha256: q.fileSha256, text: q.text };
  });
}

/**
 * Quote a verbatim line range of a file in the exploration copy. Writes the fragment
 * `workspace/embeds/quotes/<id>.qmd` and the entry in `quotes.json`, after every check;
 * a refusal writes nothing. The same slice of the same file gives the existing id.
 */
export function quoteSource(
  runDir: string,
  nodeDir: string,
  input: { path: string; start: number; end: number },
): { id: string; embed: string } {
  const rel = sourceOf(input.path);
  checkRange(input.start, input.end);
  const ctx = explorationOf(runDir);
  const folder = quotesFolderOf(nodeDir);
  const quotes = indexOf(nodeDir);
  const source = readSource(ctx, rel);
  const slice = sliceOf(source.lines, input.start, input.end);

  const existing = quotes.find(
    (q) => q.source === rel && q.start === input.start && q.end === input.end && q.fileSha256 === source.sha256,
  );
  if (existing) return { id: existing.id, embed: embedOf(existing.id) };

  const top = Math.max(0, ...quotes.map((q) => Number(q.id.slice(1))));
  const quote: Quote = {
    id: idOf(top + 1),
    source: rel,
    start: input.start,
    end: input.end,
    fileSha256: source.sha256,
    text: slice.join("\n"),
  };
  writeAtomic(path.join(folder, `${quote.id}.qmd`), fragmentOf(quote, slice));
  writeAtomic(path.join(folder, QUOTES_INDEX), `${JSON.stringify({ quotes: [...quotes, quote] }, null, 2)}\n`);
  return { id: quote.id, embed: embedOf(quote.id) };
}

/** The problems with one entry: its fragment, and its text and fragment against the exploration copy. */
function entryProblems(runDir: string, nodeDir: string, quote: Quote): string[] {
  const { id } = quote;
  const problems: string[] = [];
  let fragment: string | undefined;
  try {
    const bytes = readRegular(nodeDir, `${QUOTES_DIR}/${id}.qmd`);
    if (bytes === undefined) problems.push(`${id}: fragment ${id}.qmd is missing`);
    else fragment = bytes.toString("utf8");
  } catch (error) {
    problems.push(`${id}: ${message(error)}`);
  }

  let source: Source;
  let slice: string[];
  try {
    source = readSource(explorationOf(runDir), sourceOf(quote.source));
    slice = sliceOf(source.lines, quote.start, quote.end);
  } catch (error) {
    problems.push(`${id}: ${message(error)}`);
    return problems;
  }
  if (source.sha256 !== quote.fileSha256) {
    problems.push(`${id}: ${quote.source} changed since it was quoted (sha256 ${quote.fileSha256}, now ${source.sha256})`);
  }
  if (slice.join("\n") !== quote.text) {
    problems.push(`${id}: the entry's text is not lines ${quote.start}-${quote.end} of ${quote.source} in the exploration copy`);
  }
  if (fragment !== undefined && fragment !== fragmentOf(quote, slice)) {
    problems.push(`${id}: fragment ${id}.qmd is not the verbatim lines ${quote.start}-${quote.end} of ${quote.source}`);
  }
  return problems;
}

/**
 * Every problem with a paper's quotations, one string per problem, naming the quote id.
 * Checked: each fragment against the exploration copy's lines (same normalisation as
 * quoting), the file's sha256, the source against the hold-out list, the entry's text,
 * a fragment missing from quotes.json, an entry without its fragment, and any other
 * file in the quotes folder. Empty when the folder is clean.
 */
export function verifyQuotes(runDir: string, nodeDir: string): string[] {
  let quotes: Quote[];
  try {
    quotes = indexOf(nodeDir);
  } catch (error) {
    return [`quotes.json cannot be read: ${message(error)}`];
  }

  const problems: string[] = [];
  const found = locate(nodeDir, QUOTES_DIR);
  if (found.kind === "refused") return [`${QUOTES_DIR}: ${found.problem}`];
  if (found.kind === "file") return [`${QUOTES_DIR} is a file, not a folder`];
  const ids = new Set(quotes.map((q) => q.id));
  if (found.kind === "folder") {
    const folder = path.join(nodeDir, ...QUOTES_DIR.split("/"));
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === QUOTES_INDEX) continue;
      const match = FRAGMENT.exec(entry.name);
      // A listed fragment that is not a regular file is reported by its entry below, once.
      if (match !== null && ids.has(match[1] as string)) continue;
      if (!entry.isFile()) problems.push(`${entry.name}: not a regular file in the quotes folder`);
      else if (match === null) problems.push(`${entry.name}: not a quote fragment`);
      else problems.push(`${match[1]}: fragment ${entry.name} is not in quotes.json`);
    }
  }

  const seen = new Set<string>();
  for (const quote of quotes) {
    if (seen.has(quote.id)) {
      problems.push(`${quote.id}: listed twice in quotes.json`);
      continue;
    }
    seen.add(quote.id);
    problems.push(...entryProblems(runDir, nodeDir, quote));
  }
  return problems;
}
