// Deterministic code checks of an explanation node's argument (§10 item 1 of the
// Phase 3 design): the gate `submit` runs before the reproduction and the review.
//
// The argument is written by a model, so the parser bends on formatting (a
// heading matches with its case, emphasis and a trailing colon flattened; the
// `Contribution:` and `Round:` keys match when bold, in a list item or
// lower-cased) and is strict on presence: a heading that is not there, an
// empty Alternatives considered section and a link that does not resolve are
// problems, never silences. Fenced code is not prose: its lines are blanked
// before headings, links, bare numerals and the Alternatives section are read,
// as in `check-puzzle.ts`.
//
// Everything under `workspace/output/` and `workspace/archive/` is written by
// scripts and workers, so every host-side read is walked without following a
// link: a link, or a file that is not regular where a folder belongs, is a
// problem named by its path, never read through. A link in `argument.md` is
// resolved against `workspace/`, normalised, and must stay inside it; a link
// into `archive/` is a problem. A registry link `output/numbers/<f>.csv#<key>`
// must name a file directly in `output/numbers/`, and its key must be present
// exactly once.
//
// The problems, in order: `argument.md` missing (or not a regular file), a
// heading or `Contribution:` line missing, an empty `## Alternatives
// considered`, each link that does not resolve, each registry link whose key is
// absent or repeated, each file in `workspace/scripts/` not named as a script,
// the assets pair (`_variables.yml`, `variables_sources.csv`) missing or
// inconsistent, each report without its `Round:` line or a heading, each
// citation problem on `argument.md` and each report, and with `report: true` the
// review report (`reviews/report.md`) missing, malformed, not opening each check
// with `Result:`, or failing its citations. The code does not judge the content
// of any section: one sentence is an alternative.
//
// Warnings: a bare number (two or more digits, or a decimal) in `argument.md`'s
// prose, outside link text, inline code, headings and URLs, and not a four-digit
// year between 1900 and 2100. A bare number is a softer finding: the code cannot
// tell a result from a count or a year.
//
// The review report's format (Task 10's reviewer role teaches it):
//
//   ## Citation fidelity / ## Number provenance / ## Overclaiming /
//   ## Abductive honesty                     first line `Result: ok|concerns`
//   ## Findings                              lines `- [F<n>] [blocking|major|minor] <section>: <text>`
//   last line                                `Status: DONE|DONE_WITH_CONCERNS|BLOCKED`
//
// `checkRevision` checks the owner's revision: a line per finding, `F<n>: taken
// — <what changed>` or `F<n>: overruled — <reason>`.
//
// CLI: `node harness/tools/check-argument.ts <nodeDir> [--report]` prints
// `warning: …` lines, then `ok` (exit 0) or one problem per line (exit 1). Usage
// errors exit 2, as in `check-puzzle.ts`.
import * as fs from "node:fs";
import * as path from "node:path";

import { parseCsv, readRegistry, type Row } from "../explain/reproduce.ts";
import { findRunDir } from "../tree.ts";
import { citationProblems } from "./check-puzzle.ts";

const ARGUMENT_HEADINGS = [
  "## Explanation",
  "## Mechanism and scope",
  "## What would count against it",
  "## Alternatives considered",
  "## Evidence",
  "## Limitations",
  "## Predictions",
];
const REPORT_HEADINGS = [
  "## What the results are",
  "## Literature on these results",
  "## Rival and artifact accounts",
  "## What else should be true",
  "## Measurement precedents",
  "## Implications for the argument",
];
const REVIEW_HEADINGS = ["## Citation fidelity", "## Number provenance", "## Overclaiming", "## Abductive honesty", "## Findings"];
/** The four check sections, each of which opens with a `Result:` line. */
const CHECK_HEADINGS = REVIEW_HEADINGS.slice(0, 4);

/** The analysis script names runScript accepts (as reproduce.ts): `X_nn.R|py` or `assets.R|py`. */
const SCRIPT_NAME = /^(?:[A-Z]_\d\d|assets)\.(?:R|py)$/;
const SECTION_HEADING = /^##\s/;
/** An opening or closing fence: three or more backticks or tildes, indented at most three spaces. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
/** A markdown link `[text](target)` with an optional title; the target has no spaces. */
const LINK = /\[([^\]]*)\]\(\s*([^)\s]*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
/** A registry source `output/numbers/<file>.csv#<key>`: the file is directly in numbers/. */
const REGISTRY_SOURCE = /^output\/numbers\/([^/#]+\.csv)#(.*)$/;
const YAML_VARIABLE = /^([A-Za-z_][A-Za-z0-9_]*): ".*"$/;
const FINDING = /^[-*+]\s+\[(F\d+)\]\s+\[(blocking|major|minor)\]\s+([^:]+?):\s+(\S.*)$/;
const STATUS = /^Status:\s*(DONE_WITH_CONCERNS|DONE|BLOCKED)\s*$/;
const RULING = /^\s*(?:[-*+]\s+)?(F\d+):\s*(taken|overruled)\b\s*(?:[—–-]\s*)?(.*)$/i;
const RESULT = /^Result:\s*(ok|concerns)\b/i;
/** A bare number: a decimal, or two or more digits (with thousands separators), not part of a word or identifier. */
const BARE_NUMBER = /(?<![\w.])(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\.\d+|\d{2,})(?!\w)/g;

export interface ReportFinding {
  id: string;
  severity: string;
  section: string;
  text: string;
}

/**
 * A markdown report's findings and closing status, or null when it is malformed:
 * a check heading missing, a finding line that is not a finding (so no finding
 * is dropped silently), or a `Status:` line that is missing, invalid or not last.
 */
export function parseReport(markdown: string): { findings: ReportFinding[]; status: string } | null {
  const lines = maskFences(markdown);
  let last = lines.length - 1;
  while (last >= 0 && (lines[last] ?? "").trim() === "") last--;
  const closing = last < 0 ? null : STATUS.exec((lines[last] ?? "").trim());
  if (closing === null) return null;
  const sections = sectionsOf(lines.slice(0, last), REVIEW_HEADINGS);
  for (const heading of REVIEW_HEADINGS) {
    if (!sections.has(heading)) return null;
  }
  const findings: ReportFinding[] = [];
  for (const line of sections.get("## Findings") ?? []) {
    const trimmed = line.trim();
    if (trimmed === "" || /^None\.?$/i.test(trimmed)) continue;
    const finding = FINDING.exec(trimmed);
    if (finding !== null) {
      findings.push({
        id: finding[1] ?? "",
        severity: finding[2] ?? "",
        section: (finding[3] ?? "").trim(),
        text: (finding[4] ?? "").trim(),
      });
      continue;
    }
    const previous = findings[findings.length - 1];
    if (/^\s/.test(line) && previous !== undefined) {
      previous.text = `${previous.text} ${trimmed}`;
      continue;
    }
    return null;
  }
  return { findings, status: closing[1] ?? "" };
}

/**
 * The problems with the owner's revision of a review: a finding with no
 * `F<n>: taken|overruled` line, and an overruled line with no reason. A taken
 * line may say nothing more: the change is in the argument, not in this line.
 */
export function checkRevision(findings: { id: string }[], revision: string): string[] {
  const problems: string[] = [];
  const ruled = new Set<string>();
  for (const line of revision.split(/\r?\n/)) {
    const ruling = RULING.exec(line);
    if (ruling === null) continue;
    const id = (ruling[1] ?? "").toUpperCase();
    ruled.add(id);
    if ((ruling[2] ?? "").toLowerCase() === "overruled" && (ruling[3] ?? "").trim() === "") {
      problems.push(`revision.md: ${id} is overruled with no reason`);
    }
  }
  for (const finding of findings) {
    if (!ruled.has(finding.id)) problems.push(`revision.md has no ruling for ${finding.id}`);
  }
  return problems;
}

/** Every markdown link `[text](target)` in `argument.md`, in order; fenced and inline code are not links. */
export function argumentLinks(markdown: string): { text: string; target: string }[] {
  const links: { text: string; target: string }[] = [];
  for (const line of maskFences(markdown)) {
    for (const match of withoutInlineCode(line).matchAll(LINK)) {
      links.push({ text: match[1] ?? "", target: (match[2] ?? "").trim() });
    }
  }
  return links;
}

/**
 * Checks the argument node at `nodeDir` inside the run at `runDir`. `citations`
 * replaces the citation runner (the real `check-citations.ts`, one node process
 * per file); `report: true` also requires `reviews/report.md`. Throws for a
 * `nodeDir` that is not inside the run: a usage error, not a finding.
 */
export function checkArgument(
  runDir: string,
  nodeDir: string,
  opts: { citations?: (file: string) => string[]; report?: boolean } = {},
): { problems: string[]; warnings: string[] } {
  const root = path.resolve(runDir);
  const node = path.resolve(nodeDir);
  const relative = path.relative(root, node);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${nodeDir} is not a node folder inside the run at ${runDir}`);
  }
  const citations = opts.citations ?? ((file: string): string[] => citationProblems(file));
  const problems: string[] = [];
  const warnings: string[] = [];

  // 1. argument.md: its headings, its contribution line, its alternatives, its bare numerals.
  const argument = readText(node, "workspace/argument.md");
  if (argument.kind === "absent") problems.push("workspace/argument.md is missing");
  if (argument.kind === "refused") problems.push(argument.problem);
  if (argument.kind === "text") {
    const lines = maskFences(argument.text);
    const sections = sectionsOf(lines, ARGUMENT_HEADINGS);
    for (const heading of ARGUMENT_HEADINGS) {
      if (!sections.has(heading)) problems.push(`workspace/argument.md lacks the heading "${heading}"`);
    }
    const kind = (headerValue(lines, "Contribution") ?? "").replace(/[*_`.\s]+$/, "").toLowerCase();
    if (kind !== "theoretical" && kind !== "pattern") {
      problems.push('workspace/argument.md lacks a "Contribution: theoretical|pattern" line');
    }
    const alternatives = sections.get("## Alternatives considered");
    if (alternatives !== undefined && alternatives.every((line) => line.trim() === "")) {
      problems.push('workspace/argument.md\'s "## Alternatives considered" section is empty');
    }
    warnings.push(...bareNumbers(lines));
  }

  // 2. the registry, read once: a malformed or linked registry is named, and its key checks are skipped.
  const registry = loadRegistry(node, problems);

  // 3. every link in argument.md.
  if (argument.kind === "text") {
    for (const { text, target } of argumentLinks(argument.text)) {
      const problem = linkProblem(node, text, target, registry);
      if (problem !== undefined) problems.push(problem);
    }
  }

  // 4. the scripts: only the analysis script names, no helper, nested or linked file.
  const scripts = locate(node, "workspace/scripts");
  if (scripts.kind === "refused") problems.push(scripts.problem);
  if (scripts.kind === "file") problems.push("workspace/scripts is not a folder");
  if (scripts.kind === "folder") problems.push(...scriptProblems(scripts.dir, ""));

  // 5. the assets the manuscript reads: every variable has a source row that resolves once.
  problems.push(...variableProblems(node, registry));

  // 6. the literature reports: one round line and every heading each.
  const reportTexts: { shown: string; file: string; text: string }[] = [];
  for (const name of reportNames(node, problems)) {
    const shown = `workspace/reports/${name}`;
    const read = readText(node, shown);
    if (read.kind === "absent") problems.push(`${shown} is missing`);
    if (read.kind === "refused") problems.push(read.problem);
    if (read.kind === "text") reportTexts.push({ shown, file: read.file, text: read.text });
  }
  for (const report of reportTexts) problems.push(...reportProblems(report.shown, report.text));

  // 7. the citations on the argument and on every report.
  if (argument.kind === "text") {
    for (const problem of citations(argument.file)) problems.push(`workspace/argument.md: ${problem}`);
  }
  for (const report of reportTexts) {
    for (const problem of citations(report.file)) problems.push(`${report.shown}: ${problem}`);
  }

  // 8. the review report, when the owner asks for it.
  if (opts.report === true) problems.push(...reviewProblems(node, citations));

  return { problems: [...new Set(problems)], warnings };
}

// ---------------------------------------------------------------------------
// Reading the node without following a link.

type Found =
  | { kind: "absent" }
  | { kind: "refused"; problem: string }
  | { kind: "file"; file: string }
  | { kind: "folder"; dir: string };

type Text = { kind: "absent" } | { kind: "refused"; problem: string } | { kind: "text"; file: string; text: string };

/**
 * What is at `rel` (a `/`-separated path under the node), walking each step with
 * `lstat`. A link on the way, or a file where a folder belongs, is refused by the
 * path that is wrong; a missing step is absent. The node itself is trusted.
 */
function locate(node: string, rel: string): Found {
  const parts = rel.split("/");
  let current = node;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const shown = parts.slice(0, index + 1).join("/");
    const stat = lstatIfPresent(current);
    if (stat === undefined) return { kind: "absent" };
    if (stat.isSymbolicLink()) return { kind: "refused", problem: `${shown} is a link: refusing to read it` };
    if (index < parts.length - 1) {
      if (!stat.isDirectory()) return { kind: "refused", problem: `${shown} is not a folder` };
      continue;
    }
    if (stat.isFile()) return { kind: "file", file: current };
    if (stat.isDirectory()) return { kind: "folder", dir: current };
    return { kind: "refused", problem: `${shown} is not a regular file or folder` };
  }
  return { kind: "folder", dir: current };
}

/** The text of the file at `rel`; a folder where a file belongs is refused by name. */
function readText(node: string, rel: string): Text {
  const found = locate(node, rel);
  if (found.kind === "absent") return { kind: "absent" };
  if (found.kind === "refused") return { kind: "refused", problem: found.problem };
  if (found.kind === "folder") return { kind: "refused", problem: `${rel} is not a regular file` };
  try {
    return { kind: "text", file: found.file, text: readRegularFile(found.file) };
  } catch (error) {
    return { kind: "refused", problem: `${rel} could not be read: ${(error as Error).message}` };
  }
}

/** A regular file's text, opened without following a link on the last component. */
function readRegularFile(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${file} is not a regular file`);
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function lstatIfPresent(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/**
 * The registry under `workspace/output/`, or undefined when it cannot be read
 * (the problem is pushed). A missing registry is empty; a malformed one, or a
 * link on its path, is named.
 */
function loadRegistry(node: string, problems: string[]): Record<string, Row[]> | undefined {
  const numbers = locate(node, "workspace/output/numbers");
  if (numbers.kind === "absent") return {};
  if (numbers.kind === "refused") {
    problems.push(numbers.problem);
    return undefined;
  }
  if (numbers.kind === "file") {
    problems.push("workspace/output/numbers is not a folder");
    return undefined;
  }
  try {
    return readRegistry(path.join(node, "workspace", "output"));
  } catch (error) {
    const message = (error as Error).message;
    problems.push(message.startsWith("numbers/") ? `workspace/output/${message}` : `workspace/output: ${message}`);
    return undefined;
  }
}

/** The number of rows named `key` in the registry file `name`. */
function rowsNamed(registry: Record<string, Row[]>, name: string, key: string): number {
  return (registry[name] ?? []).filter((row) => row.name === key).length;
}

// ---------------------------------------------------------------------------
// Links, scripts and variables.

/** The problem with one markdown link in argument.md, or undefined when it resolves. */
function linkProblem(
  node: string,
  text: string,
  target: string,
  registry: Record<string, Row[]> | undefined,
): string | undefined {
  if (target === "") return `workspace/argument.md has a link with no target: [${text}]()`;
  // A web link is not a file link.
  if (/^https?:\/\//i.test(target)) return undefined;
  if (target.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return `workspace/argument.md link is not a relative file path: ${target}`;
  }
  const hash = target.indexOf("#");
  const filePart = hash < 0 ? target : target.slice(0, hash);
  const key = hash < 0 ? undefined : target.slice(hash + 1);
  // An anchor within argument.md has no file to resolve.
  if (filePart === "") return undefined;
  if (filePart.startsWith("/")) return `workspace/argument.md link is an absolute path: ${target}`;
  const rel = path.posix.normalize(filePart);
  if (rel === ".." || rel.startsWith("../")) return `workspace/argument.md link leaves workspace/: ${target}`;
  if (rel === "archive" || rel.startsWith("archive/")) return `workspace/argument.md links into archive/: ${target}`;

  const found = locate(node, `workspace/${rel}`);
  if (found.kind === "refused") return found.problem;
  if (found.kind === "absent") return `workspace/argument.md links to a missing file: ${rel}`;
  if (found.kind === "folder" && rel.endsWith(".csv")) return `workspace/${rel} is not a regular file`;
  if (key === undefined || !rel.endsWith(".csv")) return undefined;

  const source = `${rel}#${key}`;
  const match = REGISTRY_SOURCE.exec(source);
  if (match === null) {
    return `workspace/argument.md's link ${target} must name a file directly in workspace/output/numbers/`;
  }
  // The registry was unreadable and its problem is already named.
  if (registry === undefined) return undefined;
  const count = rowsNamed(registry, match[1] ?? "", match[2] ?? "");
  if (count === 0) return `workspace/argument.md's link ${target} names no row "${key}" in ${match[1]}`;
  if (count > 1) return `workspace/argument.md's link ${target} names "${key}", which appears ${count} times in ${match[1]}`;
  return undefined;
}

/** Every file under `workspace/scripts/` (recursively) that is not a script name, a link or a regular file. */
function scriptProblems(dir: string, prefix: string): string[] {
  const problems: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const shown = `workspace/scripts/${rel}`;
    if (entry.isSymbolicLink()) problems.push(`${shown} is a link: refusing to read it`);
    else if (entry.isDirectory()) problems.push(...scriptProblems(path.join(dir, entry.name), rel));
    else if (!entry.isFile()) problems.push(`${shown} is not a regular file`);
    else if (!SCRIPT_NAME.test(rel)) problems.push(`${shown} is not a script name (X_nn.R, X_nn.py, assets.R or assets.py)`);
  }
  return problems;
}

/**
 * The assets pair: every variable in `_variables.yml` has a row in
 * `variables_sources.csv` whose source resolves to exactly one registry row. A
 * missing or unreadable file is a problem and skips the rest; with the registry
 * unreadable the source is not checked (its problem is already named).
 */
function variableProblems(node: string, registry: Record<string, Row[]> | undefined): string[] {
  const ymlFile = "workspace/output/assets/_variables.yml";
  const csvFile = "workspace/output/assets/variables_sources.csv";
  const yml = readText(node, ymlFile);
  const csv = readText(node, csvFile);
  const problems: string[] = [];
  for (const [found, shown] of [
    [yml, ymlFile],
    [csv, csvFile],
  ] as const) {
    if (found.kind === "absent") problems.push(`${shown} is missing`);
    if (found.kind === "refused") problems.push(found.problem);
  }
  if (yml.kind !== "text" || csv.kind !== "text") return problems;

  const names: string[] = [];
  yml.text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === "") return;
    const match = YAML_VARIABLE.exec(line);
    if (match === null) problems.push(`${ymlFile} line ${index + 1} is not a 'name: "value"' line`);
    else names.push(match[1] ?? "");
  });

  let rows: string[][];
  try {
    rows = parseCsv(csv.text);
  } catch (error) {
    return [...problems, `${csvFile}: ${(error as Error).message}`];
  }
  const [header = [], ...body] = rows;
  const variableAt = header.indexOf("variable");
  const sourceAt = header.indexOf("source");
  if (variableAt === -1 || sourceAt === -1) return [...problems, `${csvFile} has no variable and source columns`];
  const records = body
    .filter((fields) => !(fields.length === 1 && fields[0] === ""))
    .map((fields) => ({ variable: fields[variableAt] ?? "", source: fields[sourceAt] ?? "" }));

  for (const name of names) {
    const own = records.filter((record) => record.variable === name);
    if (own.length === 0) {
      problems.push(`variable ${name} has no row in ${csvFile}`);
    } else if (registry !== undefined && !own.some((record) => resolvesOnce(record.source, registry))) {
      problems.push(`variable ${name} has no row whose source resolves to exactly one registry row`);
    }
  }
  return problems;
}

function resolvesOnce(source: string, registry: Record<string, Row[]>): boolean {
  const match = REGISTRY_SOURCE.exec(source);
  return match !== null && rowsNamed(registry, match[1] ?? "", match[2] ?? "") === 1;
}

/** The `.md` files directly in `workspace/reports/`; a link or a non-file there is a problem. */
function reportNames(node: string, problems: string[]): string[] {
  const reports = locate(node, "workspace/reports");
  if (reports.kind === "refused") {
    problems.push(reports.problem);
    return [];
  }
  if (reports.kind === "file") {
    problems.push("workspace/reports is not a folder");
    return [];
  }
  if (reports.kind === "absent") return [];
  const names: string[] = [];
  for (const entry of fs.readdirSync(reports.dir, { withFileTypes: true }).sort(byName)) {
    const shown = `workspace/reports/${entry.name}`;
    if (entry.isSymbolicLink()) problems.push(`${shown} is a link: refusing to read it`);
    else if (!entry.isFile()) problems.push(`${shown} is not a regular file`);
    else if (entry.name.endsWith(".md")) names.push(entry.name);
  }
  return names;
}

/** A literature report's structure: its `Round:` line (an integer) and every heading. */
function reportProblems(shown: string, text: string): string[] {
  const problems: string[] = [];
  const lines = maskFences(text);
  const round = headerValue(lines, "Round");
  if (round === undefined || round === "") {
    problems.push(`${shown} lacks a "Round: N" line`);
  } else if (!/^\d+$/.test((round.split(/\s+/)[0] ?? "").replace(/[:.,;]+$/, ""))) {
    problems.push(`${shown}'s "Round: ${round}" is not an integer`);
  }
  const sections = sectionsOf(lines, REPORT_HEADINGS);
  for (const heading of REPORT_HEADINGS) {
    if (!sections.has(heading)) problems.push(`${shown} lacks the heading "${heading}"`);
  }
  return problems;
}

/** The review report: present, parseable, each check opening with a `Result:` line, and its citations. */
function reviewProblems(node: string, citations: (file: string) => string[]): string[] {
  const shown = "workspace/reviews/report.md";
  const read = readText(node, shown);
  if (read.kind === "absent") return [`${shown} is missing`];
  if (read.kind === "refused") return [read.problem];
  const problems: string[] = [];
  const sections = sectionsOf(maskFences(read.text), REVIEW_HEADINGS);
  for (const heading of CHECK_HEADINGS) {
    const body = sections.get(heading);
    if (body === undefined) continue;
    const first = body.find((line) => line.trim() !== "");
    if (first === undefined || !RESULT.test(first.trim().replace(/[*_`]/g, ""))) {
      problems.push(`${shown}'s "${heading}" does not open with "Result: ok|concerns"`);
    }
  }
  if (parseReport(read.text) === null) {
    problems.push(`${shown} is malformed (the check headings, ## Findings lines, and a last line "Status: …" are required)`);
  }
  for (const problem of citations(read.file)) problems.push(`${shown}: ${problem}`);
  return problems;
}

// ---------------------------------------------------------------------------
// Markdown helpers.

/** Bare numerals in argument.md's prose (see the header for what is not prose). */
function bareNumbers(lines: string[]): string[] {
  const warnings: string[] = [];
  lines.forEach((raw, index) => {
    if (/^\s*#{1,6}\s/.test(raw)) return;
    const prose = withoutInlineCode(raw)
      .replace(LINK, " ")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, " ");
    for (const match of prose.matchAll(BARE_NUMBER)) {
      const token = match[0];
      if (/^\d{4}$/.test(token) && Number(token) >= 1900 && Number(token) <= 2100) continue;
      warnings.push(`workspace/argument.md line ${index + 1}: bare number ${token}`);
    }
  });
  return warnings;
}

function withoutInlineCode(line: string): string {
  return line.replace(/`+[^`]*`+/g, " ");
}

/**
 * The lines with fenced code blanked, keeping every other line at its index, so
 * a line number is still a line number. A fence closes on the same character, at
 * least as long; an unclosed fence runs to the end of the file, and therefore
 * fails closed (the headings after it read as missing).
 */
function maskFences(markdown: string): string[] {
  const masked: string[] = [];
  let open: { char: string; length: number } | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = FENCE.exec(line)?.[1];
    if (open === undefined) {
      if (marker === undefined) {
        masked.push(line);
        continue;
      }
      open = { char: marker.charAt(0), length: marker.length };
      masked.push("");
      continue;
    }
    if (marker !== undefined && marker.charAt(0) === open.char && marker.length >= open.length) open = undefined;
    masked.push("");
  }
  return masked;
}

/**
 * `## findings`, `## FINDINGS`, `## Findings:` and `## **Findings**` are the same
 * heading: the text after the hashes is lower-cased with emphasis, a trailing
 * colon or full stop and stray whitespace removed (as `check-puzzle.ts`).
 */
function normaliseHeading(text: string): string {
  let body = text.replace(/^##\s+/, "");
  let previous: string;
  do {
    previous = body;
    body = body
      .replace(/^[*_`\s]+/, "")
      .replace(/[*_`\s]+$/, "")
      .replace(/[:.,;!?]+\s*$/, "")
      .trim();
  } while (body !== previous);
  return body.toLowerCase().replace(/\s+/g, " ");
}

/** The body lines of each known section, by canonical heading; a repeated heading keeps both bodies. Unknown sections are ignored. */
function sectionsOf(lines: string[], headings: string[]): Map<string, string[]> {
  const byName = new Map(headings.map((heading) => [normaliseHeading(heading), heading] as const));
  const found = new Map<string, string[]>();
  let current: string | undefined;
  for (const line of lines) {
    if (SECTION_HEADING.test(line)) {
      current = byName.get(normaliseHeading(line));
      if (current !== undefined && !found.has(current)) found.set(current, []);
      continue;
    }
    if (current !== undefined) found.get(current)?.push(line);
  }
  return found;
}

/** The value of a `<key>:` line in the preamble (before the first `## ` section), or undefined. */
function headerValue(lines: string[], key: string): string | undefined {
  const end = lines.findIndex((line) => SECTION_HEADING.test(line));
  const preamble = end < 0 ? lines : lines.slice(0, end);
  const pattern = new RegExp(`^[\\s>*_+-]*${key}[\\s*_]*:[\\s*_]*(.*)$`, "i");
  for (const raw of preamble) {
    const match = pattern.exec(raw.trim());
    if (match !== null) return (match[1] ?? "").trim();
  }
  return undefined;
}

function byName(a: fs.Dirent, b: fs.Dirent): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// ---------------------------------------------------------------------------
// CLI.

function usage(message: string): number {
  console.error(`check-argument: ${message}`);
  console.error("usage: node harness/tools/check-argument.ts <nodeDir> [--report]");
  return 2;
}

function main(argv: string[]): number {
  const positional: string[] = [];
  let report = false;
  for (const arg of argv) {
    if (arg === "--report") report = true;
    else if (arg.startsWith("--")) return usage(`unknown option ${arg}`);
    else positional.push(arg);
  }
  const [nodeDirArg] = positional;
  if (nodeDirArg === undefined || positional.length > 1) return usage("expected an explanation node directory");

  const nodeDir = path.resolve(nodeDirArg);
  if (!fs.existsSync(nodeDir) || !fs.statSync(nodeDir).isDirectory()) return usage(`${nodeDirArg} is not a directory`);
  const runDir = findRunDir(nodeDir);
  if (runDir === undefined) return usage(`no .git repository above ${nodeDirArg}`);

  let result: { problems: string[]; warnings: string[] };
  try {
    result = checkArgument(runDir, nodeDir, { report });
  } catch (error) {
    return usage((error as Error).message);
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
  process.exitCode = main(process.argv.slice(2));
}
