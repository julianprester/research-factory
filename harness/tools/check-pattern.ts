// Deterministic check of a Phase 1 pattern node.
//
// The pattern method only means something if the measure was fixed before the
// results were seen, and if nothing read the hold-out. This tool checks a node's
// git history and its card, and prints one problem per line:
//
//   - `workspace/measure.md` exists and has a `[P1:preregister] <id>` commit;
//   - that commit's tree holds no measurement file yet (nothing under
//     `workspace/scripts/` or `workspace/results/`, no `workspace/pattern.md`),
//     so a measure registered after the measuring began is caught: the worker
//     tool refuses such a call, but a swept `git add -A` can still hide one;
//   - the current `measure.md` is byte-for-byte the version at that marker
//     commit (`git show <marker>:<path>`), so a later edit is caught even when
//     the edit was committed separately;
//   - the first commit carrying `workspace/pattern.md` comes after the marker,
//     compared through git ancestry (`merge-base --is-ancestor`), never through
//     timestamps;
//   - `workspace/pattern.md` has the six card headings;
//   - `handoff.md` line 3 is `Verdict: <verdict>`, with `open` only for a blind
//     scanner, and it agrees with `pattern.md`'s `## Verdict` first line;
//   - no file under `workspace/scripts/` mentions the hold-out (case-insensitive,
//     `hold[-_ ]?out`).
//
// The marker commit is found by subject, not by the paths it touched: when a
// tree operation's `git add -A` has already swept `measure.md` into an earlier
// commit, the pre-registration commit is empty, and `git log -- <path>` would
// not list it.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { HOLDOUT_WORD } from "../guard.ts";
import { findRunDir, MEASUREMENT_PATHS, nodeIdOf, preregisterCommits, type Preregistration } from "../tree.ts";

const HEADINGS = ["## Measure", "## Result", "## Verdict", "## Robustness", "## Worst fits", "## Deviations"];
const VERDICTS = ["held", "violated", "mixed", "unmeasurable"];
/** A blind scanner may also report `open`; nobody else may. */
const BLIND_VERDICTS = [...VERDICTS, "open"];
const HOLDOUT = HOLDOUT_WORD;
/**
 * Calls that list a directory or walk a tree. A scan reads the exploration list; a
 * script that enumerates the dataset sees the names of hold-out files too, so it must
 * say so in `measure.md` (an `Enumerates:` line, frozen at pre-registration).
 */
const ENUMERATES_CALL = /os\.walk|os\.listdir|os\.scandir|\.iterdir\(|\.r?glob\(|glob\.i?glob|globSync|readdirSync|readdir\(|opendir|scandir/;
const ENUMERATES_DECLARATION = /^\W*Enumerates:\s*\S/im;

function gitText(runDir: string, args: string[]): string {
  return execFileSync("git", [...args], { cwd: runDir, encoding: "utf8" });
}

function gitLines(runDir: string, args: string[]): string[] {
  return gitText(runDir, args)
    .split("\n")
    .filter((line) => line.length > 0);
}

/** `git show <sha>:<path>`, or undefined when that commit does not hold the path. */
function showAtCommit(runDir: string, sha: string, relPath: string): string | undefined {
  try {
    return gitText(runDir, ["show", `${sha}:${relPath}`]);
  } catch {
    return undefined;
  }
}

/** True when `ancestor` is reachable from `descendant` (and they differ). */
function isStrictAncestor(runDir: string, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return false;
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: runDir });
  return result.status === 0;
}

/** The first non-empty line of the section that `heading` opens. */
function sectionFirstLine(markdown: string, heading: string): string | undefined {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start < 0) return undefined;
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) return undefined; // the section is empty
    return trimmed;
  }
  return undefined;
}

function hasHeading(markdown: string, heading: string): boolean {
  return markdown.split("\n").some((line) => line.trimEnd() === heading);
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
 * Every problem with the pattern node at `nodeDir` inside the run at `runDir`,
 * in a fixed order: pre-registration, card order, card headings, handoff
 * verdict, and the hold-out. An empty list means the card may be judged.
 *
 * Throws for a `nodeDir` that is not a node folder or not inside `runDir`: that
 * is a usage error, not a finding about the research.
 */
export function checkPattern(
  runDir: string,
  nodeDir: string,
  opts: { blind?: boolean } = {},
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
  const rel = (abs: string): string => path.relative(root, abs).split(path.sep).join("/");

  const measure = path.join(node, "workspace", "measure.md");
  const pattern = path.join(node, "workspace", "pattern.md");
  const handoff = path.join(node, "handoff.md");

  const markers: Preregistration[] = preregisterCommits(root, id);
  const marker = markers[0]; // oldest: the original pre-registration

  // 1. measure.md is pre-registered and unchanged.
  if (!fs.existsSync(measure)) {
    problems.push("workspace/measure.md is missing");
  } else if (marker === undefined) {
    problems.push(`no [P1:preregister] ${id} commit for workspace/measure.md`);
  } else {
    const registered = showAtCommit(root, marker.sha, rel(measure));
    if (registered === undefined) {
      problems.push(`workspace/measure.md is not in the pre-registration commit ${marker.short}`);
    } else if (registered !== fs.readFileSync(measure, "utf8")) {
      problems.push(`workspace/measure.md changed after pre-registration at ${marker.short}`);
    }
  }

  // 2. no measurement file was already in the tree when the measure was registered.
  if (marker !== undefined) {
    const nodeRel = rel(node);
    const registered = gitLines(root, [
      "ls-tree",
      "-r",
      "--name-only",
      marker.sha,
      "--",
      ...MEASUREMENT_PATHS.map((relPath) => `${nodeRel}/${relPath}`),
    ]).map((file) => file.slice(nodeRel.length + 1));
    if (registered.length > 0) {
      problems.push(`measurement files existed at pre-registration: ${registered.join(", ")}`);
    }
  }

  // 3. the card was committed after the pre-registration (when committed at all).
  const patternRel = rel(pattern);
  const firstPattern = gitLines(root, ["log", "--format=%H", "--", patternRel]).at(-1);
  if (marker !== undefined && firstPattern !== undefined && !isStrictAncestor(root, marker.sha, firstPattern)) {
    problems.push(
      `workspace/pattern.md's first commit ${firstPattern.slice(0, 7)} is not after pre-registration at ${marker.short}`,
    );
  }

  // 4. the card's headings, and its verdict line.
  let card: string | undefined;
  if (!fs.existsSync(pattern)) {
    problems.push("workspace/pattern.md is missing");
  } else {
    card = fs.readFileSync(pattern, "utf8");
    for (const heading of HEADINGS) {
      if (!hasHeading(card, heading)) problems.push(`workspace/pattern.md lacks the heading "${heading}"`);
    }
  }
  const cardVerdict = card === undefined ? undefined : sectionFirstLine(card, "## Verdict");

  // 5. the handoff's verdict line, and that it agrees with the card.
  if (!fs.existsSync(handoff)) {
    problems.push("handoff.md is missing");
  } else {
    const line = (fs.readFileSync(handoff, "utf8").split("\n")[2] ?? "").trim();
    const parsed = /^Verdict:\s*(\S+)$/.exec(line);
    const allowed = opts.blind === true ? BLIND_VERDICTS : VERDICTS;
    if (parsed === null) {
      problems.push(`handoff.md line 3 is not a Verdict: line (got "${line}")`);
    } else {
      const verdict = parsed[1] ?? "";
      if (!allowed.includes(verdict)) {
        const hint = verdict === "open" ? " (open is only for blind scanners)" : "";
        problems.push(`handoff.md line 3 has an invalid verdict "${verdict}"${hint}`);
      } else if (cardVerdict !== undefined && cardVerdict !== verdict) {
        problems.push(`handoff verdict "${verdict}" differs from pattern.md's verdict "${cardVerdict}"`);
      }
    }
  }

  // 6. no script reads the hold-out.
  const scripts = path.join(node, "workspace", "scripts");
  for (const file of filesUnder(scripts)) {
    if (!HOLDOUT.test(fs.readFileSync(file, "utf8"))) continue;
    const name = path.relative(scripts, file).split(path.sep).join("/");
    problems.push(`workspace/scripts/${name} mentions the hold-out`);
  }

  // 7. a script that lists directories must have declared it before measuring.
  const declared = fs.existsSync(measure) && ENUMERATES_DECLARATION.test(fs.readFileSync(measure, "utf8"));
  if (!declared) {
    for (const file of filesUnder(scripts)) {
      if (!ENUMERATES_CALL.test(fs.readFileSync(file, "utf8"))) continue;
      const name = path.relative(scripts, file).split(path.sep).join("/");
      problems.push(
        `workspace/scripts/${name} lists directories; say why in an "Enumerates:" line of measure.md before pre-registering`,
      );
    }
  }

  return { problems };
}

function usage(message: string): number {
  console.error(`check-pattern: ${message}`);
  console.error("usage: node harness/tools/check-pattern.ts <nodeDir> [--blind]");
  return 2;
}

function main(argv: string[]): number {
  const positional: string[] = [];
  let blind = false;
  for (const arg of argv) {
    if (arg === "--blind") blind = true;
    else if (arg.startsWith("--")) return usage(`unknown option ${arg}`);
    else positional.push(arg);
  }
  const [nodeDirArg] = positional;
  if (nodeDirArg === undefined || positional.length > 1) return usage("expected a node directory");

  const nodeDir = path.resolve(nodeDirArg);
  if (!fs.existsSync(nodeDir) || !fs.statSync(nodeDir).isDirectory()) return usage(`${nodeDirArg} is not a directory`);
  const runDir = findRunDir(nodeDir);
  if (runDir === undefined) return usage(`no .git repository above ${nodeDirArg}`);

  let problems: string[];
  try {
    problems = checkPattern(runDir, nodeDir, { blind }).problems;
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

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
