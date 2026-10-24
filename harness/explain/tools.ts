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
// The verdict commit also takes the node's `workspace/` and `tasks/` (design §4: each
// set of results, each report and each verdict is a commit), so the history can be
// rebuilt round by round; it never takes `.analysis/` or `analysis-data/`.
//
// **`archiveScript`** is how an analysis is dropped (design §6.2): the script,
// its registry file and its log move to `workspace/archive/<stem>/` with a README
// holding the reason. It refuses an empty reason and a script or output file that
// `argument.md` links to, so a number the argument stands on cannot vanish.
//
// **`reproduce`** re-runs the node's scripts in the container (design §10) once
// the loop has stopped and records `owners/phase-3/loop/<E>/reproduction.json`.
// A call is bounded by an 8-minute budget that is checked only between scripts, so
// it can overrun by one script's timeout; a partial answer means "call again". A
// link planted in the reproduced registry makes `reproduceWorkspace` reject on
// every later call, so that error is a failed reproduction: it is recorded, and
// the scratch folder and the state file are removed so the next call starts fresh.
// The resume state lives in `.analysis/repro-state/` (ignored by git, like the
// scratch), so a partial run does not leave the tree dirty.
//
// **`submit`** is the end gate (design §10): one `updateNode` hands the node to
// Phase 4, and only when every gate holds - a STOP, at least one script, a clean
// `check-argument` (with its review checks), a reproduction that is ok and whose
// hash still matches the scripts and numbers now, a review that is not BLOCKED
// and a ruling on every finding. Nothing is committed before `updateNode`, whose
// tree commit is the argument's preregistration for Phase 5 (design §9): the
// reply names it. An edit to `argument.md` after the review is allowed (and is in
// that commit); an edit to a script or a number is not.
//
// `tasks/`, `workspace/output/`, `workspace/scripts/` and `workspace/archive/`
// are written by workers and scripts, so every read and move here goes through
// `locate`/`readRegular` (each path component `lstat`ed, a link refused, the file
// opened without following one) and everything is verified before anything is
// changed. Every write is a temp file and a rename.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { ignoreScratch, type Exec } from "../analysis/run.ts";
import { readConfig } from "../launch.ts";
import { commitFiles, findNode, updateNode, type NodeRef } from "../tree.ts";
import { argumentLinks, checkArgument, checkRevision, parseReport } from "../tools/check-argument.ts";
import { maskFences, normaliseHeading } from "../tools/check-puzzle.ts";
import { ANALYSIS_SCRIPT, reproduceWorkspace, workspaceHash } from "./reproduce.ts";
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

export interface ReproduceInput {
  nodeId: string;
}

export interface SubmitInput {
  nodeId: string;
  note?: string;
}

/** The seams `reproduce` takes; tests pass a fake container and a small budget. */
export interface ReproduceDeps {
  exec?: Exec;
  budgetMs?: number;
}

/** The seam `submit` takes: the citation runner of `check-argument` (the real one needs a database). */
export interface SubmitDeps {
  citations?: (file: string) => string[];
}

/** One `reproduce` call's wall-clock budget, checked between scripts (so a call can overrun by one script). */
const REPRODUCE_BUDGET_MS = 8 * 60 * 1000;

let testExec: Exec | undefined;
let testBudgetMs: number | undefined;
let testCitations: ((file: string) => string[]) | undefined;

/** Replace the container runner for registered `reproduce` calls (the registration passes no deps). */
export function setExecForTests(exec: Exec | undefined): void {
  testExec = exec;
}

/** Override `reproduce`'s budget for registered calls; tests use 0 so a call stops before the first script. */
export function setBudgetForTests(ms: number | undefined): void {
  testBudgetMs = ms;
}

/** Replace the citation runner for registered `submit` calls, as Phase 2's tools take a transport. */
export function setCitationsForTests(citations: ((file: string) => string[]) | undefined): void {
  testCitations = citations;
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
      // The round's results, reports, handoffs and argument (design §4): one commit per verdict. Never
      // `.analysis/` or `analysis-data/`, which live at the run's root and are not the node's.
      runRelative(runDir, node, "workspace"),
      runRelative(runDir, node, "tasks"),
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

// ---------------------------------------------------------------------------
// reproduce and submit
// ---------------------------------------------------------------------------

/** What `reproduction.json` holds. */
interface Reproduction {
  ok: boolean;
  workspaceHash: string;
  mismatches: string[];
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `rel` (under the run) of the loop record `name` of a node. */
function loopRecord(runDir: string, nodeId: string, name: string): string {
  return path.relative(runDir, path.join(loopDir(runDir, nodeId), name)).split(path.sep).join("/");
}

/** Whether `.analysis/<folder>` may be cleaned: it must be absent or a real folder, never a link or a file. */
function cleanable(runDir: string, rel: string): boolean {
  const found = locate(runDir, rel);
  return found.kind === "absent" || found.kind === "folder";
}

/**
 * Remove the scratch copy and the resume state of a reproduction that threw, so
 * the next call starts fresh. The deletion is confined to those two paths and
 * follows no link: a link on the way to either leaves it alone and says so.
 */
function discardScratch(runDir: string, scratch: string, statePath: string): string | undefined {
  const skipped: string[] = [];
  if (cleanable(runDir, ".analysis/repro")) fs.rmSync(scratch, { recursive: true, force: true });
  else skipped.push(path.relative(runDir, scratch));
  if (cleanable(runDir, ".analysis/repro-state")) fs.rmSync(statePath, { force: true });
  else skipped.push(path.relative(runDir, statePath));
  return skipped.length === 0 ? undefined : `could not remove ${skipped.join(", ")}: a link or a file is on its path`;
}

function recordReproduction(runDir: string, node: NodeRef, record: Reproduction): void {
  writeAtomic(path.join(loopDir(runDir, node.id), "reproduction.json"), `${JSON.stringify(record, null, 2)}\n`);
  commitFiles(runDir, [loopRecord(runDir, node.id, "reproduction.json")], ACTOR, `[P3:reproduce] ${node.id}`);
}

function listLines(lines: string[]): string {
  return lines.map((line) => `- ${line}`).join("\n");
}

/**
 * Re-run `nodeId`'s scripts in the container and record whether the registry
 * reproduces (design §10). Refuses before a STOP is recorded. A call that the
 * budget stops says so and must be repeated; a finished one writes and commits
 * `reproduction.json`. The hash it records is the one from before the scripts ran.
 */
export async function reproduce(runDir: string, input: ReproduceInput, deps: ReproduceDeps = {}): Promise<string> {
  const node = explanationNode(runDir, input.nodeId);
  const history = readRounds(runDir, node.id);
  const stopped = stopOf(history, capOf(runDir));
  if (!stopped.stop) {
    throw new Error(`no STOP is recorded for ${node.id} (${history.length} closed round(s)): reproduce checks the finished workspace, after the loop has stopped`);
  }
  const config = readConfig(runDir);
  // `.analysis/` must be ignored before the first scratch file exists, or a partial run leaves the tree dirty.
  ignoreScratch(runDir);
  const scratch = path.join(runDir, ".analysis", "repro", path.basename(node.dir));
  const statePath = path.join(runDir, ".analysis", "repro-state", `${node.id}.json`);

  let result: Awaited<ReturnType<typeof reproduceWorkspace>>;
  try {
    // The scratch and the state are written by the harness only; a link or file on their path is refused before anything is written through it.
    for (const rel of [".analysis", ".analysis/repro", ".analysis/repro-state"]) {
      const found = locate(runDir, rel);
      if (found.kind === "refused") throw new Error(found.problem);
      if (found.kind === "file") throw new Error(`${rel} is not a folder`);
    }
    result = await reproduceWorkspace({
      runDir,
      nodeDir: node.dir,
      image: config.analysisImage,
      timeoutMs: config.analysisTimeoutMs,
      budgetMs: deps.budgetMs ?? testBudgetMs ?? REPRODUCE_BUDGET_MS,
      exec: deps.exec ?? testExec,
      statePath,
    });
  } catch (error) {
    // A link planted in the reproduced registry makes every later call reject until
    // the scratch is gone; this is a failed reproduction, recorded and cleaned up.
    const reason = `the reproduction could not be completed: ${message(error)}`;
    let hash = "";
    try {
      hash = workspaceHash(node.dir);
    } catch {
      /* an unhashable workspace has no hash to record; submit refuses an ok:false record anyway */
    }
    const cleanup = discardScratch(runDir, scratch, statePath);
    recordReproduction(runDir, node, { ok: false, workspaceHash: hash, mismatches: [reason] });
    return [
      `${node.id} did NOT reproduce: ${reason}`,
      cleanup ?? "The scratch copy and its resume state were removed: the next reproduce starts from the first script.",
      "Recorded in owners/phase-3/loop/" + node.id + "/reproduction.json (ok: false).",
    ].join("\n");
  }

  if (!result.complete) {
    return [
      `PARTIAL: the budget ran out before every script was re-run${result.mismatches.length === 0 ? "" : `; failed so far:\n${listLines(result.mismatches)}`}`,
      "Nothing is recorded yet: call reproduce again to resume where it stopped.",
    ].join("\n");
  }
  recordReproduction(runDir, node, { ok: result.ok, workspaceHash: result.workspaceHash, mismatches: result.mismatches });
  if (result.ok) {
    return `${node.id} reproduced: the registry the scripts write matches workspace/output/numbers. Recorded in owners/phase-3/loop/${node.id}/reproduction.json (ok: true).`;
  }
  return [
    `${node.id} did NOT reproduce (${result.mismatches.length} mismatch(es)):`,
    listLines(result.mismatches),
    `Recorded in owners/phase-3/loop/${node.id}/reproduction.json (ok: false). Fix the scripts or the registry, then call reproduce again.`,
  ].join("\n");
}

function refusal(gate: string, text: string): Error {
  return new Error(`submit refused (gate "${gate}"): ${text}`);
}

/** The top-level analysis scripts in `workspace/scripts/`; a link on the way is refused. */
function analysisScripts(node: NodeRef): string[] {
  const found = locate(node.dir, "workspace/scripts");
  if (found.kind === "refused") throw new Error(found.problem);
  if (found.kind === "absent") return [];
  if (found.kind === "file") throw new Error("workspace/scripts is not a folder");
  return fs
    .readdirSync(path.join(node.dir, "workspace", "scripts"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && ANALYSIS_SCRIPT.test(entry.name))
    .map((entry) => entry.name);
}

/** `reproduction.json` as `reproduce` wrote it; anything else is a refusal naming the reason. */
function readReproduction(runDir: string, nodeId: string): Reproduction | undefined {
  let bytes: Buffer | undefined;
  let parsed: unknown;
  try {
    bytes = readRegular(loopDir(runDir, nodeId), "reproduction.json");
    if (bytes === undefined) return undefined;
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw refusal("reproduction", `owners/phase-3/loop/${nodeId}/reproduction.json is unreadable: ${message(error)}`);
  }
  const { ok, workspaceHash: hash, mismatches } = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Partial<Reproduction>;
  if (typeof ok !== "boolean" || typeof hash !== "string" || !Array.isArray(mismatches) || !mismatches.every((line) => typeof line === "string")) {
    throw refusal("reproduction", `owners/phase-3/loop/${nodeId}/reproduction.json is unreadable: not a reproduction record`);
  }
  return { ok, workspaceHash: hash, mismatches };
}

/** The short sha of the newest commit `updateNode` made for `nodeId` (its subject begins `[P<n>:updateNode] <id> —`), which is not necessarily HEAD once the lock is released. */
function updateCommitSha(runDir: string, nodeId: string, phase: number): string {
  const subject = `[P${phase}:updateNode] ${nodeId} \u2014 `;
  const sha = execFileSync("git", ["log", "-1", "--format=%h", "--fixed-strings", "--grep", subject], { cwd: runDir, encoding: "utf8" }).trim();
  if (sha === "") throw new Error(`the commit for ${nodeId} cannot be found after updateNode`);
  return sha;
}

/**
 * The end gate (design §10). Refuses, naming the gate, unless every condition
 * holds; then one `updateNode` hands the node to Phase 4 `ready` and the reply
 * names the commit, which stands as the argument's preregistration (design §9).
 * Every read is of a regular file, none through a link; a record that cannot be
 * read is a refusal.
 */
export async function submit(runDir: string, input: SubmitInput, deps: SubmitDeps = {}): Promise<string> {
  const node = explanationNode(runDir, input.nodeId);

  // 1. the loop has stopped.
  let history: ReturnType<typeof readRounds>;
  let stopped: Decision;
  try {
    history = readRounds(runDir, node.id);
    stopped = stopOf(history, capOf(runDir));
  } catch (error) {
    throw refusal("STOP", `the round record cannot be read: ${message(error)}`);
  }
  if (!stopped.stop) throw refusal("STOP", `no STOP is recorded (${history.length} closed round(s)): finish the loop first`);

  // 2. there is something to reproduce.
  let scripts: string[];
  try {
    scripts = analysisScripts(node);
  } catch (error) {
    throw refusal("no scripts", message(error));
  }
  if (scripts.length === 0) {
    throw refusal("no scripts", "workspace/scripts has no analysis script, so there is nothing to reproduce: an argument with no analysis is not submitted");
  }

  // 3. check-argument, with its review checks.
  let problems: string[];
  try {
    problems = checkArgument(runDir, node.dir, { report: true, citations: deps.citations ?? testCitations }).problems;
  } catch (error) {
    throw refusal("check-argument", message(error));
  }
  if (problems.length > 0) throw refusal("check-argument", `${problems.length} problem(s):\n${listLines(problems)}`);

  // 4. the reproduction record is ok and still describes these scripts and numbers.
  const record = readReproduction(runDir, node.id);
  if (record === undefined) throw refusal("reproduction", "there is no reproduction record: call reproduce");
  if (!record.ok) {
    throw refusal("reproduction", `the last reproduction did not reproduce:\n${listLines(record.mismatches)}`);
  }
  let hash: string;
  try {
    hash = workspaceHash(node.dir);
  } catch (error) {
    throw refusal("reproduction", `the scripts and numbers cannot be hashed: ${message(error)}`);
  }
  if (hash !== record.workspaceHash) {
    throw refusal("reproduction", "workspace/scripts or workspace/output/numbers changed since the reproduction: call reproduce again");
  }

  // 5. the review is not BLOCKED, and every finding has a ruling.
  let report: ReturnType<typeof parseReport>;
  let revision = "";
  try {
    report = parseReport(readRegular(node.dir, "workspace/reviews/report.md")?.toString("utf8") ?? "");
  } catch (error) {
    throw refusal("review", message(error));
  }
  if (report === null) throw refusal("review", "workspace/reviews/report.md is malformed");
  if (report.status === "BLOCKED") throw refusal("review", "the review report ends with Status: BLOCKED");
  try {
    revision = readRegular(node.dir, "workspace/reviews/revision.md")?.toString("utf8") ?? "";
  } catch (error) {
    throw refusal("revision", message(error));
  }
  const unruled = checkRevision(report.findings, revision);
  if (unruled.length > 0) throw refusal("revision", listLines(unruled));

  // The one commit: updateNode's tree commit, which carries the argument as it stands.
  const note = typeof input.note === "string" && input.note.trim() !== "" ? input.note.trim() : undefined;
  updateNode(runDir, node.id, { status: "ready", phase: 4 }, ACTOR, note);
  const sha = updateCommitSha(runDir, node.id, 4);
  return `submitted ${node.id}: now ready in Phase 4, at commit ${sha}. That commit stands as the argument's preregistration for Phase 5 (design §9): the argument, its scripts and its numbers as they were when it was submitted.`;
}
