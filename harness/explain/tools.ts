// The Phase 3 owner's loop tools, as functions rather than registrations.
//
// `owner-extension.ts` only registers these; everything here takes the run
// directory, so the rules can be tested against a real temp run without a pi
// session. Three tools live here, all for an explanation node in Phase 3:
//
// **`openRound`** starts a round from the owner's plan (design §6.1). The code
// refuses a plan it cannot read, a task letter that was ever used (letters are
// unique across the node's life: earlier rounds' records and the `tasks/` folder
// both count), a round while the previous one is open, and any round once the
// recorded history has stopped (a STOP is a latch; the cap comes from the run's
// config). It writes `rounds/NN/plan.md` itself - the owner's write tool cannot -
// and on round 1 snapshots the parent puzzle's `workspace/puzzle.md` and its
// `## Phase 3 must check` list, so workers never read the ancestor puzzle.
//
// **`closeRound`** is the verdict gate (design §6.3). It refuses unless every
// task of the round left a handoff whose first line is a non-BLOCKED `Status:`,
// the round's literature worker left its handoff and report, and the argument
// exists. It will not take `none` on round 1, and will not take `substantial`
// when the argument's hash equals the previous round's: a substantial change
// cannot be claimed without an edit. It writes `verdict.md`, appends the record
// and returns the stop decision. The verdict is written before the record, so a
// crash between them leaves the round open and the close can simply be repeated.
//
// **`archiveScript`** is how an analysis is dropped (design §6.2): the script,
// its registry file and its log move to `workspace/archive/<stem>/` with a README
// holding the reason. It refuses an empty reason and a script or output file that
// `argument.md` links to, so a number the argument stands on cannot vanish.
//
// `tasks/`, `workspace/output/`, `workspace/scripts/` and `workspace/archive/`
// are written by workers and scripts, so every read and move here goes through
// `locate`/`readRegular` (each path component `lstat`ed, a link refused, the file
// opened without following one) and everything is verified before anything is
// changed. Every write is a temp file and a rename.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { readConfig } from "../launch.ts";
import { commitFiles, findNode, type NodeRef } from "../tree.ts";
import { argumentLinks } from "../tools/check-argument.ts";
import { maskFences, normaliseHeading } from "../tools/check-puzzle.ts";
import { ANALYSIS_SCRIPT } from "./reproduce.ts";
import {
  appendRound,
  argumentSha,
  locate,
  loopDir,
  parsePlan,
  readRegular,
  readRounds,
  ROUND_CAP,
  roundName,
  stopOf,
  writeAtomic,
  type Decision,
} from "./rounds.ts";

export interface OpenRoundInput {
  nodeId: string;
  plan: string;
}

export interface CloseRoundInput {
  nodeId: string;
  changed: "substantial" | "none";
  summary: string;
}

export interface ArchiveScriptInput {
  nodeId: string;
  script: string;
  reason: string;
}

/** The commits are the owner's: design §4 makes each plan and each verdict one. */
const ACTOR = "owner-p3";

/** `rel` (under the node) as a path under the run, for git. */
function runRelative(runDir: string, node: NodeRef, rel: string): string {
  return path.relative(runDir, path.join(node.dir, ...rel.split("/"))).split(path.sep).join("/");
}

/** The explanation node `nodeId`, which must be in Phase 3. */
function explanationNode(runDir: string, nodeId: string): NodeRef {
  const node = findNode(runDir, nodeId);
  if (node.type !== "explanation") throw new Error(`${nodeId} is not an explanation node`);
  if (node.phase !== 3) throw new Error(`Not your phase (node in P${node.phase}, you own P3)`);
  return node;
}

function showDecision(decision: Decision): string {
  return decision.stop ? `STOP (${decision.reason})` : "continue";
}

/** The config's round cap; a run without a readable config has no cap to apply, so the tool refuses. */
function capOf(runDir: string): number {
  return readConfig(runDir).roundCap ?? ROUND_CAP;
}

/** A path under the node that must be absent or a real folder; a link or a file there is refused. */
function requireFolderOrAbsent(node: string, rel: string): "absent" | "folder" {
  const found = locate(node, rel);
  if (found.kind === "refused") throw new Error(found.problem);
  if (found.kind === "file") throw new Error(`${rel} is not a folder`);
  return found.kind;
}

/** The text of the section `heading` (a normalised `##` heading) in `markdown`, or undefined when absent. */
function sectionOf(markdown: string, heading: string): string | undefined {
  const lines = markdown.split(/\r?\n/);
  const masked = maskFences(markdown);
  let body: string[] | undefined;
  for (const [index, line] of masked.entries()) {
    if (/^##\s/.test(line)) {
      if (body !== undefined) break;
      if (normaliseHeading(line) === heading) body = [];
      continue;
    }
    if (body !== undefined) body.push(lines[index] ?? "");
  }
  return body?.join("\n").trim();
}

/** The parent puzzle's two snapshots for round 1, read before anything is written. */
function puzzleSnapshots(runDir: string, node: NodeRef): { puzzle: Buffer; mustCheck: string } {
  const parent = node.parent === null ? undefined : findNode(runDir, node.parent);
  if (parent === undefined || parent.type !== "puzzle") throw new Error(`${node.id} has no parent puzzle to snapshot`);
  const puzzle = readRegular(parent.dir, "workspace/puzzle.md");
  if (puzzle === undefined) throw new Error(`${parent.id} has no workspace/puzzle.md to snapshot`);
  const merged = readRegular(parent.dir, "workspace/reviews/merged.md");
  if (merged === undefined) throw new Error(`${parent.id} has no workspace/reviews/merged.md to take the Phase 3 must-check list from`);
  const section = sectionOf(merged.toString("utf8"), "phase 3 must check");
  if (section === undefined) throw new Error(`${parent.id}'s workspace/reviews/merged.md has no "## Phase 3 must check" section`);
  return { puzzle, mustCheck: `# Phase 3 must check\n\n${section === "" ? "None." : section}\n` };
}

/**
 * Open the next round of `nodeId` from `plan`. Returns a line naming the round
 * and its tasks. Everything is checked, and the round-1 snapshots are read,
 * before the first write; `plan.md` is written first of the writes, so a round
 * that exists is a round that was opened.
 */
export async function openRound(runDir: string, input: OpenRoundInput): Promise<string> {
  const node = explanationNode(runDir, input.nodeId);
  const cap = capOf(runDir);

  const history = readRounds(runDir, node.id);
  const stopped = stopOf(history, cap);
  if (stopped.stop) throw new Error(`STOP recorded (${stopped.reason}): no more rounds`);

  const round = history.length + 1;
  const name = roundName(round);
  const planFile = `rounds/${name}/plan.md`;
  const existing = locate(node.dir, planFile);
  if (existing.kind === "refused") throw new Error(existing.problem);
  if (existing.kind !== "absent") throw new Error(`round ${name} is still open: close_round it before opening another`);

  const plan = parsePlan(input.plan);
  if (plan === null) {
    throw new Error(
      "the plan does not parse: it needs a `## Questions` section and a `## Tasks` section with at least one `### Task <L>: <aim>` heading, <L> one capital letter A-Z",
    );
  }
  const seen = new Set<string>();
  for (const { letter } of plan.tasks) {
    if (seen.has(letter)) throw new Error(`the plan lists letter ${letter} twice`);
    seen.add(letter);
  }

  requireFolderOrAbsent(node.dir, "rounds");
  requireFolderOrAbsent(node.dir, "workspace");
  const tasks = requireFolderOrAbsent(node.dir, "tasks");
  const present = tasks === "absent" ? [] : fs.readdirSync(path.join(node.dir, "tasks"));
  for (const { letter } of plan.tasks) {
    const earlier = history.find((record) => record.letters.includes(letter));
    if (earlier !== undefined) throw new Error(`letter ${letter} was used in round ${earlier.round}: a letter is never reused`);
    if (present.includes(letter)) throw new Error(`letter ${letter} already has a folder in tasks/: a letter is never reused`);
  }

  const snapshots = round === 1 ? puzzleSnapshots(runDir, node) : undefined;

  if (snapshots !== undefined) {
    writeAtomic(path.join(node.dir, "workspace", "puzzle.md"), snapshots.puzzle);
    writeAtomic(path.join(node.dir, "workspace", "must-check.md"), snapshots.mustCheck);
  }
  writeAtomic(path.join(node.dir, ...planFile.split("/")), input.plan.endsWith("\n") ? input.plan : `${input.plan}\n`);
  for (const { letter } of plan.tasks) fs.mkdirSync(path.join(node.dir, "tasks", letter), { recursive: true });
  const committed = [planFile, ...(snapshots === undefined ? [] : ["workspace/puzzle.md", "workspace/must-check.md"])];
  commitFiles(runDir, committed.map((rel) => runRelative(runDir, node, rel)), ACTOR, `[P3:plan] ${node.id} round ${name}`);
  return `opened round ${round} (rounds/${name}/plan.md) with tasks ${plan.tasks.map((task) => task.letter).join(", ")}`;
}

/** The handoff `Status:` of a task file's first line, or why it is not one. */
function handoffProblem(node: NodeRef, rel: string, label: string): string | undefined {
  let content: Buffer | undefined;
  try {
    content = readRegular(node.dir, rel);
  } catch (error) {
    return (error as Error).message;
  }
  if (content === undefined) return `${rel} is missing`;
  const first = content.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  const status = /^Status:\s*(\S+)/.exec(first)?.[1]?.toUpperCase();
  if (status === undefined) return `${rel} must start with a "Status:" line`;
  if (status === "BLOCKED") return `${label} is BLOCKED (${rel}): resolve it or plan around it`;
  if (status !== "DONE" && status !== "DONE_WITH_CONCERNS") {
    return `${rel} has the status "${status}": a handoff ends DONE or DONE_WITH_CONCERNS before the round closes`;
  }
  return undefined;
}

/** Whether `rel` is a regular file under the node; the problem otherwise. */
function fileProblem(node: NodeRef, rel: string): string | undefined {
  const found = locate(node.dir, rel);
  if (found.kind === "absent") return `${rel} is missing`;
  if (found.kind === "refused") return found.problem;
  if (found.kind === "folder") return `${rel} is not a regular file`;
  return undefined;
}

/** Close the open round of `nodeId` with the owner's verdict and return the stop decision. */
export async function closeRound(runDir: string, input: CloseRoundInput): Promise<string> {
  const node = explanationNode(runDir, input.nodeId);
  if (input.changed !== "substantial" && input.changed !== "none") {
    throw new Error(`changed must be "substantial" or "none", got ${JSON.stringify(input.changed)}`);
  }
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (summary === "") throw new Error("a verdict needs a summary: what changed in the argument, or why nothing did");
  const cap = capOf(runDir);

  const history = readRounds(runDir, node.id);
  const round = history.length + 1;
  const name = roundName(round);
  const planBytes = readRegular(node.dir, `rounds/${name}/plan.md`);
  if (planBytes === undefined) throw new Error("there is no open round to close: open_round first");
  const plan = parsePlan(planBytes.toString("utf8"));
  if (plan === null) throw new Error(`rounds/${name}/plan.md no longer parses as a plan`);

  const problems: string[] = [];
  for (const { letter } of plan.tasks) {
    const problem = handoffProblem(node, `tasks/${letter}/handoff.md`, `task ${letter}`);
    if (problem !== undefined) problems.push(problem);
  }
  for (const rel of [`tasks/lit-${name}/handoff.md`, `workspace/reports/${name}.md`, "workspace/argument.md"]) {
    const problem = fileProblem(node, rel);
    if (problem !== undefined) problems.push(problem);
  }
  if (problems.length > 0) throw new Error(`round ${name} cannot close:\n${problems.join("\n")}`);

  const sha = argumentSha(node.dir);
  if (input.changed === "none" && round === 1) {
    throw new Error('round 1 cannot be "none": the argument is first written in round 1, so that change is substantial');
  }
  const previous = history[history.length - 1];
  if (input.changed === "substantial" && previous !== undefined && previous.argumentSha === sha) {
    throw new Error(
      `workspace/argument.md is unchanged since round ${previous.round}: "substantial" needs an edit to the argument; edit it or close the round as "none"`,
    );
  }

  writeAtomic(path.join(node.dir, "rounds", name, "verdict.md"), `Changed: ${input.changed}\n\n${summary}\n`);
  const record = {
    round,
    changed: input.changed === "substantial",
    argumentSha: sha,
    summary,
    letters: plan.tasks.map((task) => task.letter),
  };
  appendRound(runDir, node.id, record, cap);
  commitFiles(
    runDir,
    [
      runRelative(runDir, node, `rounds/${name}/verdict.md`),
      path.relative(runDir, path.join(loopDir(runDir, node.id), "rounds.json")).split(path.sep).join("/"),
    ],
    ACTOR,
    `[P3:verdict] ${node.id} round ${name} (${input.changed})`,
  );
  return `round ${round} closed: ${showDecision(stopOf([...history, record], cap))}`;
}

/** Targets `argument.md` links to, as `workspace/`-relative paths, with the forms a percent-encoding can take. */
function linkedPaths(markdown: string): Set<string> {
  const linked = new Set<string>();
  for (const { target } of argumentLinks(markdown)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
    const file = target.split(/[#?]/, 1)[0] ?? "";
    let decoded = file;
    try {
      decoded = decodeURIComponent(file);
    } catch {
      /* the raw form is checked as well */
    }
    for (const form of [file, decoded]) {
      if (form === "" || form.startsWith("/")) continue;
      linked.add(path.posix.normalize(path.posix.join("workspace", form)));
    }
  }
  return linked;
}

/** Drop an analysis: move the script and its outputs to `workspace/archive/<stem>/` with the reason. */
export async function archiveScript(runDir: string, input: ArchiveScriptInput): Promise<string> {
  const node = explanationNode(runDir, input.nodeId);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason === "") throw new Error("archive_script needs a reason: say why this analysis is dropped");
  const script = input.script;
  if (!ANALYSIS_SCRIPT.test(script)) {
    throw new Error(`${JSON.stringify(script)} is not an analysis script name (X_nn.R, X_nn.py, assets.R or assets.py)`);
  }
  const stem = script.replace(/\.[^.]+$/, "");

  const sources = [
    `workspace/scripts/${script}`,
    `workspace/output/numbers/${stem}.csv`,
    `workspace/output/logs/${stem}.txt`,
  ];
  const moving: string[] = [];
  for (const rel of sources) {
    const found = locate(node.dir, rel);
    if (found.kind === "refused") throw new Error(found.problem);
    if (found.kind === "folder") throw new Error(`${rel} is not a regular file`);
    if (found.kind === "absent") {
      if (rel === sources[0]) throw new Error(`${rel} does not exist`);
      continue;
    }
    moving.push(rel);
  }

  const argument = readRegular(node.dir, "workspace/argument.md");
  if (argument !== undefined) {
    const linked = linkedPaths(argument.toString("utf8"));
    for (const rel of moving) {
      if (linked.has(rel)) throw new Error(`workspace/argument.md links to ${rel}: unlink it before archiving`);
    }
  }

  const archive = requireFolderOrAbsent(node.dir, "workspace/archive");
  const destination = `workspace/archive/${stem}`;
  const destinationDir = path.join(node.dir, ...destination.split("/"));
  // A stem is archived once. The one thing tolerated is the README alone in a real
  // folder: what an earlier attempt that died before its files arrived leaves.
  let leftover = false;
  if (archive === "folder") {
    const existing = locate(node.dir, destination);
    if (existing.kind === "refused") throw new Error(existing.problem);
    if (existing.kind !== "absent") {
      const entries = existing.kind === "folder" ? fs.readdirSync(destinationDir, { withFileTypes: true }) : [];
      leftover = entries.length === 1 && entries[0]!.name === "README.md" && entries[0]!.isFile();
      if (!leftover) throw new Error(`${destination} already exists: a stem is archived once`);
    }
  }

  // Stage the move in a private folder next to the destination and put it in place
  // with one rename at the end, so a rename that fails part-way is undone rather
  // than leaving a half-filled stem that blocks the retry.
  fs.mkdirSync(path.join(node.dir, "workspace", "archive"), { recursive: true });
  const stage = path.join(node.dir, "workspace", "archive", `.stage-${stem}-${randomBytes(6).toString("hex")}`);
  fs.mkdirSync(stage);
  const moved: string[] = [];
  try {
    const readme = [
      `# Archived: ${script}`,
      "",
      `Reason: ${reason}`,
      "",
      "Moved here from:",
      ...moving.map((rel) => `- ${rel}`),
      "",
    ].join("\n");
    fs.writeFileSync(path.join(stage, "README.md"), readme, { flag: "wx" });
    for (const rel of moving) {
      fs.renameSync(path.join(node.dir, ...rel.split("/")), path.join(stage, path.basename(rel)));
      moved.push(rel);
    }
    if (leftover) fs.rmSync(path.join(destinationDir, "README.md"));
    fs.renameSync(stage, destinationDir);
  } catch (error) {
    for (const rel of moved.reverse()) {
      try {
        fs.renameSync(path.join(stage, path.basename(rel)), path.join(node.dir, ...rel.split("/")));
      } catch {
        /* the original error is the one to report */
      }
    }
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  commitFiles(
    runDir,
    [
      ...moving.map((rel) => runRelative(runDir, node, rel)),
      runRelative(runDir, node, `${destination}/README.md`),
      ...moving.map((rel) => runRelative(runDir, node, `${destination}/${path.basename(rel)}`)),
    ],
    ACTOR,
    `[P3:archive] ${node.id} ${stem}`,
  );
  return `archived ${script} to ${destination}/ (${moving.map((rel) => path.basename(rel)).join(", ")})`;
}
