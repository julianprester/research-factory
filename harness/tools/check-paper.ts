// The code checks of a paper node (design §8, the first part): before its style passes and its submit, a
// paper's embeds resolve, its numbers are not typed, its citations are the ones it should be, its Predictions
// are the argument's, and its pins still match the explanation they were taken from.
//
// The manuscript is read raw. Quarto and pandoc render code spans, fences, comments and raw blocks, so a check
// that masks them can be blinded by them. The gate therefore refuses the constructs it cannot read: a fenced
// block of any kind, raw HTML, a TeX command that reads or writes files, and any shortcode but `var` and
// `include`. An allow-list then says which include and image targets may exist, and a fragment is scanned
// raw as well.
//
// Every read is without following a link (`readRegular`, `locate`): a link, or a file where a folder belongs, is
// a problem named by its path. `checkPaper` never throws for the contents of a paper, or for an unreadable one:
// each section is guarded, and a failure is a problem line. A node that is not a paper under an explanation of
// the run is a usage error and throws, as `check-argument.ts` does.
//
// The problems, in order: `workspace/paper.qmd` missing; the front matter (keys, `bibliography`, `csl`); the raw
// syntax (fences, HTML, TeX commands, shortcodes, reference-style images, hand-typed block quotations, an include that
// does not stand alone or does not follow a blank line, a heading or a fenced-div opener); each
// `{{< var k >}}` not in `_variables.yml`, or with no source row that resolves to exactly one row of the
// explanation's registry; the paper's copies of `_variables.yml` and `variables_sources.csv` (and `apa.csl`,
// `_quarto.yml` when the harness templates exist), its table fragments and figures, each byte for byte against
// the explanation's; each include or image outside the allow-list, missing, empty, or a fragment with a shortcode
// or fenced code; the quotations (`verifyQuotes`) and each quote fragment no include names; the citation keys;
// the Predictions fragment (byte for byte: `sectionText` and a newline); the pins; the workspace root (no Quarto
// project file, extension, filter or stylesheet); the bare numbers beyond the limit; then the outline problems
// (`opts.outline`, Task 8) and the render problems (`opts.render`, Task 9).
//
// Warnings: an author placeholder in the front matter, and each bare number while the count is within the limit.
//
// CLI: `node harness/tools/check-paper.ts <nodeDir>` prints `warning: …` lines, then `ok` (exit 0) or one problem
// per line (exit 1). Usage errors exit 2, as in `check-argument.ts`.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { argumentSha, loopDir, locate, readRegular } from "../explain/rounds.ts";
import { parseCsv } from "../explain/reproduce.ts";
import { PAPER_BARE_NUMBER_LIMIT, readConfig } from "../launch.ts";
import { bibKeys, CITATION_TOKEN, IMAGE, INCLUDE_SHORTCODE, VAR_SHORTCODE, scanEmbeds, type EmbedSet } from "../paper/embeds.ts";
import { coverage } from "../paper/outline.ts";
import { verifyQuotes } from "../paper/quotes.ts";
import { findRunDir, nodeIdOf } from "../tree.ts";
import { NUMERAL, loadRegistry, resolvesOnce, sectionText, YAML_VARIABLE } from "./check-argument.ts";
import { citationProblems } from "./check-puzzle.ts";

export interface PaperOptions {
  /** The citation check of `paper.qmd` while drafting; defaults to the real `check-citations.ts`. */
  citations?: (file: string) => string[];
  /** The render check (Task 9); defaults to no problems. */
  render?: (nodeDir: string) => Promise<{ problems: string[] }>;
  /** The most bare numbers a paper may hold in prose; defaults to `paperBareNumberLimit` in config.json. */
  bareNumberLimit?: number;
  /** The outline check: the coverage of the argument's targets and the needs (`outline.ts`); injectable for tests. */
  outline?: (runDir: string, nodeDir: string) => string[];
}

/** What a file read found: absent, refused by name (a link, a folder, a file that is not regular, unreadable), or its bytes. */
type Read = { kind: "absent" } | { kind: "refused"; problem: string } | { kind: "file"; bytes: Buffer };

/** The harness templates `apa.csl` and `_quarto.yml` are copied from (Task 10 adds them). */
const TEMPLATE_DIR = fileURLToPath(new URL("../templates/", import.meta.url));
const TEMPLATED = ["apa.csl", "_quarto.yml"];
const AUTHOR_PLACEHOLDER = "Author names to be added";
const NO_EMBEDS: EmbedSet = { vars: [], includes: [], images: [], quotes: [], citations: [] };

/** The front matter keys a paper may set. Anything else (filters, includes, execution, formats, resources) is a problem. */
const FRONT_KEYS = new Set([
  "title",
  "subtitle",
  "author",
  "keywords",
  "abstract",
  "date",
  "bibliography",
  "csl",
  "link-citations",
  "lang",
  "toc",
  "number-sections",
  "fig-cap-location",
  "tbl-cap-location",
]);
/** The only include targets: a table fragment, a verified quotation and the Predictions fragment. */
const INCLUDE_TARGETS = [/^embeds\/tables\/[^/]+\.qmd$/, /^embeds\/quotes\/Q\d+\.qmd$/, /^embeds\/predictions\.qmd$/];
/** The only image targets: a figure copied from the explanation, and a rendered diagram. */
const IMAGE_TARGETS = [/^embeds\/figures\/[^/]+$/, /^embeds\/diagrams\/[^/]+\.png$/];
/** Workspace root entries Quarto would read as project configuration, extensions or styling. */
const ROOT_REFUSED = ["_metadata.yml", "_extensions"];
const ROOT_FILE_REFUSED = /\.(?:lua|css)$/;

const FENCE = /^\s*(?:`{3}|~{3})/;
/** `<` followed by a letter, `/`, `!` or `?`: a tag, a closing tag, a comment or a declaration. `p < .05` and `x <3` are not. */
const RAW_HTML = /<(?=[A-Za-z/!?])/;
/**
 * The spans pandoc reads as math, blanked for the raw-HTML test only. Matches are found left to right, so a code span,
 * a link or image target or an escaped character that starts first is kept as it is (pandoc reads it first too). The
 * math rules are pandoc's: `$$…$$` (no blank line inside); `\(…\)`; and `$…$` whose opening `$` is followed by a
 * non-space and whose closing `$` is preceded by a non-space and not followed by a digit, so a currency `$5` does not
 * close on a later `$10`. The math group is first, so `\(` is math and not an escaped `(`.
 */
const MATH_OR_KEPT =
  /(?<math>\$\$(?:(?!\r?\n[ \t]*\r?\n)[\s\S])*?\$\$|\\\([^\n]*?\\\)|\$(?=[^\s$])[^$\n]*?(?<=[^\s$\\])\$(?!\d))|(?<ticks>`+)[\s\S]*?\k<ticks>(?!`)|\]\([^)\n]*\)|\\[\s\S]/g;
/** A line that opens an include's allowed position without a blank line: a heading, or a fenced-div opener `::: {…}`. */
const HEADING_LINE = /^\s*#{1,6}\s/;
const DIV_OPENER = /^\s*:{3,}\s*\{.*\}\s*$/;
const TEX_COMMAND = /\\(input|include|write|openin|read|immediate|usepackage|verbatiminput)(?![A-Za-z])/g;
/** Any shortcode, closed or not on this text; masked before the HTML and TeX rules, since `{{<var x>}}` starts with `<v`. */
const ANY_SHORTCODE = /\{\{<[\s\S]*?>\}\}/g;
/** A block quotation, as a prose line starts: after leading spaces and list markers. */
const QUOTE_LINE = /^\s*(?:(?:[-*+]|\d+[.)])\s+)*>/;
const YEAR = /^\d{4}$/;
/** A citation (a token with an `@` in a bracket): the bracket holds one, so its locators are read as locators. */
const CITED = new RegExp(CITATION_TOKEN.source, "u");
/** A locator inside a citation bracket: `p. 12`, `pp. 12-14`, `chap. 3`, `sec. 2`, with its numbers. */
const LOCATOR = /(?<!\p{L})(?:pp?|chaps?|chapters?|secs?|sections?)\.?\s*\d+(?:\s*[-\u2013\u2014]\s*\d+)?/giu;
/** The `date:` key and the value of a front matter line when the value is an ISO date (quoted or not). */
const ISO_DATE_VALUE = /^(date:[ \t]*["']?)\d{4}-\d{2}-\d{2}(?=["']?[ \t\r]*$)/;

/**
 * Checks the paper node at `nodeDir` inside the run at `runDir`. Throws for a `nodeDir` that is not a paper under an
 * explanation of that run: a usage error, not a finding about the paper. Nothing else throws.
 */
export async function checkPaper(
  runDir: string,
  nodeDir: string,
  opts: PaperOptions = {},
): Promise<{ problems: string[]; warnings: string[] }> {
  const root = path.resolve(runDir);
  const paper = path.resolve(nodeDir);
  const relative = path.relative(root, paper);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${nodeDir} is not a node folder inside the run at ${runDir}`);
  }
  const explanation = path.dirname(path.dirname(paper));
  const explanationId = nodeIdOf(explanation);
  if (explanationId === undefined || !explanationId.startsWith("E") || path.basename(path.dirname(paper)) !== "papers") {
    throw new Error(`${nodeDir} is not a paper under an explanation (expected <explanation>/papers/<paper>)`);
  }

  const problems: string[] = [];
  const warnings: string[] = [];

  const manuscript = readFile(paper, "workspace/paper.qmd");
  let qmd: string | undefined;
  if (manuscript.kind === "absent") problems.push("workspace/paper.qmd is missing");
  else if (manuscript.kind === "refused") problems.push(manuscript.problem);
  else qmd = manuscript.bytes.toString("utf8");
  const embeds = qmd === undefined ? NO_EMBEDS : scanEmbeds(qmd);

  if (qmd !== undefined) {
    warnings.push(...authorWarnings(qmd));
    guarded(problems, "workspace/paper.qmd", () => frontProblems(qmd));
    guarded(problems, "workspace/paper.qmd", () => syntaxProblems(qmd));
    guarded(problems, "workspace/paper.qmd", () => includePlacementProblems(qmd));
  }
  guarded(problems, "the explanation's registry", () => variableProblems(paper, explanation, embeds.vars));
  guarded(problems, "the paper's copies", () => sourceProblems(paper, explanation));
  if (qmd !== undefined) guarded(problems, "workspace/embeds", () => embedProblems(paper, embeds));
  guarded(problems, "workspace/embeds/quotes", () => verifyQuotes(runDir, paper));
  if (qmd !== undefined) guarded(problems, "workspace/embeds/quotes", () => unincludedQuotes(paper, embeds));
  if (qmd !== undefined) {
    guarded(problems, "workspace/references.bib", () => citeProblems(paper, embeds, opts.citations ?? ((file) => citationProblems(file))));
  }
  guarded(problems, "workspace/embeds/predictions.qmd", () => predictionProblems(paper, explanation, qmd, embeds));
  guarded(problems, "workspace/checks/pins.json", () => pinProblems(runDir, paper, explanation, explanationId));
  guarded(problems, "the workspace root", () => rootProblems(paper));
  if (qmd !== undefined) {
    const limit = opts.bareNumberLimit ?? configLimit(runDir, problems);
    const hits = paperNumbers(qmd);
    if (hits.length > limit) {
      const listed = hits.slice(0, 10).map((hit) => `line ${hit.line} ${hit.token}`).join(", ");
      const plural = hits.length === 1 ? "" : "s";
      problems.push(`workspace/paper.qmd has ${hits.length} bare number${plural} in prose (limit ${limit}): ${listed}`);
    } else {
      warnings.push(...hits.map((hit) => `workspace/paper.qmd line ${hit.line}: bare number ${hit.token}`));
    }
  }

  // Coverage is read from the manuscript's embeds, so with no paper.qmd it is not run (the missing file is the problem).
  const outline = opts.outline ?? ((runDir, nodeDir) => coverage(runDir, nodeDir).problems);
  if (qmd !== undefined) {
    try {
      problems.push(...outline(runDir, paper));
    } catch (error) {
      problems.push(`outline check failed: ${message(error)}`);
    }
  }
  const render = opts.render ?? (async () => ({ problems: [] }));
  try {
    problems.push(...(await render(paper)).problems);
  } catch (error) {
    problems.push(`render check failed: ${message(error)}`);
  }
  return { problems: [...new Set(problems)], warnings };
}

// ---------------------------------------------------------------------------
// Reading without following a link, and never throwing.

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The system code of a file-system error (`EACCES`, `ELOOP`, …), or undefined for any other error. */
function codeOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** The problem for a failed read of `subject`: an unreadable path names its error code, anything else says it could not be checked. */
function failureOf(error: unknown, subject: string): string {
  const code = codeOf(error);
  return code === undefined ? `${subject} could not be checked: ${message(error)}` : `${subject} cannot be read: ${code}`;
}

/** Runs one section of the check; a failure in it is a problem line, and the other sections still run. */
function guarded(problems: string[], subject: string, check: () => string[]): void {
  try {
    problems.push(...check());
  } catch (error) {
    problems.push(failureOf(error, subject));
  }
}

/** The bytes of `rel` under `node`, or what stopped the read: a link on the path, a folder, a file that is not regular, or an unreadable path. */
function readFile(node: string, rel: string): Read {
  try {
    const bytes = readRegular(node, rel);
    return bytes === undefined ? { kind: "absent" } : { kind: "file", bytes };
  } catch (error) {
    const code = codeOf(error);
    return { kind: "refused", problem: code === undefined ? message(error) : `${rel} cannot be read: ${code}` };
  }
}

/** The entries of a folder, sorted by name; a folder that is absent has none, and one that cannot be listed is a problem. */
function entriesOf(dir: string, shown: string, problems: string[]): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch (error) {
    if (codeOf(error) === "ENOENT") return [];
    problems.push(`${shown} cannot be listed: ${codeOf(error) ?? message(error)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// The front matter and the raw syntax.

/** The index of the line that closes the front matter, or -1 when the file has none (or it is not closed). */
function frontEndOf(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return -1;
  return lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
}

/** The front matter's top-level keys, and the values `bibliography` and `csl` must have. */
function frontProblems(qmd: string): string[] {
  const lines = qmd.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return [];
  const close = frontEndOf(lines);
  if (close < 0) return ["workspace/paper.qmd front matter is not closed"];
  const problems: string[] = [];
  for (let index = 1; index < close; index++) {
    const line = lines[index] ?? "";
    // Indented lines, list items and comments belong to the key above them.
    if (line.trim() === "" || /^\s/.test(line) || /^-\s/.test(line) || line.startsWith("#")) continue;
    const match = /^([A-Za-z][\w-]*):(.*)$/.exec(line);
    if (match === null) {
      problems.push(`workspace/paper.qmd front matter line ${index + 1} is not a key: value line`);
      continue;
    }
    const key = match[1] ?? "";
    const value = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (!FRONT_KEYS.has(key)) problems.push(`workspace/paper.qmd front matter key ${key} is not allowed`);
    if (key === "bibliography" && value !== "references.bib") {
      problems.push("workspace/paper.qmd front matter bibliography must be references.bib");
    }
    if (key === "csl" && value !== "apa.csl") problems.push("workspace/paper.qmd front matter csl must be apa.csl");
  }
  return problems;
}

/**
 * The raw syntax the gate can read, one problem per construct, each naming its line. Shortcodes are counted against
 * their raw `{{<` openers: an opener that is not a `var` or `include` that parses is a problem (so odd spacing cannot
 * hide one), and a name other than those two is a problem by name.
 */
function syntaxProblems(qmd: string): string[] {
  const problems: string[] = [];
  const raw = qmd.split(/\r?\n/);
  const hidden = blank(qmd, ANY_SHORTCODE);
  const hiddenLines = hidden.split(/\r?\n/);
  const htmlLines = blankMath(hidden).split(/\r?\n/);
  const leftoverImages = blank(qmd, IMAGE).split(/\r?\n/);
  raw.forEach((line, index) => {
    const where = `workspace/paper.qmd line ${index + 1}`;
    if (FENCE.test(line)) problems.push(`${where}: fenced code is not allowed (no code blocks, whatever the info string)`);
    if (RAW_HTML.test(htmlLines[index] ?? "")) problems.push(`${where}: raw HTML is not allowed`);
    for (const match of (hiddenLines[index] ?? "").matchAll(TEX_COMMAND)) {
      problems.push(`${where}: TeX command \\${match[1]} is not allowed`);
    }
    if ((leftoverImages[index] ?? "").includes("![")) {
      problems.push(`${where}: reference-style image is not allowed; write it inline as ![alt](embeds/figures/F.png)`);
    }
  });

  const matched = new Set([...qmd.matchAll(VAR_SHORTCODE), ...qmd.matchAll(INCLUDE_SHORTCODE)].map((match) => match.index ?? -1));
  for (const opener of qmd.matchAll(/\{\{</g)) {
    const index = opener.index ?? 0;
    if (matched.has(index)) continue;
    const where = `workspace/paper.qmd line ${lineOf(qmd, index)}`;
    const name = /^\{\{<\s*([^\s>}]*)/.exec(qmd.slice(index, index + 64))?.[1] ?? "";
    if (name === "" || name === "var" || name === "include") {
      problems.push(`${where}: malformed {{< shortcode; write {{< var name >}} or {{< include embeds/… >}}`);
    } else {
      problems.push(`${where}: shortcode ${name} is not allowed (only var and include)`);
    }
  }

  // A block quotation is one an include brings in: a prose line that starts with `>` (after list markers) is typed by hand.
  raw.forEach((line, index) => {
    if (QUOTE_LINE.test(line) && !(index > 0 && QUOTE_LINE.test(raw[index - 1] ?? ""))) {
      problems.push(`workspace/paper.qmd line ${index + 1}: a hand-typed block quotation; quote it with quote_source and include the fragment`);
    }
  });
  return problems;
}

/**
 * Each include stands alone on its own line (only whitespace around the shortcode), and follows a blank line, the front
 * matter's closing fence, the start of the file, a heading or a fenced-div opener (`::: {…}`). Quarto renders an include
 * inside a text line as nothing, with a warning, and one directly after a text line as nothing with no warning (both
 * probed with Quarto 1.9.37). After a heading or a fenced-div opener it renders (probed). After a list item or a figure
 * line it does not, so those are refused.
 */
function includePlacementProblems(qmd: string): string[] {
  const raw = qmd.split(/\r?\n/);
  const front = frontEndOf(raw);
  const problems: string[] = [];
  for (const match of qmd.matchAll(INCLUDE_SHORTCODE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const lineStart = qmd.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = qmd.indexOf("\n", end);
    const line = lineOf(qmd, start);
    const where = `workspace/paper.qmd line ${line}`;
    const alone =
      qmd.slice(lineStart, start).trim() === "" && qmd.slice(end, lineEnd === -1 ? qmd.length : lineEnd).trim() === "";
    if (!alone) {
      problems.push(`${where}: an include must stand alone on its own line; Quarto renders one inside a text line as nothing`);
      continue;
    }
    const index = line - 1;
    const above = raw[index - 1] ?? "";
    const framed = index === 0 || above.trim() === "" || index - 1 === front || HEADING_LINE.test(above) || DIV_OPENER.test(above);
    if (!framed) {
      problems.push(`${where}: an include must follow a blank line; Quarto renders one directly after a text line as nothing`);
    }
  }
  return problems;
}

/** The line (1-based) that holds `index` of `text`. */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** The text with every match of `pattern` blanked to spaces, newlines kept, so every line keeps its number. */
function blank(text: string, pattern: RegExp): string {
  return text.replace(pattern, (span) => span.replace(/[^\n]/g, " "));
}

/** The text with its math spans blanked (newlines kept); code spans, link targets and escapes are left as they are. */
function blankMath(text: string): string {
  return text.replace(MATH_OR_KEPT, (span, math: string | undefined) => (math === undefined ? span : span.replace(/[^\n]/g, " ")));
}

// ---------------------------------------------------------------------------
// Variables and the copies of the explanation's outputs.

/**
 * Each variable the paper uses is in the paper's `_variables.yml`, and has a row in its `variables_sources.csv` whose
 * source resolves to exactly one row of the explanation's registry. A registry that cannot be read is named, and the
 * source is not checked (the problem is already there).
 */
function variableProblems(paper: string, explanation: string, vars: string[]): string[] {
  if (vars.length === 0) return [];
  const problems: string[] = [];
  const names = new Set<string>();
  const yml = readFile(paper, "workspace/_variables.yml");
  if (yml.kind === "file") {
    for (const line of yml.bytes.toString("utf8").split(/\r?\n/)) {
      const match = YAML_VARIABLE.exec(line);
      if (match !== null) names.add(match[1] ?? "");
    }
  } else if (yml.kind === "refused") {
    problems.push(yml.problem);
  }

  let rows: { variable: string; source: string }[] = [];
  let rowsKnown = false;
  const csv = readFile(paper, "workspace/variables_sources.csv");
  if (csv.kind === "file") {
    try {
      const [header = [], ...body] = parseCsv(csv.bytes.toString("utf8"));
      const variableAt = header.indexOf("variable");
      const sourceAt = header.indexOf("source");
      if (variableAt === -1 || sourceAt === -1) {
        problems.push("workspace/variables_sources.csv has no variable and source columns");
      } else {
        rows = body
          .filter((fields) => !(fields.length === 1 && fields[0] === ""))
          .map((fields) => ({ variable: fields[variableAt] ?? "", source: fields[sourceAt] ?? "" }));
        rowsKnown = true;
      }
    } catch (error) {
      problems.push(`workspace/variables_sources.csv: ${message(error)}`);
    }
  } else if (csv.kind === "refused") {
    problems.push(csv.problem);
  }

  const registryProblems: string[] = [];
  const registry = loadRegistry(explanation, registryProblems);
  problems.push(...registryProblems.map((problem) => `explanation ${problem}`));

  for (const name of [...new Set(vars)].sort()) {
    if (!names.has(name)) {
      problems.push(`variable ${name} is not in workspace/_variables.yml`);
      continue;
    }
    if (!rowsKnown || registry === undefined) continue;
    const own = rows.filter((row) => row.variable === name);
    if (own.length === 0) problems.push(`variable ${name} has no row in workspace/variables_sources.csv`);
    else if (!own.some((row) => resolvesOnce(row.source, registry))) {
      problems.push(`variable ${name} has no source row that resolves to exactly one registry row`);
    }
  }
  return problems;
}

/**
 * The paper's copies of the explanation's assets, tables and figures, byte for byte: `_variables.yml` and
 * `variables_sources.csv` from `output/assets/`, each table fragment from `output/assets/` and each figure from
 * `output/figures/` of the same name. A copy with no counterpart is a problem; so is a link or a folder in a copy
 * folder. The harness templates are compared when they exist, and skipped (until Task 10 adds them) when not.
 */
function sourceProblems(paper: string, explanation: string): string[] {
  const problems: string[] = [];
  for (const name of ["_variables.yml", "variables_sources.csv"]) {
    problems.push(...sameFile(paper, explanation, `workspace/${name}`, `workspace/output/assets/${name}`));
  }
  for (const name of TEMPLATED) {
    const template = path.join(TEMPLATE_DIR, name);
    if (!fs.existsSync(template)) continue;
    problems.push(...sameBytes(readFile(paper, `workspace/${name}`), `workspace/${name}`, `harness/templates/${name}`, fs.readFileSync(template)));
  }
  for (const [folder, source] of [
    ["workspace/embeds/tables", "workspace/output/assets"],
    ["workspace/embeds/figures", "workspace/output/figures"],
  ] as const) {
    guarded(problems, folder, () => copyProblems(paper, explanation, folder, source));
  }
  return problems;
}

function sameFile(paper: string, explanation: string, own: string, source: string): string[] {
  const expected = readFile(explanation, source);
  if (expected.kind === "absent") return [`${source} is missing from the explanation`];
  if (expected.kind === "refused") return [expected.problem];
  return sameBytes(readFile(paper, own), own, source, expected.bytes);
}

/** The problems with `actual` (read from `own`) against the bytes `expected` of `source`. */
function sameBytes(actual: Read, own: string, source: string, expected: Buffer): string[] {
  if (actual.kind === "absent") return [`${own} is missing`];
  if (actual.kind === "refused") return [actual.problem];
  return actual.bytes.equals(expected) ? [] : [`${own} differs from the explanation's ${source}`];
}

/** Each regular file of a paper copy folder compared with the explanation's file of the same name. */
function copyProblems(paper: string, explanation: string, folder: string, source: string): string[] {
  const found = locate(paper, folder);
  if (found.kind === "absent") return [];
  if (found.kind === "refused") return [found.problem];
  if (found.kind === "file") return [`${folder} is not a folder`];
  const problems: string[] = [];
  for (const entry of entriesOf(path.join(paper, ...folder.split("/")), folder, problems)) {
    const shown = `${folder}/${entry.name}`;
    if (entry.isSymbolicLink()) problems.push(`${shown} is a link: refusing to read it`);
    else if (!entry.isFile()) problems.push(`${shown} is not a regular file`);
    else {
      const expected = readFile(explanation, `${source}/${entry.name}`);
      if (expected.kind === "absent") problems.push(`${shown} has no counterpart in the explanation's ${source}/`);
      else if (expected.kind === "refused") problems.push(expected.problem);
      else problems.push(...sameBytes(readFile(paper, shown), shown, `${source}/${entry.name}`, expected.bytes));
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Embeds: includes and images are on the allow-list, resolve, and their fragments hold text only.

function embedProblems(paper: string, embeds: EmbedSet): string[] {
  const problems: string[] = [];
  for (const target of [...new Set(embeds.includes)]) {
    if (!INCLUDE_TARGETS.some((pattern) => pattern.test(target))) {
      problems.push(
        target.startsWith("embeds/")
          ? `workspace/paper.qmd includes ${target}, which is not an allowed embed (embeds/tables/*.qmd, embeds/quotes/Q<nn>.qmd, embeds/predictions.qmd)`
          : `workspace/paper.qmd includes ${target}, which is outside workspace/embeds/`,
      );
      continue;
    }
    problems.push(...includeFile(paper, target));
  }
  for (const target of [...new Set(embeds.images)]) {
    if (!IMAGE_TARGETS.some((pattern) => pattern.test(target))) {
      problems.push(`workspace/paper.qmd shows image ${target}, which is not an allowed embed`);
      continue;
    }
    problems.push(...imageFile(paper, target));
  }
  return problems;
}

/** An included fragment: present, a regular file, not empty, and text only (no shortcode, no fenced code). */
function includeFile(paper: string, target: string): string[] {
  const file = readFile(paper, `workspace/${target}`);
  if (file.kind === "absent") return [`workspace/paper.qmd includes ${target}, which is missing`];
  if (file.kind === "refused") return [file.problem];
  const text = file.bytes.toString("utf8");
  if (text.trim() === "") return [`workspace/paper.qmd includes ${target}, which is empty`];
  const shown = `workspace/${target}`;
  const problems: string[] = [];
  if (text.includes("{{<")) problems.push(`${shown}: contains a {{< shortcode (fragments hold text only)`);
  if (text.split(/\r?\n/).some((line) => FENCE.test(line))) problems.push(`${shown}: contains fenced code (fragments hold text only)`);
  return problems;
}

function imageFile(paper: string, target: string): string[] {
  const file = readFile(paper, `workspace/${target}`);
  if (file.kind === "absent") return [`workspace/paper.qmd shows image ${target}, which is missing`];
  if (file.kind === "refused") return [file.problem];
  return file.bytes.length === 0 ? [`workspace/paper.qmd shows image ${target}, which is empty`] : [];
}

/** Each quote fragment in `embeds/quotes/` is named by an include of the paper. */
function unincludedQuotes(paper: string, embeds: EmbedSet): string[] {
  const found = locate(paper, "workspace/embeds/quotes");
  if (found.kind !== "folder") return [];
  const problems: string[] = [];
  for (const entry of entriesOf(path.join(paper, "workspace", "embeds", "quotes"), "workspace/embeds/quotes", problems)) {
    if (!entry.isFile() || !/^Q\d+\.qmd$/.test(entry.name)) continue;
    if (!embeds.includes.includes(`embeds/quotes/${entry.name}`)) {
      problems.push(`workspace/embeds/quotes/${entry.name} is not included by paper.qmd`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Citations: numeric chunk ids while drafting, keys in references.bib once it exists.

function citeProblems(paper: string, embeds: EmbedSet, citations: (file: string) => string[]): string[] {
  const problems: string[] = [];
  const bib = readFile(paper, "workspace/references.bib");
  const finalised = bib.kind !== "absent";
  if (bib.kind === "refused") problems.push(bib.problem);
  const keys = bib.kind === "file" ? bibKeys(bib.bytes.toString("utf8")) : new Set<string>();
  for (const key of [...new Set(embeds.citations)]) {
    const numeric = /^\d+$/.test(key);
    if (!finalised && !numeric) {
      problems.push(`workspace/paper.qmd cites @${key}, which is neither a numeric chunk id nor in references.bib`);
    } else if (finalised && !keys.has(key)) {
      problems.push(
        numeric
          ? `workspace/paper.qmd still cites chunk id @${key} (references.bib exists: finalise the citations)`
          : `workspace/paper.qmd cites @${key}, which is not in references.bib`,
      );
    }
  }
  if (!finalised) {
    for (const problem of citations(path.join(paper, "workspace", "paper.qmd"))) problems.push(`workspace/paper.qmd: ${problem}`);
  }
  return problems;
}


// ---------------------------------------------------------------------------
// The Predictions, and the pins.

/**
 * The Predictions fragment is included by the paper, and is the argument's `## Predictions` section followed by one
 * newline, byte for byte: no trimming and no line-ending changes, so a stray space or a blank line is a difference.
 */
function predictionProblems(paper: string, explanation: string, qmd: string | undefined, embeds: EmbedSet): string[] {
  const problems: string[] = [];
  const argument = readFile(explanation, "workspace/argument.md");
  if (argument.kind === "absent") problems.push("the explanation's workspace/argument.md is missing");
  else if (argument.kind === "refused") problems.push(argument.problem);
  if (qmd !== undefined && !embeds.includes.includes("embeds/predictions.qmd")) {
    problems.push("workspace/paper.qmd does not include embeds/predictions.qmd");
  }
  const fragment = readFile(paper, "workspace/embeds/predictions.qmd");
  if (fragment.kind === "absent") problems.push("workspace/embeds/predictions.qmd is missing");
  else if (fragment.kind === "refused") problems.push(fragment.problem);
  else if (argument.kind === "file") {
    const expected = Buffer.from(`${sectionText(argument.bytes.toString("utf8"), "Predictions")}\n`, "utf8");
    if (!fragment.bytes.equals(expected)) {
      problems.push("workspace/embeds/predictions.qmd differs from the argument's ## Predictions section");
    }
  }
  return problems;
}

/**
 * The pins in `workspace/checks/pins.json` against the explanation now: the argument's sha, the reproduction's
 * workspace hash (`owners/phase-3/loop/<E>/reproduction.json`) and the sha of the Predictions section. A pin that
 * differs is `stale`; a missing reproduction record is named, and its hash is not compared.
 */
function pinProblems(runDir: string, paper: string, explanation: string, explanationId: string): string[] {
  const pinsFile = readFile(paper, "workspace/checks/pins.json");
  if (pinsFile.kind === "absent") return ["checks/pins.json is missing (run init_paper)"];
  if (pinsFile.kind === "refused") return [pinsFile.problem];
  let pins: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(pinsFile.bytes.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not a pin record");
    pins = value as Record<string, unknown>;
  } catch (error) {
    return [`checks/pins.json is unreadable: ${message(error)}`];
  }

  const problems: string[] = [];
  const reproductionRel = path
    .relative(runDir, path.join(loopDir(runDir, explanationId), "reproduction.json"))
    .split(path.sep)
    .join("/");
  const reproduction = readFile(runDir, reproductionRel);
  let workspaceHash: string | undefined;
  if (reproduction.kind === "absent") {
    problems.push(`owners/phase-3/loop/${explanationId}/reproduction.json is missing (the explanation has not been reproduced)`);
  } else if (reproduction.kind === "refused") {
    problems.push(reproduction.problem);
  } else {
    try {
      const record: unknown = JSON.parse(reproduction.bytes.toString("utf8"));
      const hash = typeof record === "object" && record !== null ? (record as { workspaceHash?: unknown }).workspaceHash : undefined;
      if (typeof hash !== "string") throw new Error("not a reproduction record");
      workspaceHash = hash;
    } catch (error) {
      problems.push(`${reproductionRel} is unreadable: ${message(error)}`);
    }
  }

  const argument = readFile(explanation, "workspace/argument.md");
  let argumentHash: string | undefined;
  let predictionsHash: string | undefined;
  if (argument.kind === "file") {
    try {
      argumentHash = argumentSha(explanation);
    } catch (error) {
      problems.push(`the explanation's workspace/argument.md cannot be pinned: ${message(error)}`);
    }
    const predictions = sectionText(argument.bytes.toString("utf8"), "Predictions");
    predictionsHash = createHash("sha256").update(predictions).digest("hex");
  }

  const current: [string, string | undefined][] = [
    ["argumentSha", argumentHash],
    ["workspaceHash", workspaceHash],
    ["predictionsSha", predictionsHash],
  ];
  for (const [field, now] of current) {
    if (now !== undefined && pins[field] !== now) problems.push(`stale: ${field} changed since the paper was last pinned (repin_paper)`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The workspace root: no Quarto project configuration, extension, filter or stylesheet the writer could plant.

function rootProblems(paper: string): string[] {
  const problems: string[] = [];
  for (const name of ROOT_REFUSED) {
    const found = locate(paper, `workspace/${name}`);
    if (found.kind === "refused") problems.push(found.problem);
    else if (found.kind !== "absent") problems.push(`workspace/${name} is not allowed (Quarto would read it)`);
  }
  for (const entry of entriesOf(path.join(paper, "workspace"), "workspace", problems)) {
    if (ROOT_FILE_REFUSED.test(entry.name)) problems.push(`workspace/${entry.name} is not allowed (Quarto would read it)`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Bare numbers and the warnings.

/**
 * The bare numbers of the paper's text, each with its 1-based line. Counted: digit runs of two or more digits and
 * decimals, even when a letter or a percent sign follows (`12x`, `95th`, `12%`); in link text, image captions,
 * headings, citation brackets (only the `@key` and its locator are blanked) and front matter values. Not counted: the
 * shortcodes (includes and variables), link and image targets, URLs, identifiers in `{#…}`, block quotations, an ISO
 * date that is a front matter `date:` value, a locator (`p.`, `pp.`, `chap.`, `sec.`) inside a citation bracket, and a
 * four-digit year from 1900 to 2100.
 */
function paperNumbers(qmd: string): { line: number; token: string }[] {
  const raw = qmd.split(/\r?\n/);
  let text = blank(blankFrontDates(qmd), ANY_SHORTCODE);
  text = blank(text, /(?<=\])\([^)\n]*\)/g);
  text = text.replace(/^(\s*\[[^\]\n]+\]:)\s*(\S+)/gm, (span, label: string) => label + " ".repeat(span.length - label.length));
  text = blank(text, /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g);
  text = text.replace(/\[[^\]\n]*\]/g, (span) => (CITED.test(span) ? blank(span, LOCATOR) : span));
  text = blank(text, CITATION_TOKEN);
  text = blank(text, /\{#[A-Za-z][\w:.-]*\}/g);
  const hits: { line: number; token: string }[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (QUOTE_LINE.test(raw[index] ?? "")) return;
    for (const match of line.matchAll(new RegExp(NUMERAL, "g"))) {
      const token = match[0];
      if (YEAR.test(token) && Number(token) >= 1900 && Number(token) <= 2100) continue;
      hits.push({ line: index + 1, token });
    }
  });
  return hits;
}

/** The front matter with each `date:` value that is an ISO date blanked to spaces: a date is not a count. */
function blankFrontDates(qmd: string): string {
  const lines = qmd.split("\n");
  const close = frontEndOf(lines);
  for (let index = 1; index < close; index++) {
    lines[index] = (lines[index] ?? "").replace(ISO_DATE_VALUE, (span, key: string) => key + " ".repeat(span.length - key.length));
  }
  return lines.join("\n");
}

/** The author placeholder in the front matter, as a warning. */
function authorWarnings(qmd: string): string[] {
  const front = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(qmd);
  return front?.[1]?.includes(AUTHOR_PLACEHOLDER)
    ? [`workspace/paper.qmd's author is still the placeholder "${AUTHOR_PLACEHOLDER}"`]
    : [];
}

/** The bare-number limit from config.json; a config that cannot be read is a problem, and the default applies. */
function configLimit(runDir: string, problems: string[]): number {
  try {
    return readConfig(runDir).paperBareNumberLimit;
  } catch (error) {
    problems.push(message(error));
    return PAPER_BARE_NUMBER_LIMIT;
  }
}

// ---------------------------------------------------------------------------
// CLI.

function usage(text: string): number {
  console.error(`check-paper: ${text}`);
  console.error("usage: node harness/tools/check-paper.ts <nodeDir>");
  return 2;
}

async function main(argv: string[]): Promise<number> {
  const [nodeDirArg, ...rest] = argv;
  if (nodeDirArg === undefined || rest.length > 0) return usage("expected a paper node directory");
  if (nodeDirArg.startsWith("--")) return usage(`unknown option ${nodeDirArg}`);
  const nodeDir = path.resolve(nodeDirArg);
  if (!fs.existsSync(nodeDir) || !fs.statSync(nodeDir).isDirectory()) return usage(`${nodeDirArg} is not a directory`);
  const runDir = findRunDir(nodeDir);
  if (runDir === undefined) return usage(`no .git repository above ${nodeDirArg}`);

  let result: { problems: string[]; warnings: string[] };
  try {
    result = await checkPaper(runDir, nodeDir);
  } catch (error) {
    return usage(message(error));
  }
  for (const warning of result.warnings) console.log(`warning: ${warning}`);
  if (result.problems.length === 0) {
    console.log("ok");
    return 0;
  }
  for (const problem of result.problems) console.log(problem);
  return 1;
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
