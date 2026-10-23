// analysis/run.ts: the container library, tested with a fake Exec. Nothing here
// runs docker: dockerArgs is a pure function and runScript takes the Exec it is
// given. The one realExec check runs with PATH emptied, so no docker is needed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { dockerArgs, prepareExploration, realExec, runScript, workspaceOf, type Exec } from "../analysis/run.ts";
import { initRun } from "../tree.ts";

const DATASET_FILES: Record<string, string> = {
  "data/a.csv": "a,1\n",
  "data/sub/b.csv": "b,2\n",
  "data/c.csv": "c,3\n",
  "data/holdout-x.csv": "secret\n",
};

function git(runDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", runDir, "-c", "user.name=test", "-c", "user.email=test@ctc.local", ...args], {
    encoding: "utf8",
  }).trim();
}

/**
 * A committed run whose prep profile lists the exploration and hold-out files,
 * and a dataset folder holding them all. The split lists are committed, as a
 * tree operation would leave them, so `git status` starts clean.
 */
function makeRun(
  t: TestContext,
  exploration = ["data/a.csv", "data/sub/b.csv"],
  holdout = ["data/holdout-x.csv"],
): { runDir: string; dataset: string } {
  const root = mkdtempSync(path.join(tmpdir(), "ctc-analysis-"));
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
  writeFileSync(path.join(split, "exploration.txt"), `${exploration.join("\n")}\n`);
  writeFileSync(path.join(split, "holdout.txt"), `${holdout.join("\n")}\n`);
  git(runDir, "add", "-A");
  git(runDir, "commit", "-m", "split lists");
  return { runDir, dataset };
}

/** An explanation node with `workspace/scripts/<name>` for each name. */
function makeNode(runDir: string, scripts: string[]): string {
  const nodeDir = path.join(runDir, "explanations", "E01-demo");
  mkdirSync(path.join(nodeDir, "workspace", "scripts"), { recursive: true });
  for (const name of scripts) writeFileSync(path.join(nodeDir, "workspace", "scripts", name), "# script\n");
  return nodeDir;
}

/** Every file under `dir` as a sorted, `/`-separated path relative to it; `.git` is skipped. */
function listFiles(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...listFiles(dir, rel));
    else found.push(rel);
  }
  return found.sort();
}

function fakeExec(result: Partial<Awaited<ReturnType<Exec>>> = {}): { exec: Exec; calls: Array<{ args: string[]; timeoutMs: number }> } {
  const calls: Array<{ args: string[]; timeoutMs: number }> = [];
  const exec: Exec = async (args, opts) => {
    calls.push({ args, timeoutMs: opts.timeoutMs });
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...result };
  };
  return { exec, calls };
}

test("prepareExploration copies exactly the exploration files into analysis-data", (t) => {
  const { runDir, dataset } = makeRun(t);
  const exploration = prepareExploration(runDir);
  assert.equal(exploration, path.join(runDir, "analysis-data", "exploration"));
  assert.deepEqual(listFiles(exploration), ["data/a.csv", "data/sub/b.csv"]);
  assert.equal(readFileSync(path.join(exploration, "data", "a.csv"), "utf8"), readFileSync(path.join(dataset, "data", "a.csv"), "utf8"));
});

test("a second prepareExploration copies nothing: a file already present is kept as it is", (t) => {
  const { runDir } = makeRun(t);
  const exploration = prepareExploration(runDir);
  writeFileSync(path.join(exploration, "data", "a.csv"), "changed\n");
  assert.equal(prepareExploration(runDir), exploration);
  assert.equal(readFileSync(path.join(exploration, "data", "a.csv"), "utf8"), "changed\n", "not overwritten");
  assert.deepEqual(listFiles(exploration), ["data/a.csv", "data/sub/b.csv"]);
});

test("no hold-out file is present in the run after prepareExploration", (t) => {
  const { runDir } = makeRun(t);
  prepareExploration(runDir);
  assert.equal(listFiles(runDir).some((file) => file.endsWith("holdout-x.csv")), false);
  assert.equal(existsSync(path.join(runDir, "analysis-data", "exploration", "data", "c.csv")), false, "unlisted files are not copied");
});

test("prepareExploration refuses a list that also names a hold-out file, before copying anything", (t) => {
  const { runDir } = makeRun(t, ["data/a.csv", "data/holdout-x.csv"], ["data/holdout-x.csv"]);
  assert.throws(() => prepareExploration(runDir), /holdout-x\.csv/);
  assert.equal(existsSync(path.join(runDir, "analysis-data")), false);
});

test("prepareExploration refuses a missing exploration list", (t) => {
  const { runDir } = makeRun(t);
  rmSync(path.join(runDir, "prep", "Z01-profile", "workspace", "split", "exploration.txt"));
  assert.throws(() => prepareExploration(runDir), /exploration\.txt/);
});

test("prepareExploration refuses a listed path that leaves the dataset", (t) => {
  const { runDir } = makeRun(t, ["../outside.csv"], []);
  assert.throws(() => prepareExploration(runDir), /outside\.csv/);
});

test("prepareExploration adds each ignore line once and keeps the existing lines", (t) => {
  const { runDir } = makeRun(t);
  writeFileSync(path.join(runDir, ".gitignore"), "node_modules/\n");
  prepareExploration(runDir);
  prepareExploration(runDir);
  const lines = readFileSync(path.join(runDir, ".gitignore"), "utf8").split("\n");
  assert.equal(lines.filter((line) => line === "analysis-data/").length, 1);
  assert.equal(lines.filter((line) => line === ".analysis/").length, 1);
  assert.equal(lines.filter((line) => line === "node_modules/").length, 1);
});

test("prepareExploration leaves the run's git status clean", (t) => {
  const { runDir } = makeRun(t);
  prepareExploration(runDir);
  assert.equal(git(runDir, "status", "--porcelain"), "");
});

test("dockerArgs builds the exact container command for an R script", () => {
  const exploration = "/runs/r/analysis-data/exploration";
  const workspace = "/runs/r/explanations/E01-demo/workspace";
  assert.deepEqual(
    dockerArgs({ image: "ctc-analysis:1", exploration, workspace, script: "B_01.R", uid: 1000, gid: 1000, memory: "4g" }),
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp",
      "--user",
      "1000:1000",
      "-v",
      `${exploration}:/data:ro`,
      "-v",
      `${workspace}/scripts:/work/scripts:ro`,
      "-v",
      `${workspace}/output:/work/output`,
      "-w",
      "/work",
      "-e",
      "CTC_DATA=/data",
      "-e",
      "CTC_OUT=/work/output",
      "--memory",
      "4g",
      "ctc-analysis:1",
      "Rscript",
      "scripts/B_01.R",
    ],
  );
});

test("dockerArgs keeps the container off the network and mounts the data read-only", () => {
  const args = dockerArgs({
    image: "ctc-analysis:1",
    exploration: "/runs/r/analysis-data/exploration",
    workspace: "/runs/r/explanations/E01-demo/workspace",
    script: "assets.py",
    uid: 1000,
    gid: 1000,
  });
  const networkAt = args.indexOf("--network");
  assert.equal(args[networkAt + 1], "none");
  assert.ok(args.includes("/runs/r/analysis-data/exploration:/data:ro"));
  assert.ok(args.includes("/runs/r/explanations/E01-demo/workspace/scripts:/work/scripts:ro"));
  const mounts = args.flatMap((arg, i) => (args[i - 1] === "-v" ? [arg] : []));
  const writable = mounts.filter((mount) => !mount.endsWith(":ro"));
  assert.deepEqual(writable, ["/runs/r/explanations/E01-demo/workspace/output:/work/output"]);
  assert.equal(args.at(-2), "python3");
  assert.equal(args.at(-1), "scripts/assets.py");
  assert.equal(args.includes("--memory"), false, "no memory flag unless one is given");
});

test("dockerArgs mounts no path from the hold-out or the dataset root", (t) => {
  const { runDir, dataset } = makeRun(t);
  const exploration = prepareExploration(runDir);
  const args = dockerArgs({
    image: "ctc-analysis:1",
    exploration,
    workspace: path.join(runDir, "explanations", "E01-demo", "workspace"),
    script: "B_01.R",
    uid: 1000,
    gid: 1000,
  });
  const joined = args.join("\n");
  assert.equal(joined.includes(dataset), false, "the dataset root is not mounted");
  assert.equal(joined.includes("holdout-x"), false, "the hold-out is not mounted");
});

test("dockerArgs picks the interpreter by extension and throws for any other", () => {
  const base = { image: "img", exploration: "/e", workspace: "/w", uid: 1, gid: 1 };
  assert.deepEqual(dockerArgs({ ...base, script: "B_01.R" }).slice(-2), ["Rscript", "scripts/B_01.R"]);
  assert.deepEqual(dockerArgs({ ...base, script: "assets.py" }).slice(-2), ["python3", "scripts/assets.py"]);
  assert.throws(() => dockerArgs({ ...base, script: "B_01.sh" }), /B_01\.sh/);
});

test("workspaceOf is the node's workspace folder", () => {
  assert.equal(workspaceOf("/runs/r/explanations/E01-demo"), path.join("/runs/r/explanations/E01-demo", "workspace"));
});

test("runScript runs the script through exec and writes its log with the exit code", async (t) => {
  const { runDir } = makeRun(t);
  const nodeDir = makeNode(runDir, ["B_01.R"]);
  const { exec, calls } = fakeExec({ code: 3, stdout: "numbers ok\n", stderr: "a warning\n" });
  const result = await runScript({ runDir, nodeDir, script: "B_01.R", image: "ctc-analysis:1", timeoutMs: 5000, exec });

  assert.equal(result.code, 3);
  assert.equal(result.timedOut, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.timeoutMs, 5000);
  assert.deepEqual(calls[0]?.args.slice(-3), ["ctc-analysis:1", "Rscript", "scripts/B_01.R"]);

  const output = path.join(nodeDir, "workspace", "output");
  for (const dir of ["numbers", "tables", "figures", "logs", "assets"]) {
    assert.ok(existsSync(path.join(output, dir)), `output/${dir} exists`);
  }
  const log = readFileSync(path.join(output, "logs", "B_01.txt"), "utf8");
  assert.equal(result.log, log);
  assert.match(log, /exit code: 3/);
  assert.match(log, /numbers ok/);
  assert.match(log, /a warning/);
  assert.doesNotMatch(log, /TIMED OUT/);
});

test("runScript reports a timeout and says so in the log", async (t) => {
  const { runDir } = makeRun(t);
  const nodeDir = makeNode(runDir, ["B_01.R"]);
  const { exec } = fakeExec({ code: 124, timedOut: true });
  const result = await runScript({ runDir, nodeDir, script: "B_01.R", image: "ctc-analysis:1", timeoutMs: 1000, exec });
  assert.equal(result.timedOut, true);
  assert.match(readFileSync(path.join(nodeDir, "workspace", "output", "logs", "B_01.txt"), "utf8"), /TIMED OUT/);
});

test("runScript accepts assets scripts in either language", async (t) => {
  const { runDir } = makeRun(t);
  const nodeDir = makeNode(runDir, ["assets.R", "assets.py"]);
  const { exec, calls } = fakeExec();
  await runScript({ runDir, nodeDir, script: "assets.R", image: "img", timeoutMs: 1000, exec });
  await runScript({ runDir, nodeDir, script: "assets.py", image: "img", timeoutMs: 1000, exec });
  assert.deepEqual(calls.map((call) => call.args.at(-1)), ["scripts/assets.R", "scripts/assets.py"]);
});

test("runScript refuses a script name outside the convention, or one that does not exist", async (t) => {
  const { runDir } = makeRun(t);
  const nodeDir = makeNode(runDir, ["B_1.R"]);
  const { exec, calls } = fakeExec();
  const base = { runDir, nodeDir, image: "img", timeoutMs: 1000, exec };
  await assert.rejects(runScript({ ...base, script: "B_1.R" }), /not an analysis script name/);
  await assert.rejects(runScript({ ...base, script: "../x.R" }), /not an analysis script name/);
  await assert.rejects(runScript({ ...base, script: "B_02.R" }), /B_02\.R/);
  assert.equal(calls.length, 0, "exec is never reached");
});

test("realExec resolves with a failure instead of throwing when docker cannot run", async () => {
  const saved = process.env.PATH;
  process.env.PATH = "";
  try {
    const result = await realExec(["ps"], { timeoutMs: 5000 });
    assert.notEqual(result.code, 0);
    assert.equal(result.timedOut, false);
  } finally {
    process.env.PATH = saved;
  }
});
