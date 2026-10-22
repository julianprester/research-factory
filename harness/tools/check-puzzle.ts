// Deterministic check of a Phase 2 puzzle node.
//
// A puzzle is a card, two independent reviews and their merge, and nothing
// else: Phase 2 runs no analysis, so any file under `workspace/scripts/` or
// `workspace/results/` is a finding. This tool checks the card (§4 of the
// Phase 2 design), the reviews, the citations, and the absence of analysis,
// and prints one problem per line:
//
//   - `workspace/puzzle.md` exists and carries the seven card headings, each
//     with a non-blank body and each only once;
//   - its header lines, in the preamble before the first `## ` section: `Lens:`
//     with text, `Round:` with an integer, and — for a node whose `node.json`
//     has `derivedFrom` — a `Derived from:` line naming exactly those ids
//     (order-insensitive) and a `Move:` of
//     `grounding|simplification|out-of-the-box|combination`. A plain puzzle
//     must not carry a `Derived from:` line, which would claim a parent it
//     does not have;
//   - `## Admissible explanations` names both readings Phase 3 needs: the
//     status-quo reading and an artifact/measurement reading, each matched
//     case-insensitively inside that section only;
//   - `check-citations` passes on the card (and, with `reviews: true`, on both
//     review files);
//   - with `reviews: true`: `workspace/reviews/a.md`, `b.md` and `merged.json`
//     exist, both reviews parse (see `merge-reviews.ts` for the format), and
//     `merged.json` is the merge of exactly those two reviews, so a merge left
//     behind by an edited review cannot carry stale flags past promotion.
//
// The card is written by a model, so the parser bends on formatting: a heading
// matches with its case, surrounding emphasis, a trailing colon and CRLF
// flattened; a header key matches when it is bold, in a list item or
// lower-cased. It is strict on presence and on position — a heading that is
// not there, a heading with nothing under it, and a header key buried in a
// section are all problems, never silences — because the judge and the
// reviewers are otherwise asked to read something that is not there.
//
// Fenced code is not card structure: a pasted template (``` or ~~~) must not
// satisfy a heading, a header line or a reading. Fenced lines are blanked
// before the card is read, which keeps their line positions intact.
//
// The citation check is the real `harness/tools/check-citations.ts` (one node
// process per file); it is injectable so tests never reach `deepis`.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { mergeReviews, parseReview, reviewProblems, type Review } from "./merge-reviews.ts";
import { findNode, findRunDir, listNodes, nodeIdOf, type NodeRef } from "../tree.ts";

/** The harness root (`harness/`): the citation tool is resolved from here, never from cwd. */
const HARNESS_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CHECK_CITATIONS = path.join(HARNESS_ROOT, "tools", "check-citations.ts");
/** A citation check hits `deepis`; a hung database must fail the tool, not hang it. */
const CITATION_TIMEOUT_MS = 5 * 60 * 1000;

const HEADINGS = [
  "## Pattern",
  "## Violated expectation",
  "## A case of",
  "## Why it matters",
  "## Admissible explanations",
  "## Limits",
  "## Literature log",
];
/** The four evolution moves; `out of the box` is the same move as `out-of-the-box`. */
const MOVE = /^(?:grounding|simplification|out[-_ ]of[-_ ]the[-_ ]box|combination)\b/i;
const STATUS_QUO = /status[-_\s]+quo/i;
const ARTIFACT = /artefact|artifact/i;

/**
 * `## findings`, `## FINDINGS`, `## Findings:`, `## **Findings**` are the same
 * heading: the text after the hashes is lower-cased with emphasis, a trailing
 * colon/full stop and stray whitespace removed. Same rule as `merge-reviews.ts`.
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

const HEADING_BY_NAME = new Map(HEADINGS.map((heading) => [normaliseHeading(heading), heading]));

/** Only an exact level-2 `## ` heading starts a section; `###` and deeper are body text. */
const SECTION_HEADING = /^##\s/;
/** An opening or closing fence: three or more backticks or tildes, indented at most three spaces. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * The card's lines with fenced code blanked out: a pasted template can hold
 * `## …` headings, a `Lens:` line and both readings, and none of that is this
 * card's structure. Blanking line by line (rather than cutting the text) keeps
 * every other line at its index, so a line number is still a line number.
 *
 * A fence closes on the same character, at least as long: `~~~` inside a
 * ``` block is content, not a closer. An unclosed fence runs to the end of
 * the file, as in CommonMark, and therefore fails closed (the card's headings
 * after it read as missing).
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

/** A card section: its body as written, the same body without fenced lines, and how often its heading appears. */
interface Section {
  raw: string;
  visible: string;
  count: number;
}

/**
 * The body of each known card section, keyed by its canonical heading. A
 * heading is found however it is formatted; an unknown `## …` section is
 * ignored, and the preamble before the first heading is never a section body.
 *
 * `raw` keeps fenced lines (a section that holds a template has content, and
 * saying it is empty would be noise); `visible` drops them (a reading inside a
 * fence is not a reading). A duplicated heading keeps both bodies, so the
 * content of either copy counts and the duplication is reported on its own.
 */
function sections(raw: string[], visible: string[]): Map<string, Section> {
  const found = new Map<string, Section>();
  let current: string | undefined;
  let rawBody: string[] = [];
  let visibleBody: string[] = [];
  const flush = (): void => {
    if (current === undefined) return;
    const seen = found.get(current);
    const text = { raw: rawBody.join("\n"), visible: visibleBody.join("\n") };
    if (seen === undefined) {
      found.set(current, { ...text, count: 1 });
    } else {
      seen.count += 1;
      seen.raw = `${seen.raw}\n${text.raw}`;
      seen.visible = `${seen.visible}\n${text.visible}`;
    }
  };
  for (let index = 0; index < visible.length; index++) {
    const line = visible[index] ?? "";
    if (SECTION_HEADING.test(line)) {
      flush();
      current = HEADING_BY_NAME.get(normaliseHeading(line));
      rawBody = [];
      visibleBody = [];
      continue;
    }
    if (current !== undefined) {
      rawBody.push(raw[index] ?? "");
      visibleBody.push(line);
    }
  }
  flush();
  return found;
}

/** True when the text holds nothing but blank lines. */
function isBlank(text: string): boolean {
  return text.split("\n").every((line) => line.trim().length === 0);
}

/** The card's lines before the first `## ` section: the only place a header line belongs. */
function preamble(lines: string[]): string[] {
  const end = lines.findIndex((line) => SECTION_HEADING.test(line));
  return end < 0 ? lines : lines.slice(0, end);
}

/**
 * The value of a `<key>:` header line in the card's preamble, or undefined
 * when there is none. Tolerates the formatting a model produces —
 * `**Lens:** status quo`, `- **Round:** 2`, `_Lens_ : x` — by allowing
 * emphasis and a list marker around the key and the colon, and matching the
 * key case-insensitively. Design §4 puts these lines "in its first lines", so
 * a `Lens:` buried in a section is not a header line.
 */
function headerValue(lines: string[], key: string): string | undefined {
  const pattern = new RegExp(`^[\\s>*_+-]*${key}[\\s*_]*:[\\s*_]*(.*)$`, "i");
  for (const raw of preamble(lines)) {
    const match = pattern.exec(raw.trim());
    if (match !== null) return (match[1] ?? "").trim();
  }
  return undefined;
}

/** The ids a puzzle names as its parents, upper-cased: a parent of a puzzle is a puzzle. */
function namedIds(value: string): string[] {
  const ids = (value.match(/P\d+/gi) ?? []).map((id) => id.toUpperCase());
  return [...new Set(ids)].sort();
}

/** Every file under `dir`, recursively; empty when the directory does not exist. */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(abs));
    else if (entry.isFile()) found.push(abs);
  }
  return found.sort();
}

/**
 * The problem lines of the citation check for one file: none when it passes
 * (exit 0), otherwise the check's own output (it reports on stderr). A check
 * that cannot run, or that runs past the timeout, is one problem line: a
 * missing citation check must never be read as a passing one.
 *
 * `command` and `timeoutMs` exist so tests can drive the runner without
 * `deepis`; production always uses `harness/tools/check-citations.ts`.
 */
export function citationProblems(
  file: string,
  opts: { command?: string; timeoutMs?: number } = {},
): string[] {
  const command = opts.command ?? CHECK_CITATIONS;
  const result = spawnSync(process.execPath, [command, file], {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? CITATION_TIMEOUT_MS,
  });
  const subject = command === CHECK_CITATIONS ? file : `${file} (${command})`;
  if (result.error !== undefined) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    const timeoutMs = opts.timeoutMs ?? CITATION_TIMEOUT_MS;
    const why = timedOut ? `timed out after ${timeoutMs} ms` : `could not run: ${result.error.message}`;
    return [`citation check for ${subject} failed: ${why}`];
  }
  if (result.status === 0) return [];
  // check-citations prints its findings on stderr; a usage error (exit 2) too.
  const text = (result.stderr ?? "").trim().length > 0 ? result.stderr : result.stdout;
  const lines = (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return [`citation check for ${subject} failed: exit ${result.status ?? "unknown"}`];
  return lines;
}

/**
 * Every problem with the puzzle node at `nodeDir` inside the run at `runDir`,
 * in a fixed order: the card's presence, its seven headings (each present,
 * once, with a body), its header lines (in the preamble), its derivation, its
 * admissible explanations, the card's citations, the analysis files Phase 2
 * must not have, and (with `reviews: true`) the two reviews, their citations
 * and the merge that must be theirs. An empty list means the puzzle may be
 * judged and promoted.
 *
 * Throws for a `nodeDir` that is not a node folder of `runDir`: that is a usage
 * error, not a finding about the research.
 *
 * `citations` replaces the citation runner entirely; `citationTimeoutMs` only
 * bounds the default one (the real `check-citations.ts`) and leaves the default
 * for every other caller alone, so a caller that must answer quickly (the
 * tournament's `promote`) can choose its own cap.
 */
export function checkPuzzle(
  runDir: string,
  nodeDir: string,
  opts: { reviews?: boolean; citations?: (file: string) => string[]; citationTimeoutMs?: number } = {},
): { problems: string[] } {
  const root = path.resolve(runDir);
  const node = path.resolve(nodeDir);
  const id = nodeIdOf(node);
  if (id === undefined) throw new Error(`${nodeDir} is not a node folder (expected <id>-<slug>)`);
  const relative = path.relative(root, node);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${nodeDir} is not inside the run at ${runDir}`);
  }

  const problems: string[] = [];
  const citations =
    opts.citations ??
    ((file: string): string[] => citationProblems(file, { timeoutMs: opts.citationTimeoutMs }));
  const card = path.join(node, "workspace", "puzzle.md");
  const nodeRef: NodeRef = findNode(root, id);
  const derivedFrom = (nodeRef.derivedFrom ?? []).map((parent) => parent.toUpperCase());
  const known = new Set(listNodes(root).map((candidate) => candidate.id));

  // 1. the card exists, and says everything the card has to say.
  if (!fs.existsSync(card)) {
    problems.push("workspace/puzzle.md is missing");
  } else {
    const markdown = fs.readFileSync(card, "utf8");
    const lines = maskFences(markdown);
    const found = sections(markdown.split(/\r?\n/), lines);
    for (const heading of HEADINGS) {
      if (!found.has(heading)) problems.push(`workspace/puzzle.md lacks the heading "${heading}"`);
    }
    for (const heading of HEADINGS) {
      const section = found.get(heading);
      if (section === undefined) continue;
      if (section.count > 1) problems.push(`workspace/puzzle.md has the heading "${heading}" twice`);
      if (isBlank(section.raw)) problems.push(`workspace/puzzle.md's "${heading}" section is empty`);
    }

    // 2. the lens and the round.
    const lens = headerValue(lines, "Lens");
    if (lens === undefined || lens.length === 0) problems.push('workspace/puzzle.md lacks a "Lens:" line');
    const round = headerValue(lines, "Round");
    if (round === undefined || round.length === 0) {
      problems.push('workspace/puzzle.md lacks a "Round: <integer>" line');
    } else {
      const value = (round.split(/\s+/)[0] ?? "").replace(/[:.,;]+$/, "");
      if (!/^\d+$/.test(value)) problems.push(`workspace/puzzle.md's "Round: ${round}" is not an integer`);
    }

    // 3. the derivation: an evolved puzzle names its parents and its move.
    const derivedLine = headerValue(lines, "Derived from");
    if (derivedFrom.length > 0) {
      const expected = [...derivedFrom].sort();
      const named = namedIds(derivedLine ?? "");
      if (derivedLine === undefined) {
        problems.push(`workspace/puzzle.md lacks a "Derived from:" line naming ${expected.join(", ")}`);
      } else if (named.join(", ") !== expected.join(", ")) {
        problems.push(
          `workspace/puzzle.md's "Derived from:" line names ${named.join(", ") || "no ids"}, not ${expected.join(", ")}`,
        );
      }
      const move = headerValue(lines, "Move");
      if (move === undefined || move.length === 0) {
        problems.push('workspace/puzzle.md lacks a "Move:" line (grounding, simplification, out-of-the-box or combination)');
      } else if (!MOVE.test(move)) {
        problems.push(
          `workspace/puzzle.md's "Move: ${move}" is not one of grounding, simplification, out-of-the-box, combination`,
        );
      }
    } else if (derivedLine !== undefined) {
      problems.push('workspace/puzzle.md has a "Derived from:" line but node.json has no derivedFrom');
    }

    // 4. both readings Phase 3 must be able to test, read from the card's own
    // prose (not a fenced template). A missing section is already reported above;
    // it is not also reported twice as two missing readings.
    const explanations = found.get("## Admissible explanations");
    if (explanations !== undefined) {
      if (!STATUS_QUO.test(explanations.visible)) {
        problems.push('workspace/puzzle.md\'s "## Admissible explanations" lacks a status-quo reading');
      }
      if (!ARTIFACT.test(explanations.visible)) {
        problems.push('workspace/puzzle.md\'s "## Admissible explanations" lacks an artifact reading');
      }
    }

    // 5. every citation in the card resolves (and every quote is in its chunk).
    for (const problem of citations(card)) problems.push(`workspace/puzzle.md: ${problem}`);
  }

  // 6. node.json's parents are real nodes (design §9); the card's own line is
  // checked above only when the card exists.
  for (const parent of derivedFrom) {
    if (!known.has(parent)) problems.push(`node.json's derivedFrom names ${parent}, which is not a node in this run`);
  }

  // 7. Phase 2 runs no analysis: its files would be evidence nothing read. A
  // `scripts`/`results` that is a plain file is a finding too, not a crash: the
  // rule is "no analysis", and a file there is analysis-shaped whatever it is.
  const workspace = path.join(node, "workspace");
  for (const relDir of ["scripts", "results"]) {
    const dir = path.join(workspace, relDir);
    if (!fs.existsSync(dir)) continue;
    if (!fs.statSync(dir).isDirectory()) {
      problems.push(`workspace/${relDir} exists: Phase 2 runs no analysis`);
      continue;
    }
    for (const file of filesUnder(dir)) {
      const name = path.relative(workspace, file).split(path.sep).join("/");
      problems.push(`workspace/${name} exists: Phase 2 runs no analysis`);
    }
  }

  // 8. the two independent reviews and the merge the owner reads. The merge must
  // be the merge of *these* two reviews: promotion reads its flags, so a merge
  // left behind by a review edited after it would carry flags nobody stands
  // behind.
  if (opts.reviews === true) {
    const reviewsDir = path.join(workspace, "reviews");
    const parsed: (Review | null)[] = [];
    for (const name of ["a.md", "b.md"] as const) {
      const file = path.join(reviewsDir, name);
      const shown = `workspace/reviews/${name}`;
      if (!fs.existsSync(file)) {
        problems.push(`${shown} is missing`);
        parsed.push(null);
        continue;
      }
      const review = fs.readFileSync(file, "utf8");
      const parsedReview = parseReview(review);
      parsed.push(parsedReview);
      if (parsedReview === null) {
        for (const problem of reviewProblems(review)) problems.push(`${shown}: ${problem}`);
      }
      for (const problem of citations(file)) problems.push(`${shown}: ${problem}`);
    }
    const mergedFile = path.join(reviewsDir, "merged.json");
    if (!fs.existsSync(mergedFile)) {
      problems.push("workspace/reviews/merged.json is missing");
    } else {
      let stored: unknown;
      let parses = true;
      try {
        stored = JSON.parse(fs.readFileSync(mergedFile, "utf8"));
      } catch {
        parses = false;
      }
      if (!parses) {
        problems.push("workspace/reviews/merged.json is not valid JSON");
      } else {
        const [reviewA, reviewB] = parsed;
        if (reviewA != null && reviewB != null) {
          const expected: unknown = JSON.parse(JSON.stringify(mergeReviews(reviewA, reviewB)));
          if (!isDeepStrictEqual(stored, expected)) {
            problems.push("workspace/reviews/merged.json does not match the reviews — re-run merge-reviews.ts");
          }
        }
      }
    }
  }

  return { problems };
}

function usage(message: string): number {
  console.error(`check-puzzle: ${message}`);
  console.error("usage: node harness/tools/check-puzzle.ts <nodeDir> [--reviews]");
  return 2;
}

function main(argv: string[]): number {
  const positional: string[] = [];
  let reviews = false;
  for (const arg of argv) {
    if (arg === "--reviews") reviews = true;
    else if (arg.startsWith("--")) return usage(`unknown option ${arg}`);
    else positional.push(arg);
  }
  const [nodeDirArg] = positional;
  if (nodeDirArg === undefined || positional.length > 1) return usage("expected a puzzle node directory");

  const nodeDir = path.resolve(nodeDirArg);
  if (!fs.existsSync(nodeDir) || !fs.statSync(nodeDir).isDirectory()) return usage(`${nodeDirArg} is not a directory`);
  const runDir = findRunDir(nodeDir);
  if (runDir === undefined) return usage(`no .git repository above ${nodeDirArg}`);

  let problems: string[];
  try {
    problems = checkPuzzle(runDir, nodeDir, { reviews }).problems;
  } catch (error) {
    return usage((error as Error).message);
  }
  if (problems.length === 0) {
    console.log("ok");
    return 0;
  }
  for (const problem of problems) console.log(problem);
  return 1;
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
