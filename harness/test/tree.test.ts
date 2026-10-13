import { execFileSync, spawn } from "node:child_process";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHILD_TYPE,
  PREFIX,
  createChild,
  findNode,
  initRun,
  listNodes,
  updateNode,
  type Node,
  type NodeRef,
} from "../tree.ts";

const WRITER = fileURLToPath(new URL("./writer-child.ts", import.meta.url));

function makeRun(t: TestContext): string {
  const runDir = mkdtempSync(path.join(tmpdir(), "ctc-tree-"));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  return runDir;
}

function git(runDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", runDir, ...args], { encoding: "utf8" }).trim();
}

function subjects(runDir: string): string[] {
  return git(runDir, "log", "--format=%s")
    .split("\n")
    .filter((line) => line.length > 0);
}

function readNode(runDir: string, relative: string): Node {
  return JSON.parse(readFileSync(path.join(runDir, relative), "utf8")) as Node;
}

function refOf(runDir: string, id: string): NodeRef {
  const found = listNodes(runDir).find((entry) => entry.node.id === id);
  assert.ok(found, `node ${id} not found`);
  return found;
}

function runWriter(runDir: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRITER, runDir], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("the constants describe the node tree", () => {
  assert.deepEqual(CHILD_TYPE, {
    dataset: "pattern",
    pattern: "puzzle",
    puzzle: "explanation",
    explanation: "framing",
    framing: "paper",
  });
  assert.deepEqual(PREFIX, {
    dataset: "D",
    pattern: "T",
    puzzle: "P",
    explanation: "E",
    framing: "F",
    paper: "W",
  });
});

test("initRun creates the root dataset node, owners and one commit", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "work on all-remote platforms");

  const node = readNode(run, "node.json");
  assert.deepEqual(node, {
    id: "D01",
    type: "dataset",
    phase: 0,
    status: "ready",
    parent: null,
    derivedFrom: [],
    title: "data",
    card: { dataset: "data", interest: "work on all-remote platforms" },
    runIds: [],
  });

  assert.ok(existsSync(path.join(run, "events.jsonl")));
  const events = readFileSync(path.join(run, "events.jsonl"), "utf8").trim().split("\n");
  assert.equal(events.length, 1);
  const initEvent = JSON.parse(events[0]) as Record<string, unknown>;
  assert.equal(initEvent.op, "init");
  assert.equal(initEvent.nodeId, "D01");

  for (let phase = 0; phase <= 5; phase++) {
    assert.ok(
      existsSync(path.join(run, "owners", `phase-${phase}`, "ledger.md")),
      `owners/phase-${phase}/ledger.md missing`,
    );
  }

  const commits = subjects(run);
  assert.equal(commits.length, 1);
  assert.equal(commits[0], "[P0:init] D01 — create run");
});

test("createChild creates T01 under the dataset with the right slug and commit", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");

  const node = createChild(run, "D01", "Self Presentation!", {}, "t");
  assert.equal(node.id, "T01");
  assert.equal(node.type, "pattern");
  assert.equal(node.phase, 1);
  assert.equal(node.status, "ready");
  assert.equal(node.parent, "D01");
  assert.deepEqual(node.derivedFrom, []);
  assert.deepEqual(node.runIds, []);

  const relative = "patterns/T01-self-presentation/node.json";
  assert.ok(existsSync(path.join(run, relative)));
  assert.deepEqual(readNode(run, relative), node);
  assert.equal(refOf(run, "T01").dir, path.join(run, "patterns", "T01-self-presentation"));

  assert.equal(subjects(run)[0], "[P1:createChild] T01 — Self Presentation!");
});

test("the ID counter is per type across the whole run", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");

  createChild(run, "D01", "First", {}, "t");
  const second = createChild(run, "D01", "Second", {}, "t");
  assert.equal(second.id, "T02");
  assert.ok(existsSync(path.join(run, "patterns", "T02-second", "node.json")));
});

test("createChild under a pattern nests a puzzle and keeps the parent phase", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  createChild(run, "D01", "Self Presentation!", {}, "t");

  const puzzle = createChild(run, "T01", "Why?", {}, "t");
  assert.equal(puzzle.id, "P01");
  assert.equal(puzzle.type, "puzzle");
  assert.equal(puzzle.phase, 1);
  assert.equal(puzzle.parent, "T01");
  assert.ok(
    existsSync(
      path.join(run, "patterns", "T01-self-presentation", "puzzles", "P01-why", "node.json"),
    ),
  );
});

test("createChild records derivedFrom", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  createChild(run, "D01", "First", {}, "t");

  const second = createChild(run, "D01", "Fork", {}, "t", ["T01"]);
  assert.deepEqual(second.derivedFrom, ["T01"]);
  assert.deepEqual(readNode(run, "patterns/T02-fork/node.json").derivedFrom, ["T01"]);
});

test("slugs are lowercase, hyphenated, at most 40 characters", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");

  const long = createChild(
    run,
    "D01",
    "  A  Very Long TITLE!!! That Keeps Going And Going  ",
    {},
    "t",
  );
  const longFolder = path.basename(refOf(run, long.id).dir);
  assert.match(longFolder, /^T01-[a-z0-9-]+$/);
  assert.ok(longFolder.slice("T01-".length).length <= 40, longFolder);

  const empty = createChild(run, "D01", "!!!", {}, "t");
  assert.equal(path.basename(refOf(run, empty.id).dir), "T02-untitled");

  const accented = createChild(run, "D01", "Étude — Café", {}, "t");
  assert.equal(path.basename(refOf(run, accented.id).dir), "T03-etude-cafe");
});

test("updateNode patches fields, pushes runId and commits", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  createChild(run, "D01", "Self Presentation!", {}, "t");

  const node = updateNode(run, "T01", { status: "active", runId: "r1" }, "t");
  assert.equal(node.status, "active");
  assert.deepEqual(node.runIds, ["r1"]);
  assert.equal(node.phase, 1);

  const stored = readNode(run, "patterns/T01-self-presentation/node.json");
  assert.equal(stored.status, "active");
  assert.deepEqual(stored.runIds, ["r1"]);

  assert.match(subjects(run)[0], /^\[P1:updateNode\] T01 —/);
});

test("updateNode can move a node to the next phase", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  createChild(run, "D01", "Self Presentation!", {}, "t");

  const node = updateNode(run, "T01", { phase: 2, note: "handed on" }, "t");
  assert.equal(node.phase, 2);
  assert.equal(node.note, "handed on");
  assert.equal(readNode(run, "patterns/T01-self-presentation/node.json").phase, 2);
  assert.match(subjects(run)[0], /^\[P2:updateNode\] T01 —/);
});

test("findNode throws for unknown ids", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");

  assert.equal(findNode(run, "D01").node.type, "dataset");
  assert.throws(() => findNode(run, "X9"), /Unknown node X9/);
});

test("listNodes walks the tree and skips workspace, .git and owners", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  createChild(run, "D01", "One", {}, "t");

  const decoy = path.join(run, "patterns", "T01-one", "workspace", "decoy");
  mkdirSync(decoy, { recursive: true });
  writeFileSync(
    path.join(decoy, "node.json"),
    JSON.stringify({ id: "HACK", type: "pattern" }),
  );

  const ids = listNodes(run).map((entry) => entry.node.id);
  assert.deepEqual(ids, ["D01", "T01"]);
});

test("parallel writers: 20 nodes, 21 consistent events and 21 commits", async (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");

  const [first, second] = await Promise.all([runWriter(run), runWriter(run)]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);

  const patterns = listNodes(run).filter((entry) => entry.node.type === "pattern");
  assert.deepEqual(
    patterns.map((entry) => entry.node.id).sort(),
    Array.from({ length: 20 }, (_, index) => `T${String(index + 1).padStart(2, "0")}`),
  );

  const lines = readFileSync(path.join(run, "events.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 21);
  for (const line of lines) {
    const event = JSON.parse(line) as Record<string, unknown>;
    assert.equal(typeof event.at, "string");
    assert.equal(typeof event.op, "string");
    assert.equal(typeof event.nodeId, "string");
    assert.equal(typeof event.phase, "number");
    assert.equal(typeof event.actor, "string");
    assert.equal(typeof event.data, "object");
  }

  assert.equal(Number(git(run, "rev-list", "--count", "HEAD")), 21);
});
