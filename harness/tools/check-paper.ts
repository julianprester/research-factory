// The code checks of a paper node (design §8, the first part): before its style passes and its submit, a
// paper's embeds resolve, its numbers are not typed, its citations are the ones it should be, its Predictions
// are the argument's, and its pins still match the explanation they were taken from.
//
// The paper is written by a worker and the explanation's outputs by scripts, so every read is without following
// a link (`readRegular`, `locate`): a link, or a file where a folder belongs, is a problem named by its path. The
// checks never throw for the contents of a paper; an unreadable input is a problem. A node that is not a paper
// under an explanation of the run is a usage error and throws, as `check-argument.ts` does.
//
// The problems, in order: `workspace/paper.qmd` missing; each `{{< var k >}}` not in `_variables.yml`, or with no
// source row that resolves to exactly one row of the explanation's registry; the paper's copies of
// `_variables.yml` and `variables_sources.csv` (and `apa.csl`, `_quarto.yml` when the harness templates exist),
// its table fragments and figures, each byte for byte against the explanation's; each include or image that is
// missing, a link, outside `workspace/embeds/` or empty; each quotation's problem (`verifyQuotes`), a quote
// fragment no include names, a hand-typed block quotation; a citation key that is neither a numeric chunk id nor
// in `references.bib` (while drafting), a numeric chunk id or a key missing from `references.bib` (once it
// exists), and the citation check's problems on the draft; the Predictions fragment not included or not the
// argument's `## Predictions`; the pins missing, unreadable or stale; the bare numbers in prose beyond the limit;
// then the outline problems (`opts.outline`, Task 8) and the render problems (`opts.render`, Task 9).
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
import { proseLines, scanEmbeds, type EmbedSet } from "../paper/embeds.ts";
import { verifyQuotes } from "../paper/quotes.ts";
import { findRunDir, nodeIdOf } from "../tree.ts";
import { bareNumberHits, loadRegistry, resolvesOnce, sectionText, YAML_VARIABLE } from "./check-argument.ts";
import { citationProblems } from "./check-puzzle.ts";

export interface PaperOptions {
  /** The citation check of `paper.qmd` while drafting; defaults to the real `check-citations.ts`. */
  citations?: (file: string) => string[];
  /** The render check (Task 9); defaults to no problems. */
  render?: (nodeDir: string) => Promise<{ problems: string[] }>;
  /** The most bare numbers a paper may hold in prose; defaults to `paperBareNumberLimit` in config.json. */
  bareNumberLimit?: number;
  /** The outline check (Task 8); defaults to no problems. */
  outline?: (runDir: string, nodeDir: string) => string[];
}

/** What a file read found: absent, refused by name (a link, a folder, a file that is not regular), or its bytes. */
type Read = { kind: "absent" } | { kind: "refused"; problem: string } | { kind: "file"; bytes: Buffer };

/** The harness templates `apa.csl` and `_quarto.yml` are copied from (Task 10 adds them). */
const TEMPLATE_DIR = fileURLToPath(new URL("../templates/", import.meta.url));
const TEMPLATED = ["apa.csl", "_quarto.yml"];
const AUTHOR_PLACEHOLDER = "Author names to be added";
const NO_EMBEDS: EmbedSet = { vars: [], includes: [], images: [], quotes: [], citations: [] };

/**
 * Checks the paper node at `nodeDir` inside the run at `runDir`. Throws for a `nodeDir` that is not a paper
 * under an explanation of that run: a usage error, not a finding about the paper.
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
  if (qmd !== undefined) warnings.push(...authorWarnings(qmd));

  const argument = readFile(explanation, "workspace/argument.md");
  problems.push(...variableProblems(paper, explanation, embeds.vars));
  problems.push(...sourceProblems(paper, explanation));
  if (qmd !== undefined) problems.push(...embedProblems(paper, embeds));
  problems.push(...quoteProblems(runDir, paper, qmd, embeds));
  if (qmd !== undefined) problems.push(...citeProblems(paper, embeds, opts.citations ?? ((file) => citationProblems(file))));
  problems.push(...predictionProblems(paper, qmd, embeds, argument));
  problems.push(...pinProblems(runDir, paper, explanation, explanationId, argument));
  if (qmd !== undefined) {
    const limit = opts.bareNumberLimit ?? configLimit(runDir, problems);
    const hits = bareNumberHits(numberProse(qmd));
    if (hits.length > limit) {
      const listed = hits.slice(0, 10).map((hit) => `line ${hit.line} ${hit.token}`).join(", ");
      const plural = hits.length === 1 ? "" : "s";
      problems.push(`workspace/paper.qmd has ${hits.length} bare number${plural} in prose (limit ${limit}): ${listed}`);
    } else {
      warnings.push(...hits.map((hit) => `workspace/paper.qmd line ${hit.line}: bare number ${hit.token}`));
    }
  }

  const outline = opts.outline ?? (() => []);
  try {
    problems.push(...outline(runDir, paper));
  } catch (error) {
    problems.push(`outline check failed: ${message(error)}`);
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
// Reading without following a link.

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The bytes of `rel` under `node`, or what stopped the read (a link on the path, a folder, a file that is not regular). */
function readFile(node: string, rel: string): Read {
  try {
    const bytes = readRegular(node, rel);
    return bytes === undefined ? { kind: "absent" } : { kind: "file", bytes };
  } catch (error) {
    return { kind: "refused", problem: message(error) };
  }
}

/** The entries of a folder, by name; a folder that cannot be listed is a problem, not a throw. */
function entriesOf(dir: string, shown: string, problems: string[]): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch (error) {
    problems.push(`${shown} cannot be listed: ${message(error)}`);
    return [];
  }
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
    try {
      problems.push(...sameBytes(readFile(paper, `workspace/${name}`), `workspace/${name}`, `harness/templates/${name}`, fs.readFileSync(template)));
    } catch (error) {
      problems.push(`harness/templates/${name} cannot be read: ${message(error)}`);
    }
  }
  problems.push(...copyProblems(paper, explanation, "workspace/embeds/tables", "workspace/output/assets"));
  problems.push(...copyProblems(paper, explanation, "workspace/embeds/figures", "workspace/output/figures"));
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
// Embeds: includes and images resolve, quotations are verified and included, and nothing is typed by hand.

/** Each include and image resolves to a non-empty regular file under `workspace/embeds/`. */
function embedProblems(paper: string, embeds: EmbedSet): string[] {
  const problems: string[] = [];
  for (const target of [...new Set(embeds.includes)]) problems.push(...embedFile(paper, target, "includes"));
  for (const target of [...new Set(embeds.images)]) problems.push(...embedFile(paper, target, "shows image"));
  return problems;
}

function embedFile(paper: string, target: string, verb: string): string[] {
  const rel = path.posix.normalize(target);
  if (!rel.startsWith("embeds/")) return [`workspace/paper.qmd ${verb} ${target}, which is outside workspace/embeds/`];
  const file = readFile(paper, `workspace/${rel}`);
  if (file.kind === "absent") return [`workspace/paper.qmd ${verb} ${target}, which is missing`];
  if (file.kind === "refused") return [file.problem];
  if (file.bytes.toString("utf8").trim() === "") return [`workspace/paper.qmd ${verb} ${target}, which is empty`];
  return [];
}

/** The quotation problems: `verifyQuotes`, then each fragment left out of the paper, then each block quotation typed by hand. */
function quoteProblems(runDir: string, paper: string, qmd: string | undefined, embeds: EmbedSet): string[] {
  const problems: string[] = [];
  try {
    problems.push(...verifyQuotes(runDir, paper));
  } catch (error) {
    problems.push(`quotations cannot be checked: ${message(error)}`);
  }
  if (qmd === undefined) return problems;
  const found = locate(paper, "workspace/embeds/quotes");
  if (found.kind === "folder") {
    for (const entry of entriesOf(path.join(paper, "workspace", "embeds", "quotes"), "workspace/embeds/quotes", problems)) {
      if (!entry.isFile() || !/^Q\d+\.qmd$/.test(entry.name)) continue;
      if (!embeds.includes.includes(`embeds/quotes/${entry.name}`)) {
        problems.push(`workspace/embeds/quotes/${entry.name} is not included by paper.qmd`);
      }
    }
  }
  // A block quotation is one an include brings in: a line of prose that starts with `>` is typed by hand.
  const lines = proseLines(qmd);
  lines.forEach((line, index) => {
    if (/^\s*>/.test(line) && !(index > 0 && /^\s*>/.test(lines[index - 1] ?? ""))) {
      problems.push(`workspace/paper.qmd line ${index + 1}: a hand-typed block quotation; quote it with quote_source and include the fragment`);
    }
  });
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
    try {
      for (const problem of citations(path.join(paper, "workspace", "paper.qmd"))) problems.push(`workspace/paper.qmd: ${problem}`);
    } catch (error) {
      problems.push(`citation check for workspace/paper.qmd failed: ${message(error)}`);
    }
  }
  return problems;
}

/** The keys of the entries of a BibTeX file, `@type{key,`. */
function bibKeys(bib: string): Set<string> {
  return new Set([...bib.matchAll(/@\w+\s*[{(]\s*([^,\s})]+)\s*,/g)].map((match) => match[1] ?? ""));
}

// ---------------------------------------------------------------------------
// The Predictions, and the pins.

/** The Predictions fragment is included by the paper and is the argument's `## Predictions` section. */
function predictionProblems(paper: string, qmd: string | undefined, embeds: EmbedSet, argument: Read): string[] {
  const problems: string[] = [];
  if (argument.kind === "absent") problems.push("the explanation's workspace/argument.md is missing");
  else if (argument.kind === "refused") problems.push(argument.problem);
  if (qmd !== undefined && !embeds.includes.includes("embeds/predictions.qmd")) {
    problems.push("workspace/paper.qmd does not include embeds/predictions.qmd");
  }
  const fragment = readFile(paper, "workspace/embeds/predictions.qmd");
  if (fragment.kind === "absent") problems.push("workspace/embeds/predictions.qmd is missing");
  else if (fragment.kind === "refused") problems.push(fragment.problem);
  else if (argument.kind === "file") {
    const expected = sectionText(argument.bytes.toString("utf8"), "Predictions");
    if (fragment.bytes.toString("utf8").replace(/\r\n/g, "\n").trim() !== expected) {
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
function pinProblems(runDir: string, paper: string, explanation: string, explanationId: string, argument: Read): string[] {
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
// Bare numbers and the warnings.

/** The author placeholder in the front matter, as a warning. */
function authorWarnings(qmd: string): string[] {
  const front = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(qmd);
  return front?.[1]?.includes(AUTHOR_PLACEHOLDER)
    ? [`workspace/paper.qmd's author is still the placeholder "${AUTHOR_PLACEHOLDER}"`]
    : [];
}

const blank = (span: string): string => " ".repeat(span.length);

/**
 * The paper's prose lines for the bare-number detector: fenced code, front matter, comments and inline code are
 * already blank; here a block quotation, a shortcode (`{{< var >}}`, `{{< include >}}`), a citation bracket, an
 * attribute (`{#tbl-12}`) and a bare cross-reference are blanked too, so none of them counts.
 */
function numberProse(qmd: string): string[] {
  return proseLines(qmd).map((line) =>
    line
      .replace(/^\s*>.*$/, blank)
      .replace(/\{\{<[\s\S]*?>\}\}/g, blank)
      .replace(/\[[^\]]*@[^\]]*\]/g, blank)
      .replace(/\{#[^}]*\}/g, blank)
      .replace(/(?<![\w@.])-?@(?:fig|tbl|sec|eq)-[\w:.-]*/g, blank),
  );
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
