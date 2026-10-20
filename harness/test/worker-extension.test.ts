import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import workerExtension from "../worker-extension.ts";
import { createChild, findNode, initRun } from "../tree.ts";

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

/** A run with one pattern node, cwd moved into it for the duration of the test. */
function patternNode(t: TestContext): { run: string; nodeDir: string } {
  const run = mkdtempSync(path.join(tmpdir(), "ctc-preregister-"));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  initRun(run, "data", "interest");
  createChild(run, "D01", "E03 Etiquette", "owner-p1");
  const nodeDir = findNode(run, "T01").dir;
  mkdirSync(path.join(nodeDir, "workspace"), { recursive: true });

  const originalCwd = process.cwd();
  t.after(() => process.chdir(originalCwd));
  process.chdir(nodeDir);
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
