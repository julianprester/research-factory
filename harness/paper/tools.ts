// The Phase 4 owner's tools, as functions rather than registrations (design §8, §9; plan Task 12).
//
// `owner-extension.ts` only registers these; everything here takes the run directory, so the rules are tested on a
// real temp run without a pi session. Every tool takes a paper node `W<nn>` under an explanation in Phase 4 (the
// reopen takes the paper too, and moves its explanation). Refusals are `Error`s naming the gate, as the Phase 3 tools
// refuse, and a refused call writes nothing (`submit_paper` restores what its finalisation changed).
//
// **`init_paper`** scaffolds the paper (`initPaper`). **`check_paper`** runs `checkPaper` with the real citation check
// and the Quarto render, writes `checks/result.json` for the paper as it stands, and never changes `paper.qmd`.
// **`pass_begin`** and **`pass_end`** bracket a style pass (`passes.ts`). **`submit_paper`** is the gated end: the
// check must be ok for the current `paper.qmd`, both passes accepted in order and the last one's sha is the paper's,
// the pins still match the explanation, `finalizeBib` runs clean, and a final `checkPaper` with the render is clean;
// then the paper and its check are committed and the paper moves to Phase 5 `ready` and the explanation to `closed`.
// **`reopen_explanation`** sends a submitted explanation back to Phase 3 for an extra loop (design §9): the writer's
// request is copied under the explanation, the reopen is recorded, and the paper's pins record the outline as it stood,
// so the paper reads as stale until `repin_paper` runs after the outline has changed. **`repin_paper`** refreshes the
// generated copies and the pins (`repinPaper`).
//
// Every read is without following a link (`readRegular`, `locate`), and every write is a temp file and a rename.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { realExec, type Exec } from "../analysis/run.ts";
import { ensurePredictionsPin } from "../explain/tools.ts";
import { loopDir, locate, readReopens, readRegular, readRounds, ROUND_CAP, writeAtomic } from "../explain/rounds.ts";
import { appendReopen, currentLoop } from "../explain/reopen.ts";
import { readConfig } from "../launch.ts";
import { checkPaper, pinProblems, type PaperOptions } from "../tools/check-paper.ts";
import { commitFiles, findNode, updateNode, type NodeRef } from "../tree.ts";
import { acceptedPasses, beginPass, endPass, PASSES } from "./passes.ts";
import { finalizeBib, initPaper, repinPaper } from "./project.ts";
import { renderPaper } from "./render.ts";

/** The commits are the owner's. */
const ACTOR = "owner-p4";
const WORKSPACE = "workspace";

/** The seams the tools take: tests inject the citation check, the Quarto container and `deepis`. */
let testCitations: ((file: string) => string[]) | undefined;
let testExec: Exec | undefined;
let testDeepis: ((args: string[]) => { code: number; stderr: string }) | undefined;

/** Replace the citation check for registered calls (the real one needs a database). */
export function setCitationsForTests(citations: ((file: string) => string[]) | undefined): void {
  testCitations = citations;
}

/** Replace the container runner for the paper's render (`renderPaper`) in registered calls. */
export function setPaperExecForTests(exec: Exec | undefined): void {
  testExec = exec;
}

/** Replace `deepis bib` for registered `submit_paper` calls. */
export function setDeepisForTests(deepis: ((args: string[]) => { code: number; stderr: string }) | undefined): void {
  testDeepis = deepis;
}

export interface NodeInput {
  nodeId: string;
}

export interface PassInput extends NodeInput {
  pass: string;
}

export interface NoteInput extends NodeInput {
  note?: string;
}

/** The result `checks/result.json` holds: the paper it is for, whether it passed, and what it found. */
export interface CheckRecord {
  paperSha: string;
  ok: boolean;
  problems: string[];
  warnings: string[];
  renderedAt: string;
}

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const rel = (run: string, file: string): string => path.relative(run, file).split(path.sep).join("/");
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A refusal naming the gate, in the Phase 3 style. */
function refusal(tool: string, gate: string, text: string): Error {
  return new Error(`${tool} refused (gate "${gate}"): ${text}`);
}

/**
 * The paper node `nodeId` and its explanation, which must be a paper in Phase 4 under an explanation in Phase 4. A
 * paper that has moved on (Phase 5) is not the Phase 4 owner's to change.
 */
function paperOf(runDir: string, nodeId: string, tool: string): { paper: NodeRef; explanation: NodeRef } {
  const paper = findNode(runDir, nodeId);
  if (paper.type !== "paper") throw refusal(tool, "node", `${nodeId} is not a paper node`);
  if (paper.phase !== 4) throw new Error(`Not your phase (node in P${paper.phase}, you own P4)`);
  const explanation = paper.parent === null ? undefined : findNode(runDir, paper.parent);
  if (explanation === undefined || explanation.type !== "explanation") {
    throw refusal(tool, "node", `${nodeId} is not under an explanation`);
  }
  return { paper, explanation };
}

/** The paper's `checks/result.json`, or undefined when there is none; a file that cannot be read is an error. */
function resultOf(paper: NodeRef): CheckRecord | undefined {
  const bytes = readRegular(paper.dir, `${WORKSPACE}/checks/result.json`);
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(bytes.toString("utf8")) as CheckRecord;
  } catch {
    throw new Error(`${WORKSPACE}/checks/result.json is not valid JSON`);
  }
}

/** Writes the check record atomically, so a crash leaves the old record or the new. */
function writeResult(paper: NodeRef, record: CheckRecord): void {
  writeAtomic(path.join(paper.dir, WORKSPACE, "checks", "result.json"), `${JSON.stringify(record, null, 2)}\n`);
}

/** The citation check and the render, as the tools run them: the real check unless a test injected one. */
function checkOptions(runDir: string): PaperOptions {
  return {
    citations: testCitations,
    render: (nodeDir) => renderPaper(runDir, nodeDir, testExec),
  };
}

/** The `[P4:…]` commit of the paper's workspace subfolders, path-scoped to the given files under the paper node. */
function commitPaper(runDir: string, paper: NodeRef, files: string[], subject: string): string {
  return commitFiles(
    runDir,
    files.map((file) => rel(runDir, path.join(paper.dir, ...file.split("/")))),
    ACTOR,
    subject,
  );
}

/** Scaffolds the paper (`initPaper`) and commits its workspace. */
export function initPaperTool(runDir: string, input: NodeInput): string {
  const { paper } = paperOf(runDir, input.nodeId, "init_paper");
  const summary = initPaper(runDir, paper.dir);
  commitPaper(runDir, paper, [WORKSPACE], `[P4:init] ${paper.id}`);
  return summary;
}

/**
 * Checks the paper as it stands: the aggregate check with the real citations and the Quarto render. The record is
 * written for the paper's sha and committed with the check's folder. The reply lists what is wrong, or says ok.
 */
export async function checkPaperTool(runDir: string, input: NodeInput): Promise<string> {
  const { paper } = paperOf(runDir, input.nodeId, "check_paper");
  const qmd = readRegular(paper.dir, `${WORKSPACE}/paper.qmd`);
  if (qmd === undefined) throw refusal("check_paper", "paper", `${paper.id} has no ${WORKSPACE}/paper.qmd: run init_paper and write the draft`);
  const { problems, warnings } = await checkPaper(runDir, paper.dir, checkOptions(runDir));
  writeResult(paper, { paperSha: sha256(qmd), ok: problems.length === 0, problems, warnings, renderedAt: new Date().toISOString() });
  commitPaper(runDir, paper, [`${WORKSPACE}/checks`], `[P4:check] ${paper.id}`);
  if (problems.length === 0) return `${paper.id} checks ok${warnings.length === 0 ? "" : ` (${warnings.length} warning(s))`}`;
  return [`${paper.id} does NOT check (${problems.length} problem(s)):`, ...problems.map((problem) => `- ${problem}`)].join("\n");
}

/** Begins a style pass (`beginPass`) on the paper. */
export function passBeginTool(runDir: string, input: PassInput): string {
  const { paper } = paperOf(runDir, input.nodeId, "pass_begin");
  const { paperSha } = beginPass(runDir, paper.dir, input.pass);
  return `${input.pass} begun on ${paper.id} at paper ${paperSha.slice(0, 7)}: its embeds are recorded; the pass may reword prose only`;
}

/** Ends a style pass (`endPass`): accepted, or rejected with the embeds that changed and `paper.qmd` restored. */
export function passEndTool(runDir: string, input: PassInput): string {
  const { paper } = paperOf(runDir, input.nodeId, "pass_end");
  const result = endPass(runDir, paper.dir, input.pass);
  if (result.accepted) return `${input.pass} accepted on ${paper.id}: no embed changed`;
  return [
    `${input.pass} REJECTED on ${paper.id}: an embed changed, so paper.qmd is restored from the begin commit`,
    ...result.diff.map((line) => `- ${line}`),
  ].join("\n");
}

/** The request the writer filed for a reopen: a regular, non-empty `workspace/reopen-request.md`. */
function requestOf(paper: NodeRef): Buffer {
  let bytes: Buffer | undefined;
  try {
    bytes = readRegular(paper.dir, `${WORKSPACE}/reopen-request.md`);
  } catch (error) {
    throw refusal("reopen_explanation", "request", message(error));
  }
  if (bytes === undefined) throw refusal("reopen_explanation", "request", `${WORKSPACE}/reopen-request.md is missing: the writer files the request first`);
  if (bytes.toString("utf8").trim() === "") throw refusal("reopen_explanation", "request", `${WORKSPACE}/reopen-request.md is empty`);
  return bytes;
}

/** The bytes a submit's finalisation may change, so a refused submit can put them back. */
interface Snapshot {
  qmd: Buffer;
  bib: Buffer | undefined;
}

function snapshotOf(paper: NodeRef): Snapshot {
  const qmd = readRegular(paper.dir, `${WORKSPACE}/paper.qmd`);
  if (qmd === undefined) throw refusal("submit_paper", "check", `${paper.id} has no ${WORKSPACE}/paper.qmd`);
  return { qmd, bib: readRegular(paper.dir, `${WORKSPACE}/references.bib`) };
}

/** Puts `paper.qmd` and `references.bib` back as they were (a refused submit writes nothing). */
function restore(paper: NodeRef, before: Snapshot): void {
  writeAtomic(path.join(paper.dir, WORKSPACE, "paper.qmd"), before.qmd);
  const bib = path.join(paper.dir, WORKSPACE, "references.bib");
  if (before.bib === undefined) fs.rmSync(bib, { force: true });
  else writeAtomic(bib, before.bib);
}

/**
 * Submits the paper (design §8). Refuses, naming the gate and writing nothing, unless: the check is ok for the current
 * `paper.qmd`; both passes are accepted in order and the paper is what the last one left; the pins still match the
 * explanation; `finalizeBib` runs clean; and a final check with the render is clean. Then the paper, its references
 * and its check are committed, the paper moves to Phase 5 `ready`, and the explanation to `closed`.
 */
export async function submitPaperTool(runDir: string, input: NoteInput): Promise<string> {
  const tool = "submit_paper";
  const { paper, explanation } = paperOf(runDir, input.nodeId, tool);
  const before = snapshotOf(paper);
  const paperSha = sha256(before.qmd);

  // 1. the check is ok for this paper.
  let check: CheckRecord | undefined;
  try {
    check = resultOf(paper);
  } catch (error) {
    throw refusal(tool, "check", message(error));
  }
  if (check === undefined || check.ok !== true || check.paperSha !== paperSha) {
    throw refusal(tool, "check", `${WORKSPACE}/checks/result.json is not ok for the current paper.qmd: run check_paper after the last edit`);
  }

  // 2. both passes are accepted, in order, and the paper is what the last one left.
  const passes = acceptedPasses(runDir, paper.dir);
  const names = passes.map((record) => record.pass);
  if (names.length !== PASSES.length || names.some((name, at) => name !== PASSES[at])) {
    throw refusal(tool, "passes", `the style passes must both be accepted, in order (${PASSES.join(", ")}); accepted now: ${names.join(", ") || "none"}`);
  }
  if (passes.at(-1)?.afterSha !== paperSha) {
    throw refusal(tool, "passes", "paper.qmd changed after the last accepted pass: run both passes again");
  }

  // 3. the pins still match the explanation.
  let stale: string[];
  try {
    stale = pinProblems(runDir, paper.dir, explanation.dir, explanation.id);
  } catch (error) {
    throw refusal(tool, "pins", message(error));
  }
  if (stale.length > 0) throw refusal(tool, "pins", stale.join("\n"));

  // 4. the bibliography is finalised without problems. Anything it changed is put back if a later gate refuses.
  let problems: string[];
  try {
    problems = finalizeBib(runDir, paper.dir, testDeepis);
  } catch (error) {
    restore(paper, before);
    throw refusal(tool, "finalize", message(error));
  }
  if (problems.length > 0) {
    restore(paper, before);
    throw refusal(tool, "finalize", problems.join("\n"));
  }

  // 5. a final check on the finalised file, with the render, is clean (a Needs section is one of its problems).
  let final: Awaited<ReturnType<typeof checkPaper>>;
  try {
    final = await checkPaper(runDir, paper.dir, checkOptions(runDir));
  } catch (error) {
    restore(paper, before);
    throw refusal(tool, "check", message(error));
  }
  if (final.problems.length > 0) {
    restore(paper, before);
    throw refusal(tool, "check", `the finalised paper does not check (${final.problems.length} problem(s)):\n${final.problems.join("\n")}`);
  }
  const finalSha = sha256(readRegular(paper.dir, `${WORKSPACE}/paper.qmd`) ?? "");
  writeResult(paper, { paperSha: finalSha, ok: true, problems: [], warnings: final.warnings, renderedAt: new Date().toISOString() });

  // The paper and its check are the submitted state; then the paper moves on and the explanation closes.
  const sha = commitPaper(runDir, paper, [`${WORKSPACE}/paper.qmd`, `${WORKSPACE}/references.bib`, `${WORKSPACE}/checks`], `[P4:finalize] ${paper.id}`);
  updateNode(runDir, paper.id, { status: "ready", phase: 5 }, ACTOR, input.note?.trim() || undefined);
  updateNode(runDir, explanation.id, { status: "closed" }, ACTOR);
  return `submitted ${paper.id}: now ready in Phase 5, at paper commit ${sha}; ${explanation.id} is closed.`;
}

/**
 * Reopens the explanation of `paper` (design §9): the request goes to the explanation's `reopens/NN/request.md`, the
 * reopen is recorded, the explanation returns to Phase 3 `ready`, and the paper's pins take the outline as it is now,
 * so the paper reads as stale until `repin_paper`. Refused at the reopen limit, while the explanation is not in
 * Phase 4, while its loop has not stopped, and without a request.
 */
export function reopenExplanationTool(runDir: string, input: NoteInput): string {
  const tool = "reopen_explanation";
  const { paper, explanation } = paperOf(runDir, input.nodeId, tool);
  if (explanation.phase !== 4) {
    throw refusal(tool, "phase", `${explanation.id} is in phase ${explanation.phase}, not phase 4: only a submitted explanation is reopened`);
  }
  const config = readConfig(runDir);
  const cap = config.roundCap ?? ROUND_CAP;
  const reopenRounds = config.reopenRounds as number;
  const maxReopens = config.maxReopens as number;

  let history: ReturnType<typeof readRounds>;
  let reopens: ReturnType<typeof readReopens>;
  try {
    history = readRounds(runDir, explanation.id);
    reopens = readReopens(runDir, explanation.id);
  } catch (error) {
    throw refusal(tool, "loop", `the round record cannot be read: ${message(error)}`);
  }
  let current: ReturnType<typeof currentLoop>;
  try {
    current = currentLoop(history, reopens, cap, reopenRounds);
  } catch (error) {
    throw refusal(tool, "loop", message(error));
  }
  if (!current.decision.stop) throw refusal(tool, "loop", `reopen ${current.reopen} has not stopped: a reopen waits for the loop to end`);
  if (reopens.length >= maxReopens) {
    throw refusal(tool, "reopen limit", `${explanation.id} has ${reopens.length} reopen(s) and maxReopens is ${maxReopens}: no more reopens`);
  }
  const request = requestOf(paper);
  const outline = readRegular(paper.dir, `${WORKSPACE}/outline.md`);
  if (outline === undefined) throw refusal(tool, "outline", `${WORKSPACE}/outline.md is missing`);
  const pinsBytes = readRegular(paper.dir, `${WORKSPACE}/checks/pins.json`);
  if (pinsBytes === undefined) throw refusal(tool, "pins", `${WORKSPACE}/checks/pins.json is missing (run init_paper)`);
  let pins: Record<string, unknown>;
  try {
    pins = JSON.parse(pinsBytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw refusal(tool, "pins", `${WORKSPACE}/checks/pins.json is unreadable`);
  }

  const n = reopens.length + 1;
  const folder = `reopens/${String(n).padStart(2, "0")}`;
  const requestRel = `${folder}/request.md`;
  const found = locate(explanation.dir, requestRel);
  if (found.kind === "refused") throw refusal(tool, "request", found.problem);
  // The Predictions are pinned before the explanation moves, so the reopen cannot change what was pinned (Task 4).
  try {
    ensurePredictionsPin(runDir, explanation.dir);
  } catch (error) {
    throw refusal(tool, "predictions", message(error));
  }

  // The reopen is validated and recorded before the request is copied, so a refused reopen writes nothing under the node.
  try {
    appendReopen(runDir, explanation.id, { n, requestSha: sha256(request), afterRound: history.length }, maxReopens, cap, reopenRounds);
  } catch (error) {
    throw refusal(tool, "reopen limit", message(error));
  }
  writeAtomic(path.join(explanation.dir, ...requestRel.split("/")), request);
  writeAtomic(
    path.join(paper.dir, WORKSPACE, "checks", "pins.json"),
    `${JSON.stringify({ ...pins, reopens: n, outlineShaAtReopen: sha256(outline.toString("utf8")) }, null, 2)}\n`,
  );
  commitFiles(
    runDir,
    [
      rel(runDir, path.join(explanation.dir, "reopens")),
      rel(runDir, path.join(loopDir(runDir, explanation.id), "reopens.json")),
      rel(runDir, path.join(paper.dir, WORKSPACE, "checks", "pins.json")),
    ],
    ACTOR,
    `[P4:reopen] ${paper.id} reopen ${n}`,
  );
  updateNode(runDir, explanation.id, { status: "ready", phase: 3 }, ACTOR, input.note?.trim() || undefined);
  return `${explanation.id} reopened (reopen ${n} of ${maxReopens}): back in Phase 3 ready with the request in reopens/${String(n).padStart(2, "0")}/request.md. ${paper.id} stays active and is stale until repin_paper, after its outline is revised.`;
}

/** Re-pins the paper (`repinPaper`) and commits the refreshed generated copies and the pins. */
export function repinPaperTool(runDir: string, input: NodeInput): string {
  const { paper } = paperOf(runDir, input.nodeId, "repin_paper");
  const summary = repinPaper(runDir, paper.dir);
  commitPaper(
    runDir,
    paper,
    [
      `${WORKSPACE}/_variables.yml`,
      `${WORKSPACE}/variables_sources.csv`,
      `${WORKSPACE}/embeds/tables`,
      `${WORKSPACE}/embeds/figures`,
      `${WORKSPACE}/embeds/predictions.qmd`,
      `${WORKSPACE}/checks/pins.json`,
    ],
    `[P4:repin] ${paper.id}`,
  );
  return summary;
}
