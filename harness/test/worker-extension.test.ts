import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { Exec } from "../analysis/run.ts";
import workerExtension, { findNodeDir, setExecForTests } from "../worker-extension.ts";
import { createChild, findNode, findRunDir, initRun, updateNode } from "../tree.ts";

interface CapturedTool {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<{ content: { type: string; text: string }[]; details: unknown }>;
}

interface FakePi {
  registerTool(tool: CapturedTool): void;
  on(event: string): void;
}

function fakePi(): { pi: FakePi; tools: Map<string, CapturedTool> } {
  const tools = new Map<string, CapturedTool>();
  return {
    pi: {
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
      on() {
        /* the guard handler is covered in guard.test.ts */
      },
    },
    tools,
  };
}

function git(runDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", runDir, ...args], { encoding: "utf8" }).trim();
}

/** The directory the test process started in, restored after every fixture. */
const REPO_CWD = process.cwd();

/** A run with one pattern node, cwd moved into it for the duration of the test. */
function patternNode(t: TestContext): { run: string; nodeDir: string } {
  const run = mkdtempSync(path.join(tmpdir(), "ctc-preregister-"));
  initRun(run, "data", "interest");
  createChild(run, "D01", "E03 Etiquette", "owner-p1");
  const nodeDir = findNode(run, "T01").dir;
  mkdirSync(path.join(nodeDir, "workspace"), { recursive: true });

  process.chdir(nodeDir);
  t.after(() => {
    process.chdir(REPO_CWD);
    rmSync(run, { recursive: true, force: true });
  });
  return { run, nodeDir };
}

function preregisterTool(t: TestContext): { run: string; nodeDir: string; tool: CapturedTool } {
  const { run, nodeDir } = patternNode(t);
  const { pi, tools } = fakePi();
  workerExtension(pi);
  const tool = tools.get("preregister");
  assert.ok(tool, "the worker extension registers preregister");
  return { run, nodeDir, tool };
}

test("the worker extension registers preregister with its description and no parameters", (t) => {
  const { tool } = preregisterTool(t);
  assert.equal(
    tool.description,
    "Commit workspace/measure.md to the run's git before you measure anything. Call it once, after measure.md is final.",
  );
  assert.deepEqual(tool.parameters, { type: "object", properties: {} });
  assert.equal(typeof tool.execute, "function");
});

test("preregister commits workspace/measure.md as the node's worker", async (t) => {
  const { run, nodeDir, tool } = preregisterTool(t);
  const measure = path.join(nodeDir, "workspace", "measure.md");
  writeFileSync(measure, "# Measure\n\nshare of pages mentioning etiquette\n");

  const result = await tool.execute("call-1", {});
  const sha = git(run, "rev-parse", "--short", "HEAD");
  assert.equal(result.content[0]?.text, `pre-registered at ${sha}`);
  assert.equal(git(run, "log", "-1", "--format=%s"), "[P1:preregister] T01 — measure.md");
  assert.equal(git(run, "log", "-1", "--format=%an"), "worker-T01", "the author is the node's worker");
  assert.equal(
    readFileSync(measure, "utf8"),
    git(run, "show", `HEAD:patterns/${path.basename(nodeDir)}/workspace/measure.md`) + "\n",
    "the committed content is the measure.md the worker wrote",
  );
  assert.equal(git(run, "status", "--porcelain"), "", "only that path was committed");
});

test("a second preregister refuses with the existing marker", async (t) => {
  const { run, nodeDir, tool } = preregisterTool(t);
  writeFileSync(path.join(nodeDir, "workspace", "measure.md"), "# Measure\n");
  await tool.execute("call-1", {});
  const commits = git(run, "rev-list", "--count", "HEAD");

  await assert.rejects(() => tool.execute("call-2", {}), new RegExp(`already pre-registered at [0-9a-f]{7,}`));
  assert.equal(git(run, "rev-list", "--count", "HEAD"), commits, "a refused call makes no commit");
});

test("preregister refuses when workspace/measure.md does not exist", async (t) => {
  const { run, tool } = preregisterTool(t);
  await assert.rejects(() => tool.execute("call-1", {}), /workspace\/measure\.md/);
  assert.equal(git(run, "status", "--porcelain"), "", "no commit was made");
});

test("preregister refuses outside a node folder", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ctc-preregister-outside-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const originalCwd = process.cwd();
  t.after(() => process.chdir(originalCwd));
  process.chdir(dir);

  const { pi, tools } = fakePi();
  workerExtension(pi);
  const tool = tools.get("preregister");
  assert.ok(tool);
  await assert.rejects(() => tool.execute("call-1", {}), /not inside a node folder/);
});

test("preregister refuses when measurement files already exist", async (t) => {
  const existing = ["workspace/scripts/scan.py", "workspace/results/counts.csv", "workspace/pattern.md"];
  for (const relPath of existing) {
    const { run, nodeDir, tool } = preregisterTool(t);
    writeFileSync(path.join(nodeDir, "workspace", "measure.md"), "# Measure\n");
    mkdirSync(path.dirname(path.join(nodeDir, relPath)), { recursive: true });
    writeFileSync(path.join(nodeDir, relPath), "written before the measure was registered\n");
    const commits = git(run, "rev-list", "--count", "HEAD");

    await assert.rejects(
      () => tool.execute("call-1", {}),
      (error: Error) => {
        assert.match(error.message, /^measure first is not allowed: /);
        assert.ok(error.message.includes(relPath), `${relPath} is named in: ${error.message}`);
        return true;
      },
      `${relPath} blocks pre-registration`,
    );
    assert.equal(git(run, "rev-list", "--count", "HEAD"), commits, `${relPath}: no commit was made`);
  }
});

/** A run with an explanation E01 under puzzle P01 in phase 3; returns the explanation's folder. */
function explanationNode(t: TestContext, dataset = "data"): string {
  const run = mkdtempSync(path.join(tmpdir(), "ctc-explanation-"));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  initRun(run, dataset, "interest");
  createChild(run, "D01", "Self Presentation", "owner-p1");
  createChild(run, "T01", "status quo: crowd", "owner-p2");
  createChild(run, "P01", "Explanation of crowd", "owner-p3", [], "explanation");
  updateNode(run, "E01", { phase: 3, status: "active" }, "owner-p3");
  return findNode(run, "E01").dir;
}

test("an explanation worker writes from its task folder only, and is blocked outside one", (t) => {
  const explanation = explanationNode(t);
  mkdirSync(path.join(explanation, "tasks", "A"), { recursive: true });

  const handlers = new Map<string, (event: { toolName: string; input?: { path?: unknown } }) => { block?: boolean; reason?: string } | undefined>();
  workerExtension({
    registerTool() {},
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  const guard = handlers.get("tool_call");
  assert.ok(guard, "the worker registers a tool_call handler");
  const write = (filePath: string) => guard({ toolName: "write", input: { path: filePath } });

  const originalCwd = process.cwd();
  t.after(() => process.chdir(originalCwd));
  process.chdir(path.join(explanation, "tasks", "A"));
  assert.equal(write(path.join(explanation, "workspace", "scripts", "A_01.R")), undefined, "a script of its own task");
  assert.equal(write(path.join(explanation, "tasks", "A", "handoff.md")), undefined, "its task's handoff");
  assert.equal(write(path.join(explanation, "tasks", "B", "handoff.md"))?.block, true, "another task's folder");
  assert.equal(write(path.join(explanation, "handoff.md"))?.block, true, "the node's handoff");
  assert.equal(write("../../workspace/argument.md")?.block, true, "the argument, reached through ..");

  process.chdir(explanation);
  const blocked = write(path.join(explanation, "workspace", "scripts", "A_01.R"));
  assert.equal(blocked?.block, true, "the node folder itself is no task, so every write is blocked");
  assert.match(blocked?.reason ?? "", /not inside a task folder/);
});

test("an explanation worker cannot write a node.json under its task folder", (t) => {
  const explanation = explanationNode(t);
  mkdirSync(path.join(explanation, "tasks", "A"), { recursive: true });

  const handlers = new Map<string, (event: { toolName: string; input?: { path?: unknown } }) => { block?: boolean; reason?: string } | undefined>();
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
  process.chdir(path.join(explanation, "tasks", "A"));
  assert.equal(guard({ toolName: "write", input: { path: "node.json" } })?.block, true, "a relative node.json");
  assert.equal(
    guard({ toolName: "write", input: { path: path.join(explanation, "tasks", "A", "sub", "node.json") } })?.block,
    true,
    "a node.json at any depth",
  );
});

test("findNodeDir passes over an explanation's task folders, so a stray node.json there cannot redirect the guards", (t) => {
  const explanation = explanationNode(t);
  const puzzle = path.dirname(path.dirname(explanation));
  const stray = '{"phase":1,"status":"ready"}\n';
  mkdirSync(path.join(explanation, "tasks", "A", "sub"), { recursive: true });
  writeFileSync(path.join(explanation, "tasks", "A", "node.json"), stray);
  writeFileSync(path.join(explanation, "tasks", "A", "sub", "node.json"), stray);
  writeFileSync(path.join(explanation, "tasks", "node.json"), stray);

  assert.equal(findNodeDir(path.join(explanation, "tasks", "A")), explanation, "the task folder's stray node.json is skipped");
  assert.equal(findNodeDir(path.join(explanation, "tasks", "A", "sub")), explanation, "at any depth");
  assert.equal(findNodeDir(path.join(explanation, "tasks")), explanation, "the tasks folder itself");
  assert.equal(findNodeDir(path.join(explanation, "workspace")), explanation, "the node's own folders are unchanged");
  assert.equal(findNodeDir(path.join(puzzle, "workspace")), puzzle, "a puzzle node is found as before");
});

/** The explanation of `explanationNode`, handed on to Phase 4 with its paper W01; returns the paper's folder. */
function paperNode(t: TestContext): string {
  const run = findRunDir(explanationNode(t));
  assert.ok(run, "the explanation sits in a run");
  updateNode(run, "E01", { phase: 4, status: "ready" }, "owner-p3");
  createChild(run, "E01", "Paper of crowd", "owner-p4", [], "paper");
  return findNode(run, "W01").dir;
}

test("a paper worker writes its lane only, and no node.json anywhere under its workspace", (t) => {
  const paper = paperNode(t);
  const handlers = new Map<string, (event: { toolName: string; input?: { path?: unknown } }) => { block?: boolean; reason?: string } | undefined>();
  workerExtension({
    registerTool() {},
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  const guard = handlers.get("tool_call");
  assert.ok(guard, "the worker registers a tool_call handler");
  const write = (filePath: string) => guard({ toolName: "write", input: { path: filePath } });

  const originalCwd = process.cwd();
  t.after(() => process.chdir(originalCwd));
  process.chdir(paper);
  for (const relPath of ["workspace/paper.qmd", "workspace/outline.md", "workspace/reopen-request.md", "workspace/embeds/diagrams/theory.yml", "rounds.md", "handoff.md"]) {
    assert.equal(write(relPath), undefined, `${relPath} is in the lane`);
  }
  for (const relPath of ["workspace/_variables.yml", "workspace/embeds/quotes/Q01.qmd", "workspace/embeds/tables/x.qmd", "workspace/checks/result.json", "workspace/references.bib", "workspace/node.json", "node.json"]) {
    const blocked = write(relPath);
    assert.equal(blocked?.block, true, `${relPath} is outside the lane`);
    assert.match(blocked?.reason ?? "", /may only write workspace\/paper\.qmd/);
  }
  assert.equal(write("../W02-x/workspace/paper.qmd")?.block, true, "a sibling paper");
  assert.equal(write("../../workspace/argument.md")?.block, true, "the parent explanation's argument, reached through ..");
});

test("a paper writer's write through a symlinked folder or file is refused when its real location leaves the lane", (t) => {
  const paper = paperNode(t);
  const outside = mkdtempSync(path.join(tmpdir(), "ctc-paper-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const embeds = path.join(paper, "workspace", "embeds");
  mkdirSync(path.join(embeds, "quotes"), { recursive: true });
  const handlers = new Map<string, (event: { toolName: string; input?: { path?: unknown } }) => { block?: boolean; reason?: string } | undefined>();
  workerExtension({
    registerTool() {},
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  const guard = handlers.get("tool_call");
  assert.ok(guard, "the worker registers a tool_call handler");
  const write = (filePath: string) => guard({ toolName: "write", input: { path: filePath } });

  const originalCwd = process.cwd();
  t.after(() => process.chdir(originalCwd));
  process.chdir(paper);
  symlinkSync(path.join(embeds, "quotes"), path.join(embeds, "diagrams"));
  assert.equal(write("workspace/embeds/diagrams/x.yml")?.block, true, "diagrams -> quotes/");
  unlinkSync(path.join(embeds, "diagrams"));
  symlinkSync(outside, path.join(embeds, "diagrams"));
  assert.equal(write("workspace/embeds/diagrams/x.yml")?.block, true, "diagrams -> an outside folder");
  unlinkSync(path.join(embeds, "diagrams"));
  mkdirSync(path.join(embeds, "diagrams"));
  assert.equal(write("workspace/embeds/diagrams/x.yml"), undefined, "a plain diagram spec is still allowed");

  const outsideFile = path.join(outside, "paper.qmd");
  writeFileSync(outsideFile, "outside\n");
  symlinkSync(outsideFile, path.join(paper, "workspace", "paper.qmd"));
  assert.equal(write("workspace/paper.qmd")?.block, true, "paper.qmd linked outside the node");
  assert.match(write("workspace/paper.qmd")?.reason ?? "", /Paper workers may only write/);
});

test("findNodeDir passes over a paper's workspace, so a stray node.json there cannot redirect the guards", (t) => {
  const paper = paperNode(t);
  const stray = '{"phase":1,"status":"ready"}\n';
  mkdirSync(path.join(paper, "workspace", "embeds", "diagrams"), { recursive: true });
  writeFileSync(path.join(paper, "workspace", "node.json"), stray);
  writeFileSync(path.join(paper, "workspace", "embeds", "node.json"), stray);

  assert.equal(findNodeDir(path.join(paper, "workspace")), paper, "the workspace's stray node.json is skipped");
  assert.equal(findNodeDir(path.join(paper, "workspace", "embeds", "diagrams")), paper, "at any depth");
  assert.equal(findNodeDir(paper), paper, "the paper folder itself");
});

test("findNodeDir still finds a run whose own folder is named tasks", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "ctc-tasks-named-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const run = path.join(base, "tasks", "run");
  initRun(run, "data", "interest");
  assert.equal(findNodeDir(run), run);
});

test("empty measurement directories do not block preregister", async (t) => {
  const { run, nodeDir, tool } = preregisterTool(t);
  writeFileSync(path.join(nodeDir, "workspace", "measure.md"), "# Measure\n");
  mkdirSync(path.join(nodeDir, "workspace", "scripts"), { recursive: true });
  mkdirSync(path.join(nodeDir, "workspace", "results"), { recursive: true });

  const result = await tool.execute("call-1", {});
  assert.match(result.content[0]?.text ?? "", /^pre-registered at [0-9a-f]{7,}$/);
  assert.equal(git(run, "log", "-1", "--format=%s"), "[P1:preregister] T01 — measure.md");
});

/**
 * An explanation E01 in phase 3 whose run has a real dataset, the split lists and a
 * config with a test image and timeout: the setup run_analysis needs. Returns the
 * explanation's folder.
 */
function analysisNode(t: TestContext): string {
  const dataset = mkdtempSync(path.join(tmpdir(), "ctc-dataset-"));
  t.after(() => rmSync(dataset, { recursive: true, force: true }));
  writeFileSync(path.join(dataset, "a.csv"), "a,1\n");
  const explanation = explanationNode(t, dataset);
  const run = findRunDir(explanation);
  assert.ok(run, "the explanation sits inside a run");
  const split = path.join(run, "prep", "Z01-profile", "workspace", "split");
  mkdirSync(split, { recursive: true });
  writeFileSync(path.join(split, "exploration.txt"), "a.csv\n");
  writeFileSync(path.join(split, "holdout.txt"), "");
  writeFileSync(
    path.join(run, "config.json"),
    JSON.stringify({ model: "m", phases: { "3": "skills/x.md" }, analysisImage: "ctc-analysis:test", analysisTimeoutMs: 1234 }),
  );
  return explanation;
}

/** An Exec that records its calls and resolves with `result`. */
function recordingExec(result: Partial<Awaited<ReturnType<Exec>>> = {}): { exec: Exec; calls: Array<{ args: string[]; timeoutMs: number }> } {
  const calls: Array<{ args: string[]; timeoutMs: number }> = [];
  const exec: Exec = async (args, opts) => {
    calls.push({ args, timeoutMs: opts.timeoutMs });
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...result };
  };
  return { exec, calls };
}

/** run_analysis, registered with `exec` injected through the test hook (removed after the test). */
function runAnalysisTool(t: TestContext, exec: Exec): CapturedTool {
  setExecForTests(exec);
  t.after(() => setExecForTests(undefined));
  const { pi, tools } = fakePi();
  workerExtension(pi);
  const tool = tools.get("run_analysis");
  assert.ok(tool, "the worker extension registers run_analysis");
  return tool;
}

/** Move the test's cwd to `dir` for the rest of the test. */
function enter(t: TestContext, dir: string): void {
  const originalCwd = process.cwd();
  t.after(() => process.chdir(originalCwd));
  process.chdir(dir);
}

test("the worker extension registers run_analysis with a script parameter", (t) => {
  const { pi, tools } = fakePi();
  workerExtension(pi);
  const tool = tools.get("run_analysis");
  assert.ok(tool);
  assert.deepEqual(Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties), ["script"]);
});

test("run_analysis runs the task's script in the configured image and returns the exit code and the log's last 40 lines", async (t) => {
  const explanation = analysisNode(t);
  const task = path.join(explanation, "tasks", "A");
  mkdirSync(task, { recursive: true });
  mkdirSync(path.join(explanation, "workspace", "scripts"), { recursive: true });
  writeFileSync(path.join(explanation, "workspace", "scripts", "A_01.R"), "cat('x')\n");
  enter(t, task);

  const stdout = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const { exec, calls } = recordingExec({ stdout });
  const tool = runAnalysisTool(t, exec);
  const result = await tool.execute("call-1", { script: "A_01.R" });

  assert.equal(calls.length, 1, "one container run");
  assert.equal(calls[0]?.args.at(-1), "scripts/A_01.R", "the script runs from scripts/");
  assert.ok(calls[0]?.args.includes("ctc-analysis:test"), "the configured image");
  assert.equal(calls[0]?.timeoutMs, 1234, "the configured timeout");
  const text = result.content[0]?.text ?? "";
  assert.match(text, /^exit code 0\n/);
  assert.match(text, /^line 50$/m, "the last line of output is returned");
  assert.match(text, /^line 12$/m, "the last 40 lines are returned");
  assert.doesNotMatch(text, /^line 11$/m, "earlier lines are not");
  assert.deepEqual(result.details, { code: 0, timedOut: false });
});

test("run_analysis reports a timed-out run", async (t) => {
  const explanation = analysisNode(t);
  const task = path.join(explanation, "tasks", "A");
  mkdirSync(task, { recursive: true });
  mkdirSync(path.join(explanation, "workspace", "scripts"), { recursive: true });
  writeFileSync(path.join(explanation, "workspace", "scripts", "A_01.R"), "repeat {}\n");
  enter(t, task);

  const tool = runAnalysisTool(t, recordingExec({ code: 124, timedOut: true }).exec);
  const result = await tool.execute("call-1", { script: "A_01.R" });
  assert.match(result.content[0]?.text ?? "", /^exit code 124, timed out\n/);
  assert.deepEqual(result.details, { code: 124, timedOut: true });
});

test("run_analysis refuses another task's script and any script name that is not a bare file name", async (t) => {
  const explanation = analysisNode(t);
  const task = path.join(explanation, "tasks", "A");
  mkdirSync(task, { recursive: true });
  enter(t, task);

  const { exec, calls } = recordingExec();
  const tool = runAnalysisTool(t, exec);
  await assert.rejects(() => tool.execute("call-1", { script: "B_01.R" }), /may run only its own A_nn\.R/);
  await assert.rejects(() => tool.execute("call-2", { script: "../A_01.R" }), /bare file name/);
  await assert.rejects(() => tool.execute("call-3", { script: "A_01.txt" }), /may run only its own/);
  assert.equal(calls.length, 0, "no container was started");
});

test("run_analysis runs a reopen task's own script, and refuses another reopen task's", async (t) => {
  const explanation = analysisNode(t);
  const task = path.join(explanation, "tasks", "R1A");
  mkdirSync(task, { recursive: true });
  mkdirSync(path.join(explanation, "workspace", "scripts"), { recursive: true });
  writeFileSync(path.join(explanation, "workspace", "scripts", "R1A_01.R"), "cat('x')\n");
  enter(t, task);

  const { exec, calls } = recordingExec();
  const tool = runAnalysisTool(t, exec);
  await assert.rejects(() => tool.execute("call-1", { script: "R1B_01.R" }), /may run only its own R1A_nn\.R/);
  assert.equal(calls.length, 0, "no container was started for another task's script");
  await tool.execute("call-2", { script: "R1A_01.R" });
  assert.equal(calls.length, 1, "one container run");
  assert.equal(calls[0]?.args.at(-1), "scripts/R1A_01.R");
});

test("run_analysis refuses in a literature task", async (t) => {
  const explanation = analysisNode(t);
  const task = path.join(explanation, "tasks", "lit-01");
  mkdirSync(task, { recursive: true });
  enter(t, task);

  const { exec, calls } = recordingExec();
  const tool = runAnalysisTool(t, exec);
  await assert.rejects(() => tool.execute("call-1", { script: "A_01.R" }), /lit-01 runs no scripts/);
  assert.equal(calls.length, 0);
});

test("run_analysis refuses outside an explanation's task folder and outside an explanation", async (t) => {
  const explanation = analysisNode(t);
  enter(t, explanation);
  const { exec, calls } = recordingExec();
  const tool = runAnalysisTool(t, exec);
  await assert.rejects(() => tool.execute("call-1", { script: "A_01.R" }), /not inside a task folder/);
  assert.equal(calls.length, 0);
});

test("run_analysis refuses in a pattern node, which is not an explanation", async (t) => {
  const { nodeDir } = patternNode(t);
  mkdirSync(path.join(nodeDir, "tasks", "A"), { recursive: true });
  process.chdir(path.join(nodeDir, "tasks", "A"));

  const { exec, calls } = recordingExec();
  const tool = runAnalysisTool(t, exec);
  await assert.rejects(() => tool.execute("call-1", { script: "A_01.R" }), /explanation analysis tasks only/);
  assert.equal(calls.length, 0);
});

test("run_analysis runs assets.R only for the greatest-lettered task", async (t) => {
  const explanation = analysisNode(t);
  for (const letter of ["A", "B"]) mkdirSync(path.join(explanation, "tasks", letter), { recursive: true });
  mkdirSync(path.join(explanation, "workspace", "scripts"), { recursive: true });
  writeFileSync(path.join(explanation, "workspace", "scripts", "assets.R"), "# assets\n");

  // One restore only: a second t.after would run after the fixture has removed the run.
  const originalCwd = process.cwd();
  t.after(() => process.chdir(originalCwd));
  const { exec, calls } = recordingExec();
  const tool = runAnalysisTool(t, exec);
  process.chdir(path.join(explanation, "tasks", "A"));
  await assert.rejects(() => tool.execute("call-1", { script: "assets.R" }), /may run only its own A_nn\.R/);
  assert.equal(calls.length, 0, "task A is not the last letter");

  process.chdir(path.join(explanation, "tasks", "B"));
  await tool.execute("call-2", { script: "assets.R" });
  assert.equal(calls.length, 1, "task B owns the shared assets script");
  assert.equal(calls[0]?.args.at(-1), "scripts/assets.R");
});

/** quote_source, registered by the worker extension (the tool's test hook is not needed: it reads only the exploration copy). */
function quoteSourceTool(): CapturedTool {
  const { pi, tools } = fakePi();
  workerExtension(pi);
  const tool = tools.get("quote_source");
  assert.ok(tool, "the worker extension registers quote_source");
  return tool;
}

test("the worker extension registers quote_source with path, start and end parameters", () => {
  const tool = quoteSourceTool();
  assert.deepEqual(Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties), ["path", "start", "end"]);
});

test("quote_source refuses in an explanation node, which is not a paper", async (t) => {
  enter(t, explanationNode(t));
  await assert.rejects(() => quoteSourceTool().execute("call-1", { path: "handbook/rules.md", start: 1, end: 2 }), /paper nodes only/);
});

test("quote_source refuses in a pattern node, which is not a paper", async (t) => {
  patternNode(t);
  await assert.rejects(() => quoteSourceTool().execute("call-1", { path: "handbook/rules.md", start: 1, end: 2 }), /paper nodes only/);
});

test("quote_source refuses outside any node folder", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ctc-quote-outside-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  enter(t, dir);
  await assert.rejects(() => quoteSourceTool().execute("call-1", { path: "handbook/rules.md", start: 1, end: 2 }), /not inside a node folder/);
});

test("quote_source in a paper node writes the fragment and returns its include line", async (t) => {
  const paper = paperNode(t);
  const run = findRunDir(paper);
  assert.ok(run, "the paper sits in a run");
  const handbook = path.join(run, "analysis-data", "exploration", "handbook");
  mkdirSync(handbook, { recursive: true });
  writeFileSync(path.join(handbook, "rules.md"), "# Rules\nBe patient.\n");
  const split = path.join(run, "prep", "Z01-profile", "workspace", "split");
  mkdirSync(split, { recursive: true });
  writeFileSync(path.join(split, "holdout.txt"), "");
  enter(t, paper);

  const result = await quoteSourceTool().execute("call-1", { path: "handbook/rules.md", start: 1, end: 2 });
  assert.equal(result.content[0]?.text, "{{< include embeds/quotes/Q01.qmd >}}");
  assert.equal(existsSync(path.join(paper, "workspace", "embeds", "quotes", "Q01.qmd")), true);
});
