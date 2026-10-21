import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { ownerMayWrite, workerMayWrite } from "../guard.ts";
import ownerExtension from "../owner-extension.ts";
import workerExtension from "../worker-extension.ts";
import { createChild, findNode, initRun } from "../tree.ts";

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
