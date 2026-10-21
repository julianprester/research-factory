import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { ownerMayWrite, ownersRefusal, reviewsRefusal, siblingRefusal, workerMayWrite } from "../guard.ts";
import ownerExtension from "../owner-extension.ts";
import reviewerExtension from "../reviewer-extension.ts";
import workerExtension from "../worker-extension.ts";
import { createChild, findNode, initRun, updateNode } from "../tree.ts";

type ToolCall = (toolName: string, input: { path?: unknown; command?: unknown }) =>
  | { block?: boolean; reason?: string }
  | undefined;

interface CapturedTool {
  name: string;
  parameters?: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<{ content: { type: string; text: string }[]; details: unknown }>;
}

type ToolCallHandler = (event: {
  type: string;
  toolCallId: string;
  toolName: string;
  input?: { path?: unknown; command?: unknown };
}) => { block?: boolean; reason?: string } | undefined;

interface FakePi {
  registerTool(tool: CapturedTool): void;
  on(event: string, handler: ToolCallHandler): void;
}

function makeTempDir(t: TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ctc-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakePi(): { pi: FakePi; tools: Map<string, CapturedTool>; handlers: Map<string, ToolCallHandler> } {
  const tools = new Map<string, CapturedTool>();
  const handlers = new Map<string, ToolCallHandler>();
  return {
    pi: {
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
      on(event, handler) {
        handlers.set(event, handler);
      },
    },
    tools,
    handlers,
  };
}

/** Run `fn` with CTC_RUN_DIR/CTC_PHASE set, restoring the environment afterwards. */
function withOwnerEnv(t: TestContext, runDir: string, phase: number, fn: () => void): void {
  const savedRunDir = process.env.CTC_RUN_DIR;
  const savedPhase = process.env.CTC_PHASE;
  process.env.CTC_RUN_DIR = runDir;
  process.env.CTC_PHASE = String(phase);
  t.after(() => {
    if (savedRunDir === undefined) delete process.env.CTC_RUN_DIR;
    else process.env.CTC_RUN_DIR = savedRunDir;
    if (savedPhase === undefined) delete process.env.CTC_PHASE;
    else process.env.CTC_PHASE = savedPhase;
  });
  fn();
}

interface PuzzleRun {
  run: string;
  patternDir: string;
  otherPatternDir: string;
  phase1PatternDir: string;
  p1: string;
  p2: string;
  p3: string;
  evolved: string;
}

/**
 * A run with pattern T01 in phase 2 holding three puzzles (P01, P02, P03) and
 * an evolved P04 derived from P01, plus a phase-2 pattern T02 and a phase-1
 * pattern T03 for the nodes that must stay unaffected.
 */
function puzzleRun(t: TestContext): PuzzleRun {
  const run = makeTempDir(t);
  initRun(run, "data", "interest");
  createChild(run, "D01", "Self Presentation", "owner-p1");
  createChild(run, "D01", "Second Pattern", "owner-p1");
  createChild(run, "D01", "Third Pattern", "owner-p1");
  updateNode(run, "T01", { phase: 2, status: "active" }, "owner-p1");
  updateNode(run, "T02", { phase: 2, status: "active" }, "owner-p1");
  createChild(run, "T01", "status quo: crowd", "owner-p2");
  createChild(run, "T01", "different level: rooms", "owner-p2");
  createChild(run, "T01", "different theory: front", "owner-p2");
  createChild(run, "T01", "grounding: crowd", "owner-p2", ["P01"]);
  return {
    run,
    patternDir: findNode(run, "T01").dir,
    otherPatternDir: findNode(run, "T02").dir,
    phase1PatternDir: findNode(run, "T03").dir,
    p1: findNode(run, "P01").dir,
    p2: findNode(run, "P02").dir,
    p3: findNode(run, "P03").dir,
    evolved: findNode(run, "P04").dir,
  };
}

/** Register a worker extension, chdir into `cwd` and return its tool_call guard. */
function workerGuard(t: TestContext, cwd: string): ToolCall {
  const handlers = new Map<string, ToolCallHandler>();
  workerExtension({
    registerTool() {},
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  const guard = handlers.get("tool_call");
  assert.ok(guard, "the worker registers a tool_call handler");
  const originalCwd = process.cwd();
  t.after(() => process.chdir(originalCwd));
  process.chdir(cwd);
  return (toolName, input) => guard({ type: "tool_call", toolCallId: "c", toolName, input });
}

/** Register the reviewer extension, chdir into `cwd` and return its tool_call guard. */
function reviewerGuard(t: TestContext, cwd: string): ToolCall {
  const handlers = new Map<string, ToolCallHandler>();
  reviewerExtension({
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  const guard = handlers.get("tool_call");
  assert.ok(guard, "the reviewer registers a tool_call handler");
  const originalCwd = process.cwd();
  t.after(() => process.chdir(originalCwd));
  process.chdir(cwd);
  return (toolName, input) => guard({ type: "tool_call", toolCallId: "c", toolName, input });
}

function commitCount(runDir: string): number {
  return Number(execFileSync("git", ["-C", runDir, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim());
}

function captureTools(phase: number, runDir: string, t: TestContext): Map<string, CapturedTool> {
  const { pi, tools } = fakePi();
  withOwnerEnv(t, runDir, phase, () => ownerExtension(pi));
  return tools;
}

test("workerMayWrite only allows workspace, rounds.md and handoff.md inside the node", (t) => {
  const node = makeTempDir(t);
  assert.equal(workerMayWrite(node, path.join(node, "workspace", "a.csv")), true);
  assert.equal(workerMayWrite(node, path.join(node, "rounds.md")), true);
  assert.equal(workerMayWrite(node, path.join(node, "handoff.md")), true);
  assert.equal(workerMayWrite(node, path.join(node, "node.json")), false);
  assert.equal(workerMayWrite(node, path.join(node, "..", "T02-x", "workspace", "a")), false);
  assert.equal(workerMayWrite(node, path.join(node, "workspace", "..", "..", "x")), false);
});

test("worker tool_call guard runs the extension handler against cwd", (t) => {
  const run = makeTempDir(t);
  initRun(run, "data", "work on all-remote platforms");
  createChild(run, "D01", "Self Presentation", "owner-p1");
  const nodeDir = findNode(run, "T01").dir;
  assert.ok(nodeDir);

  const handlers = new Map<string, ToolCallHandler>();
  workerExtension({
    registerTool() {},
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  const guard = handlers.get("tool_call");
  assert.ok(guard, "the worker registers a tool_call handler");

  const originalCwd = process.cwd();
  t.after(() => process.chdir(originalCwd));
  process.chdir(nodeDir);

  assert.equal(
    guard({
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "write",
      input: { path: "workspace/x.csv" },
    }),
    undefined,
    "a write inside the node's workspace is allowed",
  );
  assert.equal(
    guard({ type: "tool_call", toolCallId: "call-2", toolName: "edit", input: { path: "handoff.md" } }),
    undefined,
    "an edit of handoff.md is allowed",
  );
  assert.equal(
    guard({ type: "tool_call", toolCallId: "call-3", toolName: "write", input: { path: "node.json" } })?.block,
    true,
    "a write to node.json is blocked",
  );
  assert.equal(
    guard({
      type: "tool_call",
      toolCallId: "call-4",
      toolName: "write",
      input: { path: "../T02-x/workspace/a" },
    })?.block,
    true,
    "a write outside the node is blocked",
  );
  const noPath = guard({ type: "tool_call", toolCallId: "call-5", toolName: "write" });
  assert.equal(noPath?.block, true, "a write without a path is blocked");
  assert.ok(typeof noPath?.reason === "string" && noPath.reason.length > 0);

  const outside = makeTempDir(t);
  process.chdir(outside);
  assert.equal(
    guard({ type: "tool_call", toolCallId: "call-6", toolName: "write", input: { path: "workspace/x.csv" } })?.block,
    true,
    "a write from outside any node is blocked",
  );
});

test("ownerMayWrite allows its own phase dir and any node brief", (t) => {
  const run = makeTempDir(t);
  assert.equal(ownerMayWrite(run, 1, path.join(run, "owners", "phase-1", "ledger.md")), true);
  assert.equal(ownerMayWrite(run, 1, path.join(run, "owners", "phase-2", "ledger.md")), false);
  assert.equal(ownerMayWrite(run, 1, path.join(run, "patterns", "T01-a", "node.json")), false);
  assert.equal(ownerMayWrite(run, 1, path.join(run, "patterns", "T01-a", "brief.md")), true);
  assert.equal(
    ownerMayWrite(run, 1, path.join(run, "patterns", "T01-a", "puzzles", "P01-b", "brief.md")),
    true,
  );
  assert.equal(ownerMayWrite(run, 1, path.join(run, "owners", "phase-1", "..", "phase-2", "ledger.md")), false);
  assert.equal(ownerMayWrite(run, 0, path.join(run, "prep", "Z01-profile", "brief.md")), true, "prep briefs are node briefs");
  assert.equal(ownerMayWrite(run, 0, path.join(run, "prep", "Z01-profile", "node.json")), false);
  assert.equal(
    ownerMayWrite(run, 1, path.join(run, "patterns", "T03-x", "puzzles", "P01-y", "brief-review.md")),
    true,
    "the reviewer brief of a puzzle node is an owner write",
  );
  assert.equal(
    ownerMayWrite(run, 1, path.join(run, "patterns", "T03-x", "brief-review.md")),
    false,
    "brief-review.md belongs to puzzle nodes only",
  );
  assert.equal(
    ownerMayWrite(run, 1, path.join(run, "patterns", "T03-x", "puzzles", "P01-y", "brief.md")),
    true,
    "the ordinary brief of a puzzle node is still allowed",
  );
});

test("tree_create makes a phase-0 prep node for the phase-0 owner only", async (t) => {
  const run = makeTempDir(t);
  initRun(run, "data", "work on all-remote platforms");
  // One capture; the phase is read from the environment when a tool runs.
  const create = captureTools(1, run, t).get("tree_create");
  assert.ok(create);

  await assert.rejects(
    () => create.execute("call-1", { parentId: "D01", title: "Profile", type: "prep" }),
    /Not your phase \(node in P0, you own P1\)/,
  );

  process.env.CTC_PHASE = "0";
  const created = await create.execute("call-2", { parentId: "D01", title: "Profile", type: "prep" });
  assert.equal(created.content[0].text, "created Z01 prep 0 ready profile");
  assert.equal(findNode(run, "Z01").phase, 0);

  await assert.rejects(
    () => create.execute("call-3", { parentId: "D01", title: "a" }),
    /Not your phase \(node in P1, you own P0\)/,
  );

  process.env.CTC_PHASE = "1";
  const pattern = await create.execute("call-4", { parentId: "D01", title: "a" });
  assert.equal(pattern.content[0].text, "created T01 pattern 1 ready a");
});

test("tree_create advertises the prep node type", (t) => {
  const run = makeTempDir(t);
  const { pi, tools } = fakePi();
  withOwnerEnv(t, run, 0, () => ownerExtension(pi));
  const schema = tools.get("tree_create")?.parameters as {
    properties?: Record<string, { description?: string }>;
  };
  assert.match(
    schema?.properties?.type?.description ?? "",
    /"prep" for Phase 0 preparation nodes; defaults to the parent's usual child type/,
  );
});

test("tree_update hands a prep node on to phase 1", async (t) => {
  const run = makeTempDir(t);
  initRun(run, "data", "work on all-remote platforms");
  createChild(run, "D01", "Assembler", "owner-p0", [], "prep");

  const update = captureTools(0, run, t).get("tree_update");
  assert.ok(update);
  const updated = await update.execute("call-1", { nodeId: "Z01", phase: 1, status: "ready" });
  assert.equal(updated.content[0].text, "updated Z01 prep 1 ready assembler");
  assert.equal(findNode(run, "Z01").phase, 1);
});

test("tree_update refuses a node outside the owner's phase and writes nothing", async (t) => {
  const run = makeTempDir(t);
  initRun(run, "data", "work on all-remote platforms");
  const node = createChild(run, "D01", "Self Presentation", "owner-p1");
  assert.equal(node.phase, 1);

  const before = commitCount(run);
  assert.equal(before, 2);

  const tools = captureTools(2, run, t);
  const update = tools.get("tree_update");
  assert.ok(update, "tree_update was registered");

  await assert.rejects(
    () => update.execute("call-1", { nodeId: "T01", status: "active" }),
    /Not your phase \(node in P1, you own P2\)/,
  );
  assert.equal(commitCount(run), before, "a refused update makes no commit");
});

test("tree_create refuses a parent outside the owner's phase", async (t) => {
  const run = makeTempDir(t);
  initRun(run, "data", "work on all-remote platforms");
  createChild(run, "D01", "Self Presentation", "owner-p1");
  const before = commitCount(run);

  const tools = captureTools(2, run, t);
  const create = tools.get("tree_create");
  assert.ok(create, "tree_create was registered");

  await assert.rejects(
    () => create.execute("call-1", { parentId: "T01", title: "A Puzzle" }),
    /Not your phase \(node in P1, you own P2\)/,
  );
  assert.equal(commitCount(run), before, "a refused create makes no commit");
});

test("tree_create and tree_update work in the owner's own phase", async (t) => {
  const run = makeTempDir(t);
  initRun(run, "data", "work on all-remote platforms");

  const tools = captureTools(1, run, t);
  const create = tools.get("tree_create");
  const update = tools.get("tree_update");
  assert.ok(create && update);

  const created = await create.execute("call-1", { parentId: "D01", title: "Self Presentation" });
  assert.equal(created.content[0].text, "created T01 pattern 1 ready self-presentation");
  assert.equal(findNode(run, "T01").phase, 1);

  const updated = await update.execute("call-2", { nodeId: "T01", status: "active" });
  assert.equal(updated.content[0].text, "updated T01 pattern 1 active self-presentation");
  assert.equal(findNode(run, "T01").status, "active");
});

test("tree_update routes a phase-1 pattern to phase 2 as ready", async (t) => {
  const run = makeTempDir(t);
  initRun(run, "data", "work on all-remote platforms");
  createChild(run, "D01", "E03 Etiquette", "owner-p1");
  createChild(run, "D01", "E04 Remote", "owner-p1");

  const phase1 = captureTools(1, run, t).get("tree_update");
  assert.ok(phase1);
  const routed = await phase1.execute("call-1", {
    nodeId: "T01",
    phase: 2,
    status: "ready",
    note: "violated: the ordering reversed",
  });
  assert.equal(routed.content[0].text, "updated T01 pattern 2 ready e03-etiquette");
  assert.equal(findNode(run, "T01").phase, 2);
  assert.equal(findNode(run, "T01").status, "ready");
  assert.equal(
    execFileSync("git", ["-C", run, "log", "-1", "--format=%b"], { encoding: "utf8" }).trim(),
    "violated: the ordering reversed",
    "the note is the commit body",
  );

  // After routing only the phase-2 owner may touch it; the phase-1 owner of the
  // same call is now refused, and so is a phase-2 owner on a still-phase-1 node.
  const stillPhase1 = captureTools(1, run, t).get("tree_update");
  await assert.rejects(
    () => stillPhase1!.execute("call-2", { nodeId: "T01", status: "closed" }),
    /Not your phase \(node in P2, you own P1\)/,
  );
  const phase2 = captureTools(2, run, t).get("tree_update");
  assert.ok(phase2);
  await assert.rejects(
    () => phase2.execute("call-3", { nodeId: "T02", phase: 2, status: "ready", note: "x" }),
    /Not your phase \(node in P1, you own P2\)/,
  );
  const closed = await phase2.execute("call-4", { nodeId: "T01", status: "closed" });
  assert.equal(closed.content[0].text, "updated T01 pattern 2 closed e03-etiquette");
  assert.equal(findNode(run, "T02").phase, 1, "the refused call wrote nothing");
});

test("tree_list prints compact lines and filters", async (t) => {
  const run = makeTempDir(t);
  initRun(run, "data", "work on all-remote platforms");
  createChild(run, "D01", "Self Presentation", "owner-p1");

  const tools = captureTools(1, run, t);
  const list = tools.get("tree_list");
  assert.ok(list);

  const all = await list.execute("call-1", {});
  assert.equal(all.content[0].text, "D01 dataset 0 - data\nT01 pattern 1 ready self-presentation");

  const phase1 = await list.execute("call-2", { phase: 1, status: "ready" });
  assert.equal(phase1.content[0].text, "T01 pattern 1 ready self-presentation");

  const none = await list.execute("call-3", { phase: 4 });
  assert.equal(none.content[0].text, "(no nodes)");
});

test("owner tool_call guard blocks writes outside its phase and allows node briefs", async (t) => {
  const run = makeTempDir(t);
  const { pi, handlers } = fakePi();
  withOwnerEnv(t, run, 1, () => ownerExtension(pi));
  const guard = handlers.get("tool_call");
  assert.ok(guard, "the owner registers a tool_call handler");

  const blocked = guard({
    type: "tool_call",
    toolCallId: "call-1",
    toolName: "write",
    input: { path: path.join(run, "owners", "phase-2", "ledger.md") },
  });
  assert.equal(blocked?.block, true);
  assert.ok(typeof blocked?.reason === "string" && blocked.reason.length > 0);

  assert.equal(
    guard({
      type: "tool_call",
      toolCallId: "call-2",
      toolName: "edit",
      input: { path: path.join(run, "owners", "phase-1", "ledger.md") },
    }),
    undefined,
  );
  assert.equal(
    guard({
      type: "tool_call",
      toolCallId: "call-3",
      toolName: "write",
      input: { path: path.join(run, "patterns", "T01-a", "brief.md") },
    }),
    undefined,
  );
  assert.equal(
    guard({
      type: "tool_call",
      toolCallId: "call-4",
      toolName: "write",
      input: { path: path.join(run, "patterns", "T01-a", "node.json") },
    })?.block,
    true,
  );
});

test("a Phase 1 worker cannot read the hold-out or run a command that names it; a Phase 0 worker can", (t) => {
  const run = makeTempDir(t);
  initRun(run, "data", "work on all-remote platforms");
  createChild(run, "D01", "profile", "owner-p0", [], "prep");
  createChild(run, "D01", "E01 Self Presentation", "owner-p1");
  const prepDir = findNode(run, "Z01").dir;
  const patternDir = findNode(run, "T01").dir;

  const handlers = new Map<string, ToolCallHandler>();
  workerExtension({
    registerTool() {},
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  const guard = handlers.get("tool_call");
  assert.ok(guard);
  const call = (toolName: string, input: { path?: unknown; command?: unknown }) =>
    guard({ type: "tool_call", toolCallId: "c", toolName, input });

  const originalCwd = process.cwd();
  t.after(() => process.chdir(originalCwd));

  process.chdir(patternDir);
  for (const spelling of ["holdout.txt", "hold-out.txt", "Hold_Out.txt", "hold out.txt"]) {
    assert.equal(call("read", { path: `/x/prep/Z01/workspace/split/${spelling}` })?.block, true, `read ${spelling}`);
  }
  assert.equal(call("read", { path: "/x/prep/Z01/workspace/split/exploration.txt" }), undefined, "the exploration list is readable");
  assert.equal(call("read", { path: "/x/prep/Z01/workspace/profile.md" }), undefined, "profile.md is readable");
  assert.equal(call("bash", { command: "wc -l /x/split/holdout.txt" })?.block, true, "bash naming the hold-out is refused");
  assert.equal(call("bash", { command: "node workspace/scripts/01-measure.mjs" }), undefined, "an ordinary command is allowed");
  assert.match(call("read", { path: "/x/holdout.txt" })?.reason ?? "", /never read the hold-out/);

  process.chdir(prepDir);
  assert.equal(call("read", { path: "/x/prep/Z01/workspace/split/holdout.txt" }), undefined, "the profile worker (Phase 0) is exempt");
  assert.equal(call("bash", { command: "node holdout.ts data workspace/split" }), undefined, "and may run the split tool");
});

test("a puzzle worker reads its own folder and the pattern's files but not a sibling puzzle", (t) => {
  const { patternDir, p1, p2 } = puzzleRun(t);
  const call = workerGuard(t, p1);

  assert.equal(call("read", { path: "workspace/puzzle.md" }), undefined, "its own card is readable");
  assert.equal(
    call("read", { path: path.join(patternDir, "workspace", "pattern.md") }),
    undefined,
    "the parent pattern's card is readable",
  );
  // The three spellings a model may use: relative, with .., and absolute.
  assert.equal(call("read", { path: `../${path.basename(p2)}/workspace/puzzle.md` })?.block, true, "relative sibling");
  assert.equal(
    call("read", { path: `../../puzzles/${path.basename(p2)}/workspace/puzzle.md` })?.block,
    true,
    "a .. path into the sibling",
  );
  assert.equal(call("read", { path: path.join(p2, "workspace", "puzzle.md") })?.block, true, "absolute sibling");
  assert.match(call("read", { path: path.join(p2, "workspace", "puzzle.md") })?.reason ?? "", /sibling puzzles/);
});

test("a puzzle worker's bash may name its own folder but not a sibling's", (t) => {
  const { p1, p2 } = puzzleRun(t);
  const call = workerGuard(t, p1);

  assert.equal(call("bash", { command: "wc -l workspace/puzzle.md" }), undefined, "an ordinary command is allowed");
  assert.equal(
    call("bash", { command: `cat ${path.join(p1, "workspace", "puzzle.md")}` }),
    undefined,
    "naming its own folder is allowed",
  );
  assert.equal(
    call("bash", { command: `cat ../${path.basename(p2)}/workspace/puzzle.md` })?.block,
    true,
    "naming a sibling folder is refused",
  );
  assert.equal(call("bash", { command: `ls ${path.basename(p2)}` })?.block, true, "a bare sibling folder name is refused");
});

test("an evolved puzzle may read its derivedFrom parent, not its other siblings", (t) => {
  const { p1, p3, evolved } = puzzleRun(t);
  const call = workerGuard(t, evolved);

  assert.equal(call("read", { path: path.join(p1, "workspace", "puzzle.md") }), undefined, "the parent card is readable");
  assert.equal(
    call("read", { path: path.join(p1, "workspace", "reviews", "merged.md") }),
    undefined,
    "the parent's merged review is readable by an evolution worker (only the judge is kept from reviews)",
  );
  assert.equal(call("bash", { command: `cat ${path.join(p1, "workspace", "puzzle.md")}` }), undefined, "bash naming the parent");
  assert.equal(call("read", { path: path.join(p3, "workspace", "puzzle.md") })?.block, true, "an unrelated sibling");
  assert.equal(call("bash", { command: `cat ${path.join(p3, "workspace", "puzzle.md")}` })?.block, true, "bash naming it");
  assert.equal(call("bash", { command: "cat workspace/puzzle.md" }), undefined, "its own workspace stays readable");
});

test("the sibling rule leaves non-puzzle nodes and Phase 1 workers alone", (t) => {
  const { p1, otherPatternDir, phase1PatternDir } = puzzleRun(t);
  const sibling = path.join(p1, "workspace", "puzzle.md");

  assert.equal(siblingRefusal(otherPatternDir, "read", { path: sibling }), undefined, "a phase-2 pattern node is unaffected");
  assert.equal(
    siblingRefusal(otherPatternDir, "bash", { command: `cat ${sibling}` }),
    undefined,
    "nor is its bash",
  );

  const call = workerGuard(t, phase1PatternDir);
  assert.equal(call("read", { path: sibling }), undefined, "a Phase 1 worker is not under the sibling rule");
});

test("reviewsRefusal refuses any read under reviews/ and bash naming it except check-citations", () => {
  assert.match(reviewsRefusal("read", { path: "workspace/reviews/b.md" }) ?? "", /never read a review/);
  assert.match(reviewsRefusal("read", { path: "/x/patterns/T01-a/puzzles/P01-b/workspace/reviews/merged.md" }) ?? "", /never read a review/);
  assert.equal(reviewsRefusal("read", { path: "workspace/puzzle.md" }), undefined);
  assert.equal(reviewsRefusal("bash", { command: "cat workspace/reviews/b.md" }) !== undefined, true);
  assert.equal(reviewsRefusal("bash", { command: "grep -r . workspace/reviews" }) !== undefined, true, "the bare folder");
  assert.equal(reviewsRefusal("bash", { command: "cd workspace/reviews && cat b.md" }) !== undefined, true, "cd then read");
  assert.equal(reviewsRefusal("bash", { command: "ls workspace/reviews;" }) !== undefined, true, "trailing semicolon");
  assert.equal(reviewsRefusal("bash", { command: "cat workspace/previews/x.md" }), undefined, "previews/ is not reviews/");
  assert.equal(reviewsRefusal("bash", { command: "cat workspace/reviews-notes.md" }), undefined, "reviews-notes.md is not the folder");
  assert.equal(
    reviewsRefusal("bash", { command: "cd workspace && cat reviews/b.md" }) !== undefined,
    true,
    "a bare relative reviews/ segment after cd",
  );
  assert.equal(
    reviewsRefusal("bash", { command: "cat reviews/merged.md" }) !== undefined,
    true,
    "a bare relative reviews/ segment",
  );
  assert.equal(reviewsRefusal("bash", { command: "ls workspace/previews" }), undefined, "previews is not reviews");
  assert.equal(reviewsRefusal("bash", { command: "cat reviews-notes.md" }), undefined, "a file name is not the folder");
  assert.equal(reviewsRefusal("bash", { command: "cat xreviews/foo" }), undefined, "xreviews is not reviews");
  for (const command of [
    "cat reviews/b.md",
    "cd workspace && cat reviews/b.md",
    "cd reviews",
    "grep -r . workspace/reviews",
    "cat ./reviews/b.md",
    'cat "reviews/b.md"',
    "ls reviews;",
    "cat <reviews/b.md",
    "cat >reviews/b.md",
  ]) {
    assert.equal(reviewsRefusal("bash", { command }) !== undefined, true, `refused: ${command}`);
  }
  for (const command of [
    'deepis search "owners of firms" -n 5',
    'deepis search "peer reviews of owners" -n 5 --no-rerank -f json | jq \'.results[0]\'',
    "timeout 60 deepis context 123 -f json",
    'deepis search "reviewers judging owners"',
    "deepis search owners -n 5",
  ]) {
    assert.equal(reviewsRefusal("bash", { command }), undefined, `a literature search is not a path: ${command}`);
  }
  assert.equal(
    reviewsRefusal("bash", { command: 'grep -n "peer reviews of owners" workspace/puzzle.md' }),
    undefined,
    "a quoted phrase is text, not a path",
  );
  assert.equal(
    reviewsRefusal("bash", { command: "node harness/tools/check-citations.ts workspace/reviews/a.md" }),
    undefined,
    "check-citations may read the review it is checking",
  );
  assert.equal(
    reviewsRefusal("bash", { command: "node harness/tools/check-citations.ts workspace/reviews/a.md 2>&1" }),
    undefined,
    "a trailing 2>&1 is not a pipe",
  );
  assert.equal(
    reviewsRefusal("bash", { command: "node harness/tools/check-citations.ts workspace/reviews/a.md 2>&1 | tail -20" }) !==
      undefined,
    true,
    "a pipe after the redirect is not allowed",
  );
  assert.equal(
    reviewsRefusal("bash", { command: "cat workspace/reviews/b.md && echo check-citations.ts" }) !== undefined,
    true,
    "the escape needs a plain node command, not the word anywhere",
  );
  assert.equal(
    reviewsRefusal("bash", { command: "node harness/tools/check-citations.ts workspace/reviews/a.md; cat b.md" }) !==
      undefined,
    true,
    "a chained command is not a plain check-citations run",
  );
  assert.equal(
    reviewsRefusal("bash", { command: "echo x && node harness/tools/check-citations.ts workspace/reviews/a.md" }) !==
      undefined,
    true,
    "the command must start with node",
  );
  assert.equal(reviewsRefusal("bash", { command: "wc -l workspace/puzzle.md" }), undefined);
  assert.equal(reviewsRefusal("write", { path: "workspace/reviews/a.md" }), undefined, "write is not this guard's business");
});

test("ownersRefusal refuses the owners' folder, not a similar-looking name", () => {
  assert.match(ownersRefusal("read", { path: "/x/owners/phase-2/tournament/round-0.json" }) ?? "", /owners' folder/);
  assert.equal(ownersRefusal("read", { path: "workspace/puzzle.md" }), undefined);
  assert.equal(ownersRefusal("read", { path: "workspace/owners-notes.md" }), undefined, "a file name is not the folder");
  assert.equal(
    ownersRefusal("bash", { command: "cat ../owners/phase-2/tournament/round-0.json" }) !== undefined,
    true,
    "bash is refused too",
  );
  assert.equal(
    ownersRefusal("bash", { command: "cat owners/ledger.md" }) !== undefined,
    true,
    "a bare relative owners/ segment",
  );
  assert.equal(
    ownersRefusal("bash", { command: "cd .. && cat owners/phase-2/tournament/round-0.json" }) !== undefined,
    true,
    "a bare owners/ segment after cd ..",
  );
  assert.equal(ownersRefusal("bash", { command: "cat workspace/owners-notes.md" }), undefined);
  assert.equal(ownersRefusal("bash", { command: "grep -r founders workspace/puzzle.md" }), undefined, "founders contains owners but is not a segment");
  for (const command of [
    "cat owners/ledger.md",
    "cd .. && cat owners/x",
    "cd owners",
    "cat ./owners/ledger.md",
    'cat "owners/ledger.md"',
    "ls owners;",
    "cat 2>owners/ledger.md",
    "cat 2>>owners/ledger.md",
    "cat >>owners/ledger.md",
    "cat &>owners/ledger.md",
  ]) {
    assert.equal(ownersRefusal("bash", { command }) !== undefined, true, `refused: ${command}`);
  }
  for (const command of [
    'deepis search "owners of firms" -n 5',
    'deepis search "peer reviews of owners" -n 5 --no-rerank -f json | jq \'.results[0]\'',
    "timeout 60 deepis context 123 -f json",
    "deepis search owners -n 5",
  ]) {
    assert.equal(ownersRefusal("bash", { command }), undefined, `a literature search is not a path: ${command}`);
  }
  assert.equal(
    ownersRefusal("bash", { command: 'grep -n "owners of firms" workspace/puzzle.md' }),
    undefined,
    "a quoted phrase is text, not a path",
  );
});

test("the reviewer extension refuses reviews, siblings and writes outside its own review", (t) => {
  const { patternDir, p1, p2 } = puzzleRun(t);
  const call = reviewerGuard(t, p1);

  assert.equal(call("read", { path: "workspace/puzzle.md" }), undefined, "the card is readable");
  assert.equal(
    call("read", { path: path.join(patternDir, "workspace", "pattern.md") }),
    undefined,
    "the pattern's evidence is readable",
  );
  assert.equal(call("read", { path: "workspace/reviews/b.md" })?.block, true, "the other review is refused");
  assert.equal(
    call("read", { path: path.join(p1, "workspace", "reviews", "a.md") })?.block,
    true,
    "the reviewer's own draft is refused too",
  );
  assert.equal(
    call("read", { path: path.join(p2, "workspace", "reviews", "merged.md") })?.block,
    true,
    "a sibling's merged review is refused",
  );
  assert.equal(call("read", { path: path.join(p2, "workspace", "puzzle.md") })?.block, true, "a sibling card is refused");
  assert.equal(call("read", { path: "/x/holdout.txt" })?.block, true, "the hold-out is refused");

  assert.equal(
    call("bash", { command: "node harness/tools/check-citations.ts workspace/reviews/a.md" }),
    undefined,
    "check-citations on its own review is allowed",
  );
  assert.equal(call("bash", { command: "cat workspace/reviews/b.md" })?.block, true, "reading a review by bash is refused");
  assert.equal(call("bash", { command: "cd workspace && cat reviews/b.md" })?.block, true, "a bare reviews/ segment after cd");
  assert.equal(call("bash", { command: "cat reviews/merged.md" })?.block, true, "a bare relative reviews/ segment");
  assert.equal(call("bash", { command: "cat owners/ledger.md" })?.block, true, "a bare relative owners/ segment");
  assert.equal(
    call("bash", { command: "cd .. && cat owners/phase-2/ledger.md" })?.block,
    true,
    "owners/ behind a cd ..",
  );
  assert.equal(call("bash", { command: "ls workspace/previews" }), undefined, "previews is not reviews");
  assert.equal(call("bash", { command: "cat reviews-notes.md" }), undefined, "a file name is not the folder");
  assert.equal(call("bash", { command: "cat xreviews/foo" }), undefined, "xreviews is not reviews");
  assert.equal(call("bash", { command: "cat my_owners.txt" }), undefined, "my_owners is not owners");
  for (const command of [
    "cat reviews/b.md",
    "cd workspace && cat reviews/b.md",
    "cd reviews",
    "grep -r . workspace/reviews",
    "cat ./reviews/b.md",
    'cat "reviews/b.md"',
    "ls reviews;",
    "cat owners/ledger.md",
    "cd .. && cat owners/x",
    "cat <reviews/b.md",
    "cat >reviews/b.md",
    "cat 2>owners/ledger.md",
    "cat 2>>owners/ledger.md",
    "cat >>owners/ledger.md",
    "cat &>owners/ledger.md",
  ]) {
    assert.equal(call("bash", { command })?.block, true, `refused for the reviewer: ${command}`);
  }
  for (const command of [
    'deepis search "owners of firms" -n 5',
    'deepis search "peer reviews of owners" -n 5 --no-rerank -f json | jq \'.results[0]\'',
    "timeout 60 deepis context 123 -f json",
    'deepis search "reviewers judging owners"',
    "deepis search owners -n 5",
  ]) {
    assert.equal(call("bash", { command }), undefined, `the literature search is allowed: ${command}`);
  }
  assert.equal(
    call("bash", { command: 'grep -n "owners of firms" workspace/puzzle.md' }),
    undefined,
    "a quoted phrase is text, not a path",
  );
  assert.equal(
    call("bash", { command: 'grep -n "peer reviews of owners" workspace/puzzle.md' }),
    undefined,
    "a quoted phrase naming both is still text",
  );
  assert.equal(
    call("bash", { command: "node harness/tools/check-citations.ts workspace/reviews/a.md 2>&1" }),
    undefined,
    "a trailing 2>&1 is fine",
  );
  assert.equal(
    call("bash", { command: "node harness/tools/check-citations.ts workspace/reviews/a.md 2>&1 | tail -20" })?.block,
    true,
    "a pipe after the redirect is not",
  );
  assert.equal(call("bash", { command: "cat " + path.join(p2, "workspace", "puzzle.md") })?.block, true, "a sibling by bash");
  assert.equal(
    call("bash", {
      command: "node harness/tools/check-citations.ts " + path.join(p2, "workspace", "reviews", "a.md"),
    })?.block,
    true,
    "even check-citations may not be pointed at another puzzle's review",
  );

  assert.equal(call("write", { path: "workspace/reviews/a.md" }), undefined, "writing its own review is allowed");
  assert.equal(call("write", { path: "workspace/reviews/b.md" }), undefined, "the b slot is allowed too (the brief names one)");
  assert.equal(call("write", { path: "workspace/reviews/merged.md" })?.block, true, "the merge is the owner's, not a reviewer's");
  assert.equal(call("write", { path: "handoff.md" })?.block, true, "a reviewer writes no handoff.md");
  assert.equal(call("write", { path: "workspace/puzzle.md" })?.block, true, "a reviewer never edits the card");
  assert.equal(call("write", {})?.block, true, "a write without a path is refused");
  assert.equal(call("edit", { path: "workspace/reviews/a.md" }), undefined, "editing its own review is allowed");
  assert.equal(call("write", { path: "../" + path.basename(p2) + "/workspace/reviews/a.md" })?.block, true, "a sibling's review slot");
  assert.equal(call("read", { path: "/x/owners/phase-2/ledger.md" })?.block, true, "the owner's ledger is judge-side material");
  assert.equal(
    call("bash", { command: "cat ../owners/phase-2/tournament/round-0.json" })?.block,
    true,
    "and so are the round files, by bash",
  );
});

test("a backslash-escaped quote is an escaped character, not a quote", (t) => {
  const { p1 } = puzzleRun(t);
  const call = reviewerGuard(t, p1);

  // The round-4 bug: an escaped quote opened a phantom quoted span that swallowed
  // the rest of the command, so a plain `cat reviews/b.md` behind it was allowed.
  for (const command of [
    "echo don\\'t; cat reviews/b.md",
    "echo it\\'s fine && cat reviews/b.md",
    'echo \\"x; cat reviews/b.md',
  ]) {
    assert.equal(reviewsRefusal("bash", { command }) !== undefined, true, `an escaped quote opens no span: ${command}`);
    assert.equal(call("bash", { command })?.block, true, `refused for the reviewer: ${command}`);
  }
  // The splitter alone: a phantom span would fold the tail into a `deepis`
  // command, which is skipped whole, and the refusal would disappear.
  for (const command of ["deepis search don\\'t; cat reviews/b.md", 'deepis search \\"x; cat reviews/b.md']) {
    assert.equal(reviewsRefusal("bash", { command }) !== undefined, true, `the tail is its own command: ${command}`);
    assert.equal(call("bash", { command })?.block, true, `refused for the reviewer: ${command}`);
  }
  // shellWords alone: a phantom span would fold the words into a "quoted phrase".
  for (const command of ["grep -n don\\'t reviews/b.md", 'grep -n "a\\"b" reviews/b.md']) {
    assert.equal(reviewsRefusal("bash", { command }) !== undefined, true, `the words stay separate: ${command}`);
    assert.equal(call("bash", { command })?.block, true, `refused for the reviewer: ${command}`);
  }
  // Inside single quotes a backslash is literal, so the next quote closes the span.
  assert.equal(
    reviewsRefusal("bash", { command: "echo 'a\\'; cat reviews/b.md" }) !== undefined,
    true,
    "a backslash inside single quotes escapes nothing",
  );

  // Still allowed: quotes and escapes as the shell reads them.
  for (const command of [
    'deepis search "it\'s about owners" -n 5',
    `deepis search 'a "quoted" word' -n 5`,
    `deepis search "he said \\"owners\\" twice"`,
    `echo "a \\" b" ; ls workspace`,
    "cat reviews-notes.md",
  ]) {
    assert.equal(reviewsRefusal("bash", { command }), undefined, `allowed: ${command}`);
    assert.equal(call("bash", { command }), undefined, `allowed for the reviewer: ${command}`);
  }
  // A separator inside a quoted query does not split the command: were it split,
  // the tail would be a non-deepis command naming `owners` and be refused.
  for (const command of [
    'deepis search "a | b"',
    'deepis search "reviews | owners" -n 5',
    'deepis search "x\\" ; cat reviews/b.md"',
  ]) {
    assert.equal(reviewsRefusal("bash", { command }), undefined, `one simple command: ${command}`);
    assert.equal(call("bash", { command }), undefined, `one simple command for the reviewer: ${command}`);
  }
  // An unbalanced trailing quote neither crashes nor frees the guard: the unclosed
  // word is still a path token, so it is refused; a lone deepis query is allowed.
  assert.equal(
    reviewsRefusal("bash", { command: 'cat "reviews/b.md' }) !== undefined,
    true,
    "an unclosed quoted word is still a path token",
  );
  assert.equal(reviewsRefusal("bash", { command: 'deepis search "unbalanced' }), undefined, "harmless");
});

test("a reviewer of an evolved puzzle may not read its parent's reviews or folder", (t) => {
  const { p1, evolved } = puzzleRun(t);
  const call = reviewerGuard(t, evolved);

  assert.equal(call("read", { path: "workspace/puzzle.md" }), undefined, "its own card is readable");
  assert.equal(call("read", { path: path.join(p1, "workspace", "puzzle.md") })?.block, true, "the parent's card is refused");
  assert.equal(
    call("read", { path: path.join(p1, "workspace", "reviews", "merged.md") })?.block,
    true,
    "the parent's merged review is refused for a reviewer",
  );
});

test("an evolved worker's bash cannot hide a sibling behind a glob or a .. plus glob", (t) => {
  const { p1, evolved } = puzzleRun(t);
  const call = workerGuard(t, evolved);

  assert.equal(call("bash", { command: "cat ../P03*/workspace/puzzle.md" })?.block, true, "P03* names a sibling");
  assert.equal(call("bash", { command: "cat ../*/workspace/puzzle.md" })?.block, true, "a wildcard sibling");
  assert.equal(call("bash", { command: "cd ../* && cat workspace/puzzle.md" })?.block, true, "cd into a wildcard sibling");
  assert.equal(
    call("bash", { command: "cat ../../workspace/*.md" })?.block,
    true,
    ".. plus a glob is refused even when no puzzle name is in the command",
  );
  assert.equal(call("bash", { command: "ls workspace/*.md" }), undefined, "a glob without .. is still allowed");
  assert.equal(
    call("bash", { command: `cat ../${path.basename(p1)}/workspace/puzzle.md` }),
    undefined,
    "the parent spelled out explicitly",
  );
});

test("a reviewer's bash cannot hide a sibling behind a glob or a .. plus glob", (t) => {
  const { patternDir, p1 } = puzzleRun(t);
  const call = reviewerGuard(t, p1);

  assert.equal(call("bash", { command: "cat ../P02*/workspace/puzzle.md" })?.block, true, "P02* names a sibling");
  assert.equal(call("bash", { command: "cat ../*/workspace/puzzle.md" })?.block, true, "a wildcard sibling");
  assert.equal(call("bash", { command: "cd ../* && cat workspace/puzzle.md" })?.block, true);
  assert.equal(call("bash", { command: "cat ../../patterns/*/workspace/pattern.md" })?.block, true, ".. plus a glob");
  assert.equal(
    call("bash", { command: `cat ${path.join(patternDir, "puzzles")}/P02*/workspace/puzzle.md` })?.block,
    true,
    "an absolute glob naming a sibling, with no .. in the command",
  );
  assert.equal(call("bash", { command: "ls workspace/*.md" }), undefined, "a glob without .. is allowed");
});

test("a reviewer must sit inside a puzzle node folder, or every tool call is refused", (t) => {
  const { patternDir, run } = puzzleRun(t);
  const call = reviewerGuard(t, patternDir);

  assert.equal(call("read", { path: "workspace/puzzle.md" })?.block, true, "a pattern node is no home for a reviewer");
  assert.equal(call("write", { path: "workspace/reviews/a.md" })?.block, true, "not even the review slot");
  assert.match(call("read", { path: "workspace/puzzle.md" })?.reason ?? "", /must run inside a puzzle node folder/);

  process.chdir(run);
  assert.equal(call("read", { path: "workspace/puzzle.md" })?.block, true, "the run root is no home either");
  assert.equal(call("write", { path: "workspace/reviews/a.md" })?.block, true);

  process.chdir(makeTempDir(t));
  assert.equal(call("read", { path: "workspace/puzzle.md" })?.block, true, "a folder with no node.json is no home");
  assert.equal(call("write", { path: "workspace/reviews/a.md" })?.block, true);
});

test("a symlink in the reviewer's own folder cannot reach a sibling", (t) => {
  const { p1, p2 } = puzzleRun(t);
  mkdirSync(path.join(p2, "workspace"), { recursive: true });
  writeFileSync(path.join(p2, "workspace", "puzzle.md"), "# card\n");
  mkdirSync(path.join(p1, "workspace"), { recursive: true });
  symlinkSync(path.join(p2, "workspace"), path.join(p1, "workspace", "link"), "dir");

  const call = reviewerGuard(t, p1);
  assert.equal(call("read", { path: "workspace/link/puzzle.md" })?.block, true, "the real path is a sibling's");
  assert.match(call("read", { path: "workspace/link/puzzle.md" })?.reason ?? "", /sibling puzzles/);
});
