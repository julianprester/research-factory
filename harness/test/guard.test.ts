import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { ownerMayWrite, workerMayWrite } from "../guard.ts";
import ownerExtension from "../owner-extension.ts";
import workerExtension from "../worker-extension.ts";
import { createChild, findNode, initRun } from "../tree.ts";

interface CapturedTool {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<{ content: { type: string; text: string }[]; details: unknown }>;
}

type ToolCallHandler = (event: {
  type: string;
  toolCallId: string;
  toolName: string;
  input?: { path?: unknown };
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

function eventLineCount(runDir: string): number {
  return readFileSync(path.join(runDir, "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
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
  createChild(run, "D01", "Self Presentation", {}, "owner-p1");
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
});

test("tree_update refuses a node outside the owner's phase and writes nothing", async (t) => {
  const run = makeTempDir(t);
  initRun(run, "data", "work on all-remote platforms");
  const node = createChild(run, "D01", "Self Presentation", {}, "owner-p1");
  assert.equal(node.phase, 1);

  const before = eventLineCount(run);
  assert.equal(before, 2);

  const tools = captureTools(2, run, t);
  const update = tools.get("tree_update");
  assert.ok(update, "tree_update was registered");

  await assert.rejects(
    () => update.execute("call-1", { nodeId: "T01", status: "active" }),
    /Not your phase \(node in P1, you own P2\)/,
  );
  assert.equal(eventLineCount(run), before, "a refused update appends no event");
});

test("tree_create refuses a parent outside the owner's phase", async (t) => {
  const run = makeTempDir(t);
  initRun(run, "data", "work on all-remote platforms");
  createChild(run, "D01", "Self Presentation", {}, "owner-p1");
  const before = eventLineCount(run);

  const tools = captureTools(2, run, t);
  const create = tools.get("tree_create");
  assert.ok(create, "tree_create was registered");

  await assert.rejects(
    () => create.execute("call-1", { parentId: "T01", title: "A Puzzle" }),
    /Not your phase \(node in P1, you own P2\)/,
  );
  assert.equal(eventLineCount(run), before, "a refused create appends no event");
});

test("tree_create and tree_update work in the owner's own phase", async (t) => {
  const run = makeTempDir(t);
  initRun(run, "data", "work on all-remote platforms");

  const tools = captureTools(1, run, t);
  const create = tools.get("tree_create");
  const update = tools.get("tree_update");
  assert.ok(create && update);

  const created = await create.execute("call-1", { parentId: "D01", title: "Self Presentation" });
  assert.equal(created.content[0].text, "created T01 pattern 1 ready Self Presentation");
  assert.equal(findNode(run, "T01").node.phase, 1);

  const updated = await update.execute("call-2", { nodeId: "T01", status: "active" });
  assert.equal(updated.content[0].text, "updated T01 pattern 1 active Self Presentation");
  assert.equal(findNode(run, "T01").node.status, "active");
});

test("tree_list prints compact lines and filters", async (t) => {
  const run = makeTempDir(t);
  initRun(run, "data", "work on all-remote platforms");
  createChild(run, "D01", "Self Presentation", {}, "owner-p1");

  const tools = captureTools(1, run, t);
  const list = tools.get("tree_list");
  assert.ok(list);

  const all = await list.execute("call-1", {});
  assert.equal(all.content[0].text, "D01 dataset 0 ready data\nT01 pattern 1 ready Self Presentation");

  const phase1 = await list.execute("call-2", { phase: 1, status: "ready" });
  assert.equal(phase1.content[0].text, "T01 pattern 1 ready Self Presentation");

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
