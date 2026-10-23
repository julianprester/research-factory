// explain/reproduce.ts: the registry comparison, the workspace hash and the
// resumable reproduction. Nothing here runs docker: runScript takes the fake
// Exec below, which writes registry files into the output folder it is mounted
// on, the way an analysis script would.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  compareRegistries,
  readRegistry,
  reproduceWorkspace,
  scriptOrder,
  workspaceHash,
  type Row,
} from "../explain/reproduce.ts";
import { type Exec } from "../analysis/run.ts";
import { initRun } from "../tree.ts";

const DATASET_FILES: Record<string, string> = {
  "data/a.csv": "a,1\n",
  "data/sub/b.csv": "b,2\n",
  "data/holdout-x.csv": "secret\n",
};

const NODE = "E01-demo";

function git(runDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", runDir, "-c", "user.name=test", "-c", "user.email=test@ctc.local", ...args], {
    encoding: "utf8",
  }).trim();
}

/** A committed run with split lists, as the analysis tests make one. */
function makeRun(t: TestContext): string {
  const root = mkdtempSync(path.join(tmpdir(), "ctc-reproduce-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataset = path.join(root, "dataset");
  for (const [rel, text] of Object.entries(DATASET_FILES)) {
    mkdirSync(path.dirname(path.join(dataset, rel)), { recursive: true });
    writeFileSync(path.join(dataset, rel), text);
  }
  const runDir = path.join(root, "run");
  initRun(runDir, dataset, "interest");
  const split = path.join(runDir, "prep", "Z01-profile", "workspace", "split");
  mkdirSync(split, { recursive: true });
  writeFileSync(path.join(split, "exploration.txt"), "data/a.csv\ndata/sub/b.csv\n");
  writeFileSync(path.join(split, "holdout.txt"), "data/holdout-x.csv\n");
  git(runDir, "add", "-A");
  git(runDir, "commit", "-m", "split lists");
  return runDir;
}

/**
 * An explanation node: its scripts, its argument, and the registry files its
 * output/numbers holds (`real`, the owner's own run).
 */
function makeNode(runDir: string, scripts: string[], real: Record<string, string> = {}): string {
  const nodeDir = path.join(runDir, "explanations", NODE);
  const workspace = path.join(nodeDir, "workspace");
  mkdirSync(path.join(workspace, "scripts"), { recursive: true });
  for (const name of scripts) writeFileSync(path.join(workspace, "scripts", name), `# ${name}\n`);
  writeFileSync(path.join(workspace, "argument.md"), "# Argument\n");
  writeRegistry(path.join(workspace, "output"), real);
  return nodeDir;
}

/** Write `files` (file name → text) into `<output>/numbers/`. */
function writeRegistry(output: string, files: Record<string, string>): void {
  mkdirSync(path.join(output, "numbers"), { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(output, "numbers", file), text);
}

/** The section a script writes: `A_01.R` writes `A.csv`. */
function sectionOf(script: string): string {
  return `${script[0]}.csv`;
}

/** A seeded generator (mulberry32): the same seed gives the same sequence. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface FakeRuns {
  exec: Exec;
  /** Every run, in order: the script and the host folder it wrote into. */
  calls: Array<{ script: string; host: string }>;
}

/**
 * A fake Exec. For each run it finds the output mount (`-v <host>:/work/output`),
 * writes `produce(script, n)` (file name → text, `n` counting every run so far)
 * into `<host>/numbers/`, and exits with `exitCode(script)` (default 0). `delayMs`
 * makes each run take that long, for the budget tests.
 */
function fakeRuns(
  produce: (script: string, n: number) => Record<string, string>,
  options: { exitCode?: (script: string) => number; delayMs?: number } = {},
): FakeRuns {
  const calls: FakeRuns["calls"] = [];
  const exec: Exec = async (args) => {
    const mount = args.flatMap((arg, i) => (args[i - 1] === "-v" && arg.endsWith(":/work/output") ? [arg] : []))[0];
    if (mount === undefined) throw new Error("no output mount");
    const host = mount.slice(0, -":/work/output".length);
    const script = (args.at(-1) ?? "").replace(/^scripts\//, "");
    calls.push({ script, host });
    if (options.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    writeRegistry(host, produce(script, calls.length));
    return { code: options.exitCode?.(script) ?? 0, stdout: "", stderr: "", timedOut: false };
  };
  return { exec, calls };
}

/** The same deterministic registry for every run. */
const deterministic = (script: string): Record<string, string> => ({
  [sectionOf(script)]: 'name,value,note\ncount,1234,"a, note"\nshare,0.25,\n',
});

const DETERMINISTIC_A = deterministic("A_01.R")["A.csv"] ?? "";
const DETERMINISTIC_B = deterministic("B_01.R")["B.csv"] ?? "";

/** A seeded run: each run draws from a fresh generator with the same seed. */
const seededRun = (script: string): Record<string, string> => {
  const draw = seeded(7);
  return { [sectionOf(script)]: `name,value,note\nshare,${draw().toFixed(12)},\n` };
};

/** A run whose value depends on the run number: it differs every time. */
const drifting = (script: string, n: number): Record<string, string> => ({
  [sectionOf(script)]: `name,value,note\nn,${n},\n`,
});

function statePathOf(runDir: string): string {
  return path.join(runDir, "owners", "phase-3", "loop", NODE, "reproduction-state.json");
}

function rows(pairs: Array<[string, string]>): Row[] {
  return pairs.map(([name, value]) => ({ name, value }));
}

test("compareRegistries: equal registries have no mismatch", () => {
  const registry = { "A.csv": rows([["n", "1234"], ["label", "x"]]) };
  assert.deepEqual(compareRegistries(registry, structuredClone(registry)), []);
});

test("compareRegistries: an integer that differs by one is flagged", () => {
  const mismatches = compareRegistries({ "A.csv": rows([["n", "1234"]]) }, { "A.csv": rows([["n", "1235"]]) });
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0] ?? "", /A\.csv "n": 1234 vs 1235/);
});

test("compareRegistries: floats within the relative tolerance are equal, beyond it flagged", () => {
  const same = compareRegistries({ "A.csv": rows([["x", "0.123456789"]]) }, { "A.csv": rows([["x", "0.123456790"]]) });
  assert.deepEqual(same, []);
  const far = compareRegistries({ "A.csv": rows([["x", "0.123456789"]]) }, { "A.csv": rows([["x", "0.1235"]]) });
  assert.equal(far.length, 1);
});

test("compareRegistries: the tolerance argument is honoured", () => {
  const a = { "A.csv": rows([["x", "1.0"]]) };
  const b = { "A.csv": rows([["x", "1.05"]]) };
  assert.equal(compareRegistries(a, b).length, 1, "default tolerance 1e-6 flags a 5% difference");
  assert.deepEqual(compareRegistries(a, b, 0.1), []);
});

test("compareRegistries: text must match exactly", () => {
  const mismatches = compareRegistries({ "A.csv": rows([["label", "a"]]) }, { "A.csv": rows([["label", "b"]]) });
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0] ?? "", /A\.csv "label"/);
});

test("compareRegistries: a file on one side only, and a name on one side only, are flagged", () => {
  const fileOnly = compareRegistries({ "A.csv": rows([["n", "1"]]) }, {});
  assert.equal(fileOnly.length, 1);
  assert.match(fileOnly[0] ?? "", /A\.csv/);

  const nameOnly = compareRegistries({ "A.csv": rows([["n", "1"], ["m", "2"]]) }, { "A.csv": rows([["n", "1"]]) });
  assert.equal(nameOnly.length, 1);
  assert.match(nameOnly[0] ?? "", /A\.csv "m"/);
});

test("readRegistry parses quoted fields, doubled quotes and embedded newlines", (t) => {
  const output = path.join(makeRun(t), "scratch-output");
  writeRegistry(output, {
    "A.csv": 'name,value,note\n"a, b",1,"two\nlines"\n"say ""hi""",2.5,\n',
  });
  assert.deepEqual(readRegistry(output), {
    "A.csv": [
      { name: "a, b", value: "1" },
      { name: 'say "hi"', value: "2.5" },
    ],
  });
});

test("readRegistry refuses a link and a non-regular file, naming them", (t) => {
  const output = path.join(makeRun(t), "scratch-output");
  writeRegistry(output, { "A.csv": "name,value,note\nn,1,\n" });
  symlinkSync(path.join(output, "numbers", "A.csv"), path.join(output, "numbers", "B.csv"));
  assert.throws(() => readRegistry(output), /B\.csv.*link/);
  rmSync(path.join(output, "numbers", "B.csv"));
  mkdirSync(path.join(output, "numbers", "C.csv"));
  assert.throws(() => readRegistry(output), /C\.csv/);
});

test("readRegistry refuses a numbers folder that is a link", (t) => {
  const root = makeRun(t);
  const elsewhere = path.join(root, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(path.join(elsewhere, "A.csv"), "name,value,note\nn,1,\n");
  const output = path.join(root, "linked-output");
  mkdirSync(output);
  symlinkSync(elsewhere, path.join(output, "numbers"));
  assert.throws(() => readRegistry(output), /numbers.*link/);
});

test("workspaceHash changes on a script edit and on a number edit, not on argument.md", (t) => {
  const runDir = makeRun(t);
  const nodeDir = makeNode(runDir, ["A_01.R"], { "A.csv": "name,value,note\nn,1,\n" });
  const workspace = path.join(nodeDir, "workspace");
  const before = workspaceHash(nodeDir);
  assert.match(before, /^[0-9a-f]{64}$/);
  assert.equal(workspaceHash(nodeDir), before, "stable on a second call");

  writeFileSync(path.join(workspace, "argument.md"), "# Changed argument\n");
  assert.equal(workspaceHash(nodeDir), before, "argument.md is not hashed");

  writeFileSync(path.join(workspace, "scripts", "A_01.R"), "# edited\n");
  const afterScript = workspaceHash(nodeDir);
  assert.notEqual(afterScript, before);

  writeFileSync(path.join(workspace, "output", "numbers", "A.csv"), "name,value,note\nn,2,\n");
  assert.notEqual(workspaceHash(nodeDir), afterScript);
});

test("workspaceHash refuses a link in the registry folder rather than reading through it", (t) => {
  const runDir = makeRun(t);
  const nodeDir = makeNode(runDir, ["A_01.R"], { "A.csv": "name,value,note\nn,1,\n" });
  const numbers = path.join(nodeDir, "workspace", "output", "numbers");
  symlinkSync(path.join(numbers, "A.csv"), path.join(numbers, "L.csv"));
  assert.throws(() => workspaceHash(nodeDir), /L\.csv.*link/);
});

test("scriptOrder sorts by letter, then number, with assets last", () => {
  assert.deepEqual(scriptOrder(["B_01.R", "A_02.py", "assets.R", "A_01.R"]), ["A_01.R", "A_02.py", "B_01.R", "assets.R"]);
});

test("reproduceWorkspace: a deterministic workspace reproduces (ok true) and runs in a scratch folder", async (t) => {
  const runDir = makeRun(t);
  const scripts = ["A_01.R", "B_01.R"];
  const nodeDir = makeNode(runDir, scripts, { "A.csv": DETERMINISTIC_A, "B.csv": DETERMINISTIC_B });
  const { exec, calls } = fakeRuns(deterministic);

  const result = await reproduceWorkspace({
    runDir,
    nodeDir,
    image: "ctc-analysis:1",
    timeoutMs: 5000,
    budgetMs: 60_000,
    exec,
    statePath: statePathOf(runDir),
  });

  assert.deepEqual(result, { complete: true, ok: true, mismatches: [], workspaceHash: workspaceHash(nodeDir) });
  assert.deepEqual(calls.map((call) => call.script), scripts);
  const scratch = path.join(runDir, ".analysis", "repro", NODE, "workspace", "output");
  assert.ok(calls.every((call) => call.host === scratch), "every run writes to the scratch output, not the real one");
  assert.equal(existsSync(path.join(scratch, "numbers", "A.csv")), true);
});

test("reproduceWorkspace: a seeded workspace reproduces when every run draws from the same seed", async (t) => {
  const runDir = makeRun(t);
  const scripts = ["A_01.R", "B_01.R"];
  const nodeDir = makeNode(runDir, scripts, { ...seededRun("A_01.R"), ...seededRun("B_01.R") });
  const result = await reproduceWorkspace({
    runDir,
    nodeDir,
    image: "ctc-analysis:1",
    timeoutMs: 5000,
    budgetMs: 60_000,
    exec: fakeRuns(seededRun).exec,
    statePath: statePathOf(runDir),
  });
  assert.equal(result.ok, true, result.mismatches.join("\n"));
  assert.deepEqual(result.mismatches, []);
});

test("reproduceWorkspace: a non-deterministic workspace fails (ok false), naming the file and key", async (t) => {
  const runDir = makeRun(t);
  const nodeDir = makeNode(runDir, ["A_01.R"], { "A.csv": "name,value,note\nn,0,\n" });
  const result = await reproduceWorkspace({
    runDir,
    nodeDir,
    image: "ctc-analysis:1",
    timeoutMs: 5000,
    budgetMs: 60_000,
    exec: fakeRuns(drifting).exec,
    statePath: statePathOf(runDir),
  });
  assert.equal(result.complete, true);
  assert.equal(result.ok, false);
  assert.ok(result.mismatches.some((line) => /A\.csv "n"/.test(line)), result.mismatches.join("\n"));
});

test("reproduceWorkspace: budget 0 runs nothing and is incomplete; a second call finishes, running each script once", async (t) => {
  const runDir = makeRun(t);
  const scripts = ["A_01.R", "B_01.R"];
  const nodeDir = makeNode(runDir, scripts, { "A.csv": DETERMINISTIC_A, "B.csv": DETERMINISTIC_B });
  const { exec, calls } = fakeRuns(deterministic);
  const common = { runDir, nodeDir, image: "ctc-analysis:1", timeoutMs: 5000, exec, statePath: statePathOf(runDir) };

  const first = await reproduceWorkspace({ ...common, budgetMs: 0 });
  assert.equal(first.complete, false);
  assert.equal(first.ok, false);
  assert.equal(calls.length, 0);

  const second = await reproduceWorkspace({ ...common, budgetMs: 60_000 });
  assert.equal(second.complete, true);
  assert.equal(second.ok, true);
  assert.deepEqual(calls.map((call) => call.script), scripts);

  const third = await reproduceWorkspace({ ...common, budgetMs: 60_000 });
  assert.equal(third.ok, true);
  assert.equal(calls.length, 2, "a finished reproduction does not run anything again");
});

test("reproduceWorkspace: a budget spent after one script resumes at the next and does not re-run the first", async (t) => {
  const runDir = makeRun(t);
  const scripts = ["A_01.R", "B_01.R"];
  const nodeDir = makeNode(runDir, scripts, { "A.csv": DETERMINISTIC_A, "B.csv": DETERMINISTIC_B });
  const slow = fakeRuns(deterministic, { delayMs: 250 });
  const common = { runDir, nodeDir, image: "ctc-analysis:1", timeoutMs: 5000, statePath: statePathOf(runDir) };

  const first = await reproduceWorkspace({ ...common, budgetMs: 100, exec: slow.exec });
  assert.equal(first.complete, false);
  assert.deepEqual(slow.calls.map((call) => call.script), ["A_01.R"]);
  assert.deepEqual(JSON.parse(readFileSync(statePathOf(runDir), "utf8")), { done: ["A_01.R"], failed: {} });

  const fast = fakeRuns(deterministic);
  const second = await reproduceWorkspace({ ...common, budgetMs: 60_000, exec: fast.exec });
  assert.equal(second.complete, true);
  assert.equal(second.ok, true);
  assert.deepEqual(fast.calls.map((call) => call.script), ["B_01.R"]);
});

test("reproduceWorkspace: a failed script stays failed on resume, is not re-run, and keeps ok false", async (t) => {
  const runDir = makeRun(t);
  const scripts = ["A_01.R", "B_01.R"];
  const nodeDir = makeNode(runDir, scripts, { "A.csv": DETERMINISTIC_A, "B.csv": DETERMINISTIC_B });
  const failing = fakeRuns(deterministic, { exitCode: (script) => (script === "B_01.R" ? 2 : 0) });
  const common = { runDir, nodeDir, image: "ctc-analysis:1", timeoutMs: 5000, budgetMs: 60_000, statePath: statePathOf(runDir) };

  const first = await reproduceWorkspace({ ...common, exec: failing.exec });
  assert.equal(first.complete, true);
  assert.equal(first.ok, false);
  assert.match(first.mismatches.join("\n"), /B_01\.R.*exit code 2/);
  assert.deepEqual(JSON.parse(readFileSync(statePathOf(runDir), "utf8")), {
    done: ["A_01.R"],
    failed: { "B_01.R": "exit code 2" },
  });

  const again = fakeRuns(deterministic);
  const second = await reproduceWorkspace({ ...common, exec: again.exec });
  assert.equal(second.complete, true);
  assert.equal(second.ok, false, "a failed script keeps the reproduction failed");
  assert.deepEqual(again.calls.map((call) => call.script), [], "neither script is re-run");
});

test("reproduceWorkspace: a script edited between calls starts the reproduction again", async (t) => {
  const runDir = makeRun(t);
  const nodeDir = makeNode(runDir, ["A_01.R"], { "A.csv": DETERMINISTIC_A });
  const common = { runDir, nodeDir, image: "ctc-analysis:1", timeoutMs: 5000, budgetMs: 60_000, statePath: statePathOf(runDir) };
  const first = fakeRuns(deterministic);
  await reproduceWorkspace({ ...common, exec: first.exec });
  assert.equal(first.calls.length, 1);

  writeFileSync(path.join(nodeDir, "workspace", "scripts", "A_01.R"), "# edited\n");
  const second = fakeRuns(deterministic);
  const result = await reproduceWorkspace({ ...common, exec: second.exec });
  assert.deepEqual(second.calls.map((call) => call.script), ["A_01.R"], "the edited script runs again");
  assert.equal(result.workspaceHash, workspaceHash(nodeDir));
});

test("reproduceWorkspace refuses a workspace whose output folder is a link", async (t) => {
  const runDir = makeRun(t);
  const nodeDir = makeNode(runDir, ["A_01.R"]);
  const workspace = path.join(nodeDir, "workspace");
  const elsewhere = path.join(runDir, "elsewhere-output");
  mkdirSync(elsewhere);
  rmSync(path.join(workspace, "output"), { recursive: true });
  symlinkSync(elsewhere, path.join(workspace, "output"));
  await assert.rejects(
    reproduceWorkspace({
      runDir,
      nodeDir,
      image: "ctc-analysis:1",
      timeoutMs: 5000,
      budgetMs: 60_000,
      exec: fakeRuns(deterministic).exec,
      statePath: statePathOf(runDir),
    }),
    /output.*real folder/,
  );
});
