import { execFileSync, spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHILD_DIR,
  CHILD_TYPE,
  CHILD_TYPES,
  PREFIX,
  breakStaleLock,
  commitFile,
  createChild,
  findNode,
  initRun,
  isStaleLock,
  listNodes,
  readRun,
  updateNode,
} from "../tree.ts";

const WRITER = fileURLToPath(new URL("./writer-child.ts", import.meta.url));
const CREATE_CHILD = fileURLToPath(new URL("./create-child.ts", import.meta.url));

function makeRun(t: TestContext): string {
  const runDir = mkdtempSync(path.join(tmpdir(), "ctc-tree-"));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  return runDir;
}

function git(runDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", runDir, ...args], { encoding: "utf8" }).trim();
}

function subjects(runDir: string): string[] {
  return git(runDir, "log", "--format=%s").split("\n").filter((line) => line.length > 0);
}

function stored(runDir: string, relative: string): unknown {
  return JSON.parse(readFileSync(path.join(runDir, relative), "utf8"));
}

function runScript(
  script: string,
  runDir: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, runDir], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ...env },
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

function runWriter(runDir: string): Promise<{ code: number | null; stderr: string }> {
  return runScript(WRITER, runDir);
}

function runCreateChild(runDir: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stderr: string }> {
  return runScript(CREATE_CHILD, runDir, env);
}

/** A pid that is certainly dead: run `node -e ""` to completion and keep its pid. */
function deadPid(): number {
  const dead = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(dead.status, 0, dead.stderr?.toString());
  assert.ok(dead.pid, "the dead process has a pid");
  return dead.pid;
}

/** Leave a lock behind as a crashed holder would: a dir whose recorded pid is dead. */
function staleLock(runDir: string): string {
  const lockDir = path.join(runDir, ".git", "ctc.lock");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(path.join(lockDir, "pid"), String(deadPid()));
  return lockDir;
}

test("the constants describe the node tree", () => {
  assert.deepEqual(CHILD_TYPE, {
    dataset: "pattern",
    pattern: "puzzle",
    puzzle: "explanation",
    explanation: "framing",
    framing: "paper",
  });
  assert.deepEqual(CHILD_TYPES, {
    dataset: ["pattern", "prep"],
    pattern: ["puzzle"],
    puzzle: ["explanation"],
    explanation: ["framing"],
    framing: ["paper"],
  });
  for (const [type, children] of Object.entries(CHILD_TYPES)) {
    assert.equal(CHILD_TYPE[type], children[0], `${type}'s default child type is its first child type`);
  }
  assert.deepEqual(PREFIX, {
    dataset: "D",
    prep: "Z",
    pattern: "T",
    puzzle: "P",
    explanation: "E",
    framing: "F",
    paper: "W",
  });
  assert.equal(CHILD_DIR.prep, "prep", "prep nodes live in prep/");
});

test("initRun stores only the dataset and interest, and makes one commit", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "work on all-remote platforms");

  assert.deepEqual(stored(run, "node.json"), { dataset: "data", interest: "work on all-remote platforms" });
  assert.deepEqual(readRun(run), { dataset: "data", interest: "work on all-remote platforms" });
  assert.deepEqual(readdirSync(run).sort(), [".git", "node.json"], "no event log, no owner folders up front");
  assert.deepEqual(subjects(run), ["[P0:init] D01 — create run"]);
});

test("initRun refuses to overwrite an existing run", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  assert.throws(() => initRun(run, "other", "other"), /already a run/);
  assert.deepEqual(readRun(run), { dataset: "data", interest: "interest" });
});

test("createChild stores only phase and status; id, type, parent and title come from the folder", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");

  const node = createChild(run, "D01", "Self Presentation!", "owner-p1");
  assert.deepEqual(stored(run, "patterns/T01-self-presentation/node.json"), { phase: 1, status: "ready" });
  assert.equal(node.id, "T01");
  assert.equal(node.type, "pattern");
  assert.equal(node.title, "self-presentation");
  assert.equal(node.parent, "D01");
  assert.equal(node.dir, path.join(run, "patterns", "T01-self-presentation"));

  assert.equal(subjects(run)[0], "[P1:createChild] T01 — Self Presentation!");
  assert.equal(git(run, "log", "-1", "--format=%an"), "owner-p1", "the actor is the commit author");
});

test("createChild makes a phase-0 prep node under the dataset", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");

  const node = createChild(run, "D01", "Profile", "owner-p0", [], "prep");
  assert.deepEqual(stored(run, "prep/Z01-profile/node.json"), { phase: 0, status: "ready" });
  assert.equal(node.id, "Z01");
  assert.equal(node.type, "prep");
  assert.equal(node.phase, 0);
  assert.equal(node.title, "profile");
  assert.equal(node.parent, "D01");
  assert.equal(node.dir, path.join(run, "prep", "Z01-profile"));
  assert.equal(subjects(run)[0], "[P0:createChild] Z01 — Profile");
  assert.equal(git(run, "log", "-1", "--format=%an"), "owner-p0", "the actor is the commit author");

  const listed = listNodes(run).find((candidate) => candidate.id === "Z01");
  assert.equal(listed?.type, "prep", "listNodes reads the type from the Z prefix");
  assert.equal(listed?.parent, "D01");

  assert.equal(createChild(run, "D01", "Second", "t", [], "prep").id, "Z02", "prep ids count per type");
  assert.equal(createChild(run, "D01", "Pattern", "t").id, "T01", "the default child type is unchanged");
});

test("createChild refuses a child type the parent cannot have", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  createChild(run, "D01", "One", "t");
  const prep = createChild(run, "D01", "Profile", "t", [], "prep");
  const before = subjects(run).length;

  assert.throws(
    () => createChild(run, "T01", "x", "t", [], "prep"),
    /Node type pattern cannot have prep children/,
  );
  assert.throws(
    () => createChild(run, "D01", "x", "t", [], "puzzle"),
    /Node type dataset cannot have puzzle children/,
  );
  assert.throws(() => createChild(run, prep.id, "x", "t"), /Node type prep has no children/);
  assert.equal(subjects(run).length, before, "a refused create makes no commit");
  assert.deepEqual(
    listNodes(run).map((node) => node.id),
    ["D01", "T01", "Z01"],
    "a refused create writes no folder",
  );
});

test("the ID counter is per type across the whole run", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  createChild(run, "D01", "First", "t");
  assert.equal(createChild(run, "D01", "Second", "t").id, "T02");
});

test("children nest under their parent and keep its phase", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  createChild(run, "D01", "Self Presentation!", "t");
  updateNode(run, "T01", { phase: 2 }, "t");

  const puzzle = createChild(run, "T01", "Why?", "t");
  assert.equal(puzzle.id, "P01");
  assert.equal(puzzle.type, "puzzle");
  assert.equal(puzzle.parent, "T01");
  assert.equal(puzzle.phase, 2);
  assert.ok(existsSync(path.join(run, "patterns", "T01-self-presentation", "puzzles", "P01-why", "node.json")));
});

test("derivedFrom is stored only for forks", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  createChild(run, "D01", "First", "t");
  createChild(run, "D01", "Fork", "t", ["T01"]);

  assert.deepEqual(stored(run, "patterns/T02-fork/node.json"), { phase: 1, status: "ready", derivedFrom: ["T01"] });
  updateNode(run, "T02", { status: "active" }, "t");
  assert.deepEqual(findNode(run, "T02").derivedFrom, ["T01"], "updates keep derivedFrom");
});

test("slugs are lowercase, hyphenated, at most 40 characters", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");

  const long = createChild(run, "D01", "  A  Very Long TITLE!!! That Keeps Going And Going  ", "t");
  assert.match(path.basename(long.dir), /^T01-[a-z0-9-]+$/);
  assert.ok(long.title.length <= 40, long.title);
  assert.equal(path.basename(createChild(run, "D01", "!!!", "t").dir), "T02-untitled");
  assert.equal(path.basename(createChild(run, "D01", "Étude — Café", "t").dir), "T03-etude-cafe");
});

test("updateNode changes status and phase, and puts the note in the commit body", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  createChild(run, "D01", "Self Presentation!", "t");

  const node = updateNode(run, "T01", { status: "submitted", phase: 2 }, "owner-p1", "handed on to phase 2");
  assert.equal(node.status, "submitted");
  assert.equal(node.phase, 2);
  assert.deepEqual(stored(run, "patterns/T01-self-presentation/node.json"), { phase: 2, status: "submitted" });
  assert.equal(subjects(run)[0], "[P2:updateNode] T01 — status submitted, phase 2, note");
  assert.equal(git(run, "log", "-1", "--format=%b"), "handed on to phase 2");
});

test("the dataset root cannot be updated", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  assert.throws(() => updateNode(run, "D01", { status: "active" }, "t"), /dataset root/);
});

test("findNode throws for unknown ids; the root is D01", (t) => {
  const run = makeRun(t);
  initRun(run, "/somewhere/mini-dataset", "interest");
  const root = findNode(run, "D01");
  assert.equal(root.type, "dataset");
  assert.equal(root.title, "mini-dataset");
  assert.throws(() => findNode(run, "X9"), /Unknown node X9/);
});

test("listNodes only reads node folders, never workspace, .git or owners", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  createChild(run, "D01", "One", "t");

  for (const decoy of ["patterns/T01-one/workspace/patterns/T09-decoy", "owners/patterns/T08-decoy", "patterns/not-a-node"]) {
    mkdirSync(path.join(run, decoy), { recursive: true });
    writeFileSync(path.join(run, decoy, "node.json"), JSON.stringify({ phase: 1, status: "ready" }));
  }
  assert.deepEqual(
    listNodes(run).map((node) => node.id),
    ["D01", "T01"],
  );
});

test("an absent lock is not stale and is never broken", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  const lockDir = path.join(run, ".git", "ctc.lock");

  assert.equal(isStaleLock(lockDir), false, "a missing lock dir is not a stale lock");
  assert.equal(breakStaleLock(lockDir), false, "there is nothing to break and nothing to own");
  assert.equal(existsSync(lockDir), false, "breaking an absent lock does not create a lock");
  assert.equal(existsSync(`${lockDir}.breaker`), false, "the breaker is released");
});

test("breaking a stale lock leaves the breaker holding it", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  const lockDir = staleLock(run);

  assert.equal(breakStaleLock(lockDir), true, "a stale lock is broken");
  assert.equal(existsSync(lockDir), true, "the breaker owns the lock it created");
  assert.equal(readFileSync(path.join(lockDir, "pid"), "utf8"), String(process.pid), "the new lock names the breaker holder");
  assert.equal(existsSync(`${lockDir}.breaker`), false, "the breaker is released");
});

test("a stale lock is broken and the next writer proceeds", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  const lockDir = staleLock(run);

  const started = Date.now();
  const node = createChild(run, "D01", "After the crash", "t");
  assert.equal(node.id, "T01");
  assert.ok(Date.now() - started < 2000, "a stale lock does not cost the 30 s timeout");
  assert.equal(existsSync(lockDir), false, "the lock is released after the write");
});

test("two writers break the same stale lock only once", async (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  const lockDir = staleLock(run);

  const [first, second] = await Promise.all([runWriter(run), runWriter(run)]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);

  const ids = listNodes(run).filter((node) => node.type === "pattern").map((node) => node.id).sort();
  assert.deepEqual(ids, Array.from({ length: 20 }, (_, index) => `T${String(index + 1).padStart(2, "0")}`));
  assert.equal(Number(git(run, "rev-list", "--count", "HEAD")), 21);
  assert.equal(git(run, "status", "--porcelain"), "", "every write was committed");
  assert.equal(existsSync(lockDir), false, "the stale lock is gone once both writers are done");
});

test("a live lock is respected until the timeout", async (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  const lockDir = path.join(run, ".git", "ctc.lock");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(path.join(lockDir, "pid"), String(process.pid));

  const failed = await runCreateChild(run, { CTC_LOCK_TIMEOUT_MS: "1500" });
  assert.notEqual(failed.code, 0, "the child could not take a live lock");
  assert.match(failed.stderr, /Could not acquire/);
  assert.equal(existsSync(lockDir), true, "a live lock is not stolen");
});

test("no lock or pid files are ever committed", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  createChild(run, "D01", "One", "t");

  assert.deepEqual(
    git(run, "ls-files").split("\n").filter((file) => file.includes("lock")),
    [],
    "the lock lives inside .git and is never tracked",
  );
});

test("parallel writers: 20 nodes and 21 commits, no lost writes", async (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");

  const [first, second] = await Promise.all([runWriter(run), runWriter(run)]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);

  const ids = listNodes(run).filter((node) => node.type === "pattern").map((node) => node.id).sort();
  assert.deepEqual(ids, Array.from({ length: 20 }, (_, index) => `T${String(index + 1).padStart(2, "0")}`));
  assert.equal(Number(git(run, "rev-list", "--count", "HEAD")), 21);
  assert.equal(git(run, "status", "--porcelain"), "", "every write was committed");
});

test("commitFile commits only its own path and leaves another node's file untracked", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  createChild(run, "D01", "One", "owner-p1");
  createChild(run, "D01", "Two", "owner-p1");
  const mine = path.join(run, "patterns", "T01-one", "workspace");
  const theirs = path.join(run, "patterns", "T02-two", "workspace");
  mkdirSync(mine, { recursive: true });
  mkdirSync(theirs, { recursive: true });
  writeFileSync(path.join(mine, "measure.md"), "# Measure\n");
  writeFileSync(path.join(theirs, "measure.md"), "half-written by another worker\n");

  const sha = commitFile(run, "patterns/T01-one/workspace/measure.md", "worker-T01", "[P1:preregister] T01 — measure.md");
  assert.match(sha, /^[0-9a-f]{7,}$/);
  assert.equal(sha, git(run, "rev-parse", "--short", "HEAD"), "the short sha of the new commit is returned");
  assert.equal(git(run, "log", "-1", "--format=%s"), "[P1:preregister] T01 — measure.md");
  assert.equal(git(run, "log", "-1", "--format=%an"), "worker-T01", "the actor authors the commit");
  assert.deepEqual(
    git(run, "show", "--name-only", "--format=", "HEAD").split("\n").filter((line) => line.length > 0),
    ["patterns/T01-one/workspace/measure.md"],
    "only the given path is in the commit",
  );
  assert.match(
    git(run, "status", "--porcelain"),
    /^\?\? patterns\/T02-two\/workspace\/$/m,
    "the other node's file stays untracked",
  );
});

test("commitFile marks an unchanged file with an empty commit", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  createChild(run, "D01", "One", "owner-p1");
  const measure = path.join(run, "patterns", "T01-one", "workspace", "measure.md");
  mkdirSync(path.dirname(measure), { recursive: true });
  writeFileSync(measure, "# Measure\n");
  // A tree operation commits with `git add -A`, so the file is already tracked.
  createChild(run, "D01", "Two", "owner-p1");
  const before = Number(git(run, "rev-list", "--count", "HEAD"));

  commitFile(run, "patterns/T01-one/workspace/measure.md", "worker-T01", "[P1:preregister] T01 — measure.md");
  assert.equal(Number(git(run, "rev-list", "--count", "HEAD")), before + 1, "the marker commit exists");
  assert.equal(git(run, "log", "-1", "--format=%s"), "[P1:preregister] T01 — measure.md");
  assert.equal(git(run, "show", "--name-only", "--format=", "HEAD"), "", "the marker commit changes no file");
});

test("commitFile throws only when the file does not exist", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  const before = subjects(run).length;
  assert.throws(
    () => commitFile(run, "patterns/T01-one/workspace/measure.md", "worker-T01", "[P1:preregister] T01 — measure.md"),
    /does not exist/,
  );
  assert.equal(subjects(run).length, before, "a refused commit makes no commit");
});
