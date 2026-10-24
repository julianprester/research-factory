// The owner's loop tools for an explanation node: `open_round`, `close_round` and
// `archive_script` (design §6).
//
// The tests run against a real temp run - `initRun`, a pattern, a puzzle handed to
// Phase 3 and an explanation node created under it - so the tools see the folder
// layout the owner sees. A refusal test changes exactly one fact of a fixture that
// otherwise passes, and checks that the refused call wrote nothing: a refusal that
// half-applied would leave the next call inconsistent. The "linked file" tests
// plant symlinks where workers and scripts can write (`tasks/`, `workspace/output/`,
// `workspace/archive/`), because a host-side read or move must never follow one.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { archiveScript, closeRound, openRound } from "../explain/tools.ts";
import { loopDir, readRounds } from "../explain/rounds.ts";
import { ownerMayWrite } from "../guard.ts";
import ownerExtension from "../owner-extension.ts";
import { createChild, initRun, updateNode } from "../tree.ts";

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ctc-explain-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

async function rejectMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("expected the call to be refused");
}

function git(run: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@ctc.local", ...args], { cwd: run, encoding: "utf8" });
}

/** Commit whatever the fixture or a "worker" wrote, so the next tool's own commits are what `status` shows. */
function settle(run: string): void {
  git(run, "add", "-A");
  git(run, "commit", "--allow-empty", "-q", "-m", "fixture");
}

const subjects = (run: string) => git(run, "log", "--format=%s").trim().split("\n");
const lastFiles = (run: string) => git(run, "show", "--name-status", "--format=", "HEAD").trim().split("\n").sort();

function plan(...letters: string[]): string {
  return [
    "# Plan",
    "",
    "## Questions",
    "- Does the ordering hold at depth 2?",
    "",
    "## Tasks",
    "",
    ...letters.flatMap((letter) => [`### Task ${letter}: aim of ${letter}`, "Definition of done: a registry.", ""]),
  ].join("\n");
}

const MERGED = [
  "# Merged review",
  "",
  "## Findings",
  "",
  "None.",
  "",
  "## Phase 3 must check",
  "",
  "- whether the handbook's silence is a rule or an omission",
  "",
  "## Something after",
  "",
  "- not a must-check question",
  "",
].join("\n");

interface Fixture {
  run: string;
  /** The explanation node `E01`. */
  node: string;
  puzzle: string;
}

function config(run: string, extra: Record<string, unknown> = {}): void {
  write(path.join(run, "config.json"), JSON.stringify({ model: "m", phases: {}, ...extra }));
}

/** A run with a puzzle in Phase 3 (with its snapshot sources) and an explanation node under it. */
function fixture(t: TestContext, extra: Record<string, unknown> = {}): Fixture {
  const run = tempDir(t);
  initRun(run, "data", "interest");
  createChild(run, "D01", "Etiquette", "owner-p1");
  const puzzle = createChild(run, "T01", "Rules by example", "owner-p2");
  updateNode(run, puzzle.id, { phase: 3 }, "owner-p2");
  write(path.join(puzzle.dir, "workspace", "puzzle.md"), "# The puzzle\nA card.\n");
  write(path.join(puzzle.dir, "workspace", "reviews", "merged.md"), MERGED);
  const node = createChild(run, puzzle.id, "Argument", "owner-p3");
  config(run, extra);
  settle(run);
  return { run, node: node.dir, puzzle: puzzle.dir };
}

const ARGUMENT = (version: string) => `# Argument\n\nVersion ${version}.\n`;

/** Everything `close_round` needs for round `round` with the given task letters, all passing. */
function finish(fx: Fixture, round: number, letters: string[], argument?: string): void {
  const nn = String(round).padStart(2, "0");
  for (const letter of letters) write(path.join(fx.node, "tasks", letter, "handoff.md"), `Status: DONE\n\nDone ${letter}.\n`);
  write(path.join(fx.node, "tasks", `lit-${nn}`, "handoff.md"), "Status: DONE\n");
  write(path.join(fx.node, "workspace", "reports", `${nn}.md`), "Round: 1\n");
  if (argument !== undefined) write(path.join(fx.node, "workspace", "argument.md"), argument);
  settle(fx.run);
}

/** Open and close a round, `changed` being "substantial" or "none". */
async function runRound(fx: Fixture, round: number, letters: string[], changed: "substantial" | "none"): Promise<string> {
  await openRound(fx.run, { nodeId: "E01", plan: plan(...letters) });
  finish(fx, round, letters, changed === "substantial" ? ARGUMENT(`v${round}`) : undefined);
  return closeRound(fx.run, { nodeId: "E01", changed, summary: `round ${round} ${changed}` });
}

// ---------------------------------------------------------------------------
// open_round
// ---------------------------------------------------------------------------

test("open_round on a fresh node creates round 1, the snapshots and the task folders", async (t) => {
  const fx = fixture(t);
  const text = await openRound(fx.run, { nodeId: "E01", plan: plan("A", "B") });
  assert.match(text, /round 1\b/);

  assert.equal(readFileSync(path.join(fx.node, "rounds", "01", "plan.md"), "utf8"), plan("A", "B"));
  assert.equal(readFileSync(path.join(fx.node, "workspace", "puzzle.md"), "utf8"), "# The puzzle\nA card.\n");
  const mustCheck = readFileSync(path.join(fx.node, "workspace", "must-check.md"), "utf8");
  assert.match(mustCheck, /handbook's silence/);
  assert.doesNotMatch(mustCheck, /not a must-check question/);
  assert.ok(lstatSync(path.join(fx.node, "tasks", "A")).isDirectory());
  assert.ok(lstatSync(path.join(fx.node, "tasks", "B")).isDirectory());
  assert.deepEqual(readdirSync(path.join(fx.node, "rounds", "01")), ["plan.md"], "no temp file is left behind");
});

test("open_round refuses a plan that does not parse, and writes nothing", async (t) => {
  const fx = fixture(t);
  const message = await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: "## Questions\nWhy?\n\n## Tasks\n\n### Task AB: x\n" }));
  assert.match(message, /plan does not parse/);
  assert.equal(existsSync(path.join(fx.node, "rounds")), false);
  assert.equal(existsSync(path.join(fx.node, "tasks")), false);
  assert.equal(existsSync(path.join(fx.node, "workspace", "puzzle.md")), false);
});

test("open_round refuses a letter twice in one plan", async (t) => {
  const fx = fixture(t);
  assert.match(await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: plan("A", "A") })), /letter A twice/);
});

test("open_round refuses round 2 while round 1 is open", async (t) => {
  const fx = fixture(t);
  await openRound(fx.run, { nodeId: "E01", plan: plan("A") });
  assert.match(await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: plan("B") })), /round 01 is still open/);
  assert.equal(existsSync(path.join(fx.node, "rounds", "02")), false);
});

test("open_round refuses a letter used in an earlier round and a letter already in tasks/", async (t) => {
  const fx = fixture(t);
  await runRound(fx, 1, ["A", "B"], "substantial");
  assert.match(await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: plan("B", "C") })), /letter B was used in round 1/);
  assert.equal(existsSync(path.join(fx.node, "rounds", "02")), false, "a refused round writes nothing");
  mkdirSync(path.join(fx.node, "tasks", "C"));
  assert.match(await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: plan("C") })), /letter C already has a folder in tasks\//);
  const text = await openRound(fx.run, { nodeId: "E01", plan: plan("D") });
  assert.match(text, /round 2\b/);
});

test("open_round refuses any round after STOP (the latch)", async (t) => {
  const fx = fixture(t);
  await runRound(fx, 1, ["A"], "substantial");
  await runRound(fx, 2, ["B"], "none");
  assert.match(await runRound(fx, 3, ["C"], "none"), /STOP \(two-quiet\)/);
  assert.equal(
    await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: plan("D") })),
    "STOP recorded (two-quiet): no more rounds",
  );
  assert.equal(existsSync(path.join(fx.node, "tasks", "D")), false);
});

test("open_round refuses after the cap, which comes from the config", async (t) => {
  const fx = fixture(t, { roundCap: 2 });
  await runRound(fx, 1, ["A"], "substantial");
  assert.match(await runRound(fx, 2, ["B"], "substantial"), /STOP \(cap\)/);
  assert.equal(
    await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: plan("C") })),
    "STOP recorded (cap): no more rounds",
  );
});

test("open_round with the default cap runs six rounds, then stops", async (t) => {
  const fx = fixture(t);
  const letters = ["A", "B", "C", "D", "E", "F"];
  for (let round = 1; round <= 5; round++) {
    assert.match(await runRound(fx, round, [letters[round - 1]!], "substantial"), /continue/);
  }
  assert.match(await runRound(fx, 6, ["F"], "substantial"), /STOP \(cap\)/);
  assert.match(await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: plan("G") })), /STOP recorded \(cap\)/);
});

test("open_round refuses a node that is not an explanation in Phase 3", async (t) => {
  const fx = fixture(t);
  assert.match(await rejectMessage(openRound(fx.run, { nodeId: "P01", plan: plan("A") })), /P01 is not an explanation node/);
  updateNode(fx.run, "E01", { phase: 4 }, "owner-p3");
  assert.match(await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: plan("A") })), /Not your phase/);
});

test("open_round refuses a link where it would write or read, and writes nothing", async (t) => {
  const fx = fixture(t);
  mkdirSync(path.join(fx.run, "elsewhere"));
  symlinkSync(path.join(fx.run, "elsewhere"), path.join(fx.node, "tasks"));
  assert.match(await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: plan("A") })), /tasks is a link/);
  assert.deepEqual(readdirSync(path.join(fx.run, "elsewhere")), []);
  assert.equal(existsSync(path.join(fx.node, "rounds")), false);
  unlinkSync(path.join(fx.node, "tasks"));

  rmSync(path.join(fx.puzzle, "workspace", "puzzle.md"));
  write(path.join(fx.run, "secret.md"), "secret");
  symlinkSync(path.join(fx.run, "secret.md"), path.join(fx.puzzle, "workspace", "puzzle.md"));
  assert.match(await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: plan("A") })), /puzzle\.md is a link/);
  assert.equal(existsSync(path.join(fx.node, "workspace", "puzzle.md")), false);
});

test("open_round refuses round 1 when the parent puzzle's snapshots are missing", async (t) => {
  const fx = fixture(t);
  rmSync(path.join(fx.puzzle, "workspace", "reviews", "merged.md"));
  assert.match(await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: plan("A") })), /merged\.md/);
  assert.equal(existsSync(path.join(fx.node, "rounds")), false);
});

// ---------------------------------------------------------------------------
// close_round
// ---------------------------------------------------------------------------

test("close_round refuses each condition in turn, then closes", async (t) => {
  const fx = fixture(t);
  const close = (changed: "substantial" | "none" = "substantial", summary = "what changed") =>
    closeRound(fx.run, { nodeId: "E01", changed, summary });

  assert.match(await rejectMessage(close()), /no open round/);

  await openRound(fx.run, { nodeId: "E01", plan: plan("A", "B") });
  assert.match(await rejectMessage(close()), /tasks\/A\/handoff\.md is missing/);

  write(path.join(fx.node, "tasks", "A", "handoff.md"), "Status: DONE\n");
  assert.match(await rejectMessage(close()), /tasks\/B\/handoff\.md is missing/);

  write(path.join(fx.node, "tasks", "B", "handoff.md"), "Status: BLOCKED\n\nNo data.\n");
  assert.match(await rejectMessage(close()), /task B is BLOCKED/);

  write(path.join(fx.node, "tasks", "B", "handoff.md"), "Done, without a status line.\n\nStatus: DONE\n");
  assert.match(await rejectMessage(close()), /tasks\/B\/handoff\.md must start with a "Status:" line/);

  write(path.join(fx.node, "tasks", "B", "handoff.md"), "Status: DONE_WITH_CONCERNS\n");
  assert.match(await rejectMessage(close()), /tasks\/lit-01\/handoff\.md is missing/);

  write(path.join(fx.node, "tasks", "lit-01", "handoff.md"), "Status: DONE\n");
  assert.match(await rejectMessage(close()), /workspace\/reports\/01\.md is missing/);

  write(path.join(fx.node, "workspace", "reports", "01.md"), "Round: 1\n");
  assert.match(await rejectMessage(close()), /workspace\/argument\.md is missing/);

  write(path.join(fx.node, "workspace", "argument.md"), ARGUMENT("v1"));
  assert.match(await rejectMessage(close("none")), /round 1 cannot be "none"/);
  assert.match(await rejectMessage(close("substantial", "  ")), /summary/);
  assert.match(await rejectMessage(close("other" as "none")), /changed must be/);

  assert.equal(existsSync(path.join(fx.node, "rounds", "01", "verdict.md")), false);
  assert.equal(existsSync(path.join(loopDir(fx.run, "E01"), "rounds.json")), false, "no refused close recorded a round");

  const text = await close();
  assert.match(text, /round 1 closed/);
  assert.match(text, /continue/);
  assert.equal(
    readFileSync(path.join(fx.node, "rounds", "01", "verdict.md"), "utf8"),
    "Changed: substantial\n\nwhat changed\n",
  );
  const [record] = readRounds(fx.run, "E01");
  assert.deepEqual(
    { ...record, argumentSha: typeof record?.argumentSha },
    { round: 1, changed: true, argumentSha: "string", summary: "what changed", letters: ["A", "B"] },
  );
  assert.match(await rejectMessage(close()), /no open round/, "a closed round cannot be closed twice");
});

test("close_round: 'substantial' needs the argument to differ from the previous round's (Review Focus 2)", async (t) => {
  const fx = fixture(t);
  await runRound(fx, 1, ["A"], "substantial");

  await openRound(fx.run, { nodeId: "E01", plan: plan("B") });
  finish(fx, 2, ["B"]);
  const claim = () => closeRound(fx.run, { nodeId: "E01", changed: "substantial", summary: "I rewrote it" });
  assert.match(await rejectMessage(claim()), /argument\.md is unchanged since round 1/);
  assert.equal(readRounds(fx.run, "E01").length, 1);
  assert.equal(existsSync(path.join(fx.node, "rounds", "02", "verdict.md")), false);

  write(path.join(fx.node, "workspace", "argument.md"), ARGUMENT("edited"));
  assert.match(await claim(), /round 2 closed/);

  // "none" does not require the argument to be identical: the owner may tidy.
  await openRound(fx.run, { nodeId: "E01", plan: plan("C") });
  finish(fx, 3, ["C"], ARGUMENT("tidied"));
  assert.match(await closeRound(fx.run, { nodeId: "E01", changed: "none", summary: "wording only" }), /round 3 closed/);
});

test("close_round reports STOP (two-quiet) after the second quiet round", async (t) => {
  const fx = fixture(t);
  assert.match(await runRound(fx, 1, ["A"], "substantial"), /continue/);
  assert.match(await runRound(fx, 2, ["B"], "none"), /continue/);
  const last = await runRound(fx, 3, ["C"], "none");
  assert.match(last, /STOP \(two-quiet\)/);
  assert.deepEqual(readRounds(fx.run, "E01").map((r) => r.changed), [true, false, false]);
});

test("close_round: a quiet round, a changed one, a quiet one do not stop", async (t) => {
  const fx = fixture(t);
  await runRound(fx, 1, ["A"], "substantial");
  await runRound(fx, 2, ["B"], "none");
  await runRound(fx, 3, ["C"], "substantial");
  assert.match(await runRound(fx, 4, ["D"], "none"), /continue/);
});

test("close_round reads handoffs, the argument and the plan without following a link", async (t) => {
  const fx = fixture(t);
  await openRound(fx.run, { nodeId: "E01", plan: plan("A") });
  finish(fx, 1, ["A"], ARGUMENT("v1"));
  const close = () => closeRound(fx.run, { nodeId: "E01", changed: "substantial", summary: "s" });

  write(path.join(fx.run, "real-handoff.md"), "Status: DONE\n");
  rmSync(path.join(fx.node, "tasks", "A", "handoff.md"));
  symlinkSync(path.join(fx.run, "real-handoff.md"), path.join(fx.node, "tasks", "A", "handoff.md"));
  assert.match(await rejectMessage(close()), /tasks\/A\/handoff\.md is a link/);
  rmSync(path.join(fx.node, "tasks", "A", "handoff.md"));
  write(path.join(fx.node, "tasks", "A", "handoff.md"), "Status: DONE\n");

  write(path.join(fx.run, "real-argument.md"), ARGUMENT("v1"));
  rmSync(path.join(fx.node, "workspace", "argument.md"));
  symlinkSync(path.join(fx.run, "real-argument.md"), path.join(fx.node, "workspace", "argument.md"));
  assert.match(await rejectMessage(close()), /workspace\/argument\.md is a link/);
  rmSync(path.join(fx.node, "workspace", "argument.md"));
  write(path.join(fx.node, "workspace", "argument.md"), ARGUMENT("v1"));

  rmSync(path.join(fx.node, "workspace", "reports", "01.md"));
  symlinkSync(path.join(fx.run, "real-argument.md"), path.join(fx.node, "workspace", "reports", "01.md"));
  assert.match(await rejectMessage(close()), /reports\/01\.md is a link/);
  rmSync(path.join(fx.node, "workspace", "reports", "01.md"));
  write(path.join(fx.node, "workspace", "reports", "01.md"), "Round: 1\n");

  assert.match(await close(), /round 1 closed/);
});

test("close_round's cap comes from the config", async (t) => {
  const fx = fixture(t, { roundCap: 1 });
  assert.match(await runRound(fx, 1, ["A"], "substantial"), /STOP \(cap\)/);
});

// ---------------------------------------------------------------------------
// archive_script
// ---------------------------------------------------------------------------

/** A script with its registry and log, and an argument that links to nothing. */
function withScript(fx: Fixture, script = "A_01.R"): string {
  const stem = script.replace(/\.[^.]+$/, "");
  const workspace = path.join(fx.node, "workspace");
  write(path.join(workspace, "scripts", script), "# analysis\n");
  write(path.join(workspace, "output", "numbers", `${stem}.csv`), "name,value,note\nn,1,\n");
  write(path.join(workspace, "output", "logs", `${stem}.txt`), "ran\n");
  write(path.join(workspace, "argument.md"), "# Argument\n\nNothing linked.\n");
  settle(fx.run);
  return stem;
}

test("archive_script moves the script, its numbers and its log, and writes the README", async (t) => {
  const fx = fixture(t);
  withScript(fx);
  const text = await archiveScript(fx.run, { nodeId: "E01", script: "A_01.R", reason: "superseded by A_02" });
  assert.match(text, /archived A_01\.R/);

  const workspace = path.join(fx.node, "workspace");
  const dest = path.join(workspace, "archive", "A_01");
  assert.equal(readFileSync(path.join(dest, "A_01.R"), "utf8"), "# analysis\n");
  assert.equal(readFileSync(path.join(dest, "A_01.csv"), "utf8"), "name,value,note\nn,1,\n");
  assert.equal(readFileSync(path.join(dest, "A_01.txt"), "utf8"), "ran\n");
  assert.match(readFileSync(path.join(dest, "README.md"), "utf8"), /superseded by A_02/);
  assert.equal(existsSync(path.join(workspace, "scripts", "A_01.R")), false);
  assert.equal(existsSync(path.join(workspace, "output", "numbers", "A_01.csv")), false);
  assert.equal(existsSync(path.join(workspace, "output", "logs", "A_01.txt")), false);
});

test("archive_script moves a script that never produced output", async (t) => {
  const fx = fixture(t);
  write(path.join(fx.node, "workspace", "scripts", "B_02.py"), "pass\n");
  await archiveScript(fx.run, { nodeId: "E01", script: "B_02.py", reason: "never ran" });
  assert.deepEqual(readdirSync(path.join(fx.node, "workspace", "archive", "B_02")).sort(), ["B_02.py", "README.md"]);
});

test("archive_script refuses an empty reason and a name that is not an analysis script", async (t) => {
  const fx = fixture(t);
  withScript(fx);
  for (const reason of ["", "   \n"]) {
    assert.match(await rejectMessage(archiveScript(fx.run, { nodeId: "E01", script: "A_01.R", reason })), /reason/);
  }
  for (const script of ["A_1.R", "../scripts/A_01.R", "helper.R", "A_01.R/", "scripts/A_01.R", "a_01.R"]) {
    assert.match(await rejectMessage(archiveScript(fx.run, { nodeId: "E01", script, reason: "why" })), /analysis script/, script);
  }
  assert.ok(existsSync(path.join(fx.node, "workspace", "scripts", "A_01.R")), "nothing moved");
  assert.equal(existsSync(path.join(fx.node, "workspace", "archive")), false);
});

test("archive_script refuses a script that does not exist", async (t) => {
  const fx = fixture(t);
  assert.match(await rejectMessage(archiveScript(fx.run, { nodeId: "E01", script: "A_01.R", reason: "why" })), /scripts\/A_01\.R does not exist/);
});

test("archive_script refuses a script or output file the argument links to", async (t) => {
  const links = [
    "[the script](scripts/A_01.R)",
    "[the script](./scripts/A_01.R)",
    "[a number](output/numbers/A_01.csv#n)",
    "[the log](output/logs/A_01.txt)",
    "[ref][r]\n\n[r]: output/numbers/A_01.csv#n",
    "[the script](<scripts/A_01.R>)",
    "[the script](scripts/A%5F01.R)",
    "[the script](output/../scripts/A_01.R)",
  ];
  for (const link of links) {
    const fx = fixture(t);
    withScript(fx);
    write(path.join(fx.node, "workspace", "argument.md"), `# Argument\n\nSee ${link}.\n`);
    assert.match(
      await rejectMessage(archiveScript(fx.run, { nodeId: "E01", script: "A_01.R", reason: "why" })),
      /argument\.md links to/,
      link,
    );
    assert.ok(existsSync(path.join(fx.node, "workspace", "scripts", "A_01.R")), `${link}: nothing moved`);
    assert.equal(existsSync(path.join(fx.node, "workspace", "archive")), false, `${link}: no archive folder`);
  }
});

test("archive_script allows a script the argument does not link, even when it links others", async (t) => {
  const fx = fixture(t);
  withScript(fx);
  withScript(fx, "A_02.R");
  write(path.join(fx.node, "workspace", "argument.md"), "# Argument\n\nSee [b](output/numbers/A_02.csv#n) and [web](https://example.org/scripts/A_01.R).\n");
  await archiveScript(fx.run, { nodeId: "E01", script: "A_01.R", reason: "dropped" });
  assert.ok(existsSync(path.join(fx.node, "workspace", "archive", "A_01", "A_01.R")));
});

test("archive_script refuses a stem already archived, whatever is there", async (t) => {
  const fx = fixture(t);
  withScript(fx);
  mkdirSync(path.join(fx.node, "workspace", "archive", "A_01"), { recursive: true });
  assert.match(await rejectMessage(archiveScript(fx.run, { nodeId: "E01", script: "A_01.R", reason: "why" })), /archive\/A_01 already exists/);
  assert.ok(existsSync(path.join(fx.node, "workspace", "scripts", "A_01.R")));

  rmSync(path.join(fx.node, "workspace", "archive", "A_01"), { recursive: true });
  mkdirSync(path.join(fx.run, "elsewhere"));
  symlinkSync(path.join(fx.run, "elsewhere"), path.join(fx.node, "workspace", "archive", "A_01"));
  assert.match(await rejectMessage(archiveScript(fx.run, { nodeId: "E01", script: "A_01.R", reason: "why" })), /archive\/A_01 (?:is a link|already exists)/);
  assert.deepEqual(readdirSync(path.join(fx.run, "elsewhere")), []);
});

test("archive_script refuses when archive/ is a link, and moves nothing", async (t) => {
  const fx = fixture(t);
  withScript(fx);
  mkdirSync(path.join(fx.run, "elsewhere"));
  symlinkSync(path.join(fx.run, "elsewhere"), path.join(fx.node, "workspace", "archive"));
  assert.match(await rejectMessage(archiveScript(fx.run, { nodeId: "E01", script: "A_01.R", reason: "why" })), /archive is a link/);
  assert.deepEqual(readdirSync(path.join(fx.run, "elsewhere")), []);
  assert.ok(existsSync(path.join(fx.node, "workspace", "scripts", "A_01.R")));
});

test("archive_script refuses a source that is a link or a folder, and moves nothing", async (t) => {
  const planted: [string, (fx: Fixture) => void, RegExp][] = [
    [
      "a linked script",
      (fx) => {
        rmSync(path.join(fx.node, "workspace", "scripts", "A_01.R"));
        write(path.join(fx.run, "target.R"), "x");
        symlinkSync(path.join(fx.run, "target.R"), path.join(fx.node, "workspace", "scripts", "A_01.R"));
      },
      /scripts\/A_01\.R is a link/,
    ],
    [
      "a linked registry file",
      (fx) => {
        rmSync(path.join(fx.node, "workspace", "output", "numbers", "A_01.csv"));
        write(path.join(fx.run, "target.csv"), "x");
        symlinkSync(path.join(fx.run, "target.csv"), path.join(fx.node, "workspace", "output", "numbers", "A_01.csv"));
      },
      /numbers\/A_01\.csv is a link/,
    ],
    [
      "a log that is a folder",
      (fx) => {
        rmSync(path.join(fx.node, "workspace", "output", "logs", "A_01.txt"));
        mkdirSync(path.join(fx.node, "workspace", "output", "logs", "A_01.txt"));
      },
      /logs\/A_01\.txt is not a regular file/,
    ],
    [
      "a linked output/numbers folder",
      (fx) => {
        rmSync(path.join(fx.node, "workspace", "output", "numbers"), { recursive: true });
        mkdirSync(path.join(fx.run, "numbers-elsewhere"));
        write(path.join(fx.run, "numbers-elsewhere", "A_01.csv"), "x");
        symlinkSync(path.join(fx.run, "numbers-elsewhere"), path.join(fx.node, "workspace", "output", "numbers"));
      },
      /output\/numbers is a link/,
    ],
  ];
  for (const [name, plant, expected] of planted) {
    const fx = fixture(t);
    withScript(fx);
    plant(fx);
    assert.match(await rejectMessage(archiveScript(fx.run, { nodeId: "E01", script: "A_01.R", reason: "why" })), expected, name);
    assert.equal(existsSync(path.join(fx.node, "workspace", "archive")), false, `${name}: nothing created`);
    assert.ok(existsSync(path.join(fx.node, "workspace", "scripts", "A_01.R")), `${name}: the script stays`);
  }
});

test("archive_script refuses an argument.md it cannot read as a regular file", async (t) => {
  const fx = fixture(t);
  withScript(fx);
  rmSync(path.join(fx.node, "workspace", "argument.md"));
  write(path.join(fx.run, "real.md"), "[s](scripts/A_01.R)");
  symlinkSync(path.join(fx.run, "real.md"), path.join(fx.node, "workspace", "argument.md"));
  assert.match(await rejectMessage(archiveScript(fx.run, { nodeId: "E01", script: "A_01.R", reason: "why" })), /argument\.md is a link/);
  assert.ok(existsSync(path.join(fx.node, "workspace", "scripts", "A_01.R")));
});

// ---------------------------------------------------------------------------
// The registrations, and what the owner's write tool may not touch
// ---------------------------------------------------------------------------

interface CapturedTool {
  name: string;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<{ content: { type: string; text: string }[] }>;
}

function captureTools(t: TestContext, run: string, phase: number): Map<string, CapturedTool> {
  const savedRun = process.env.CTC_RUN_DIR;
  const savedPhase = process.env.CTC_PHASE;
  process.env.CTC_RUN_DIR = run;
  process.env.CTC_PHASE = String(phase);
  t.after(() => {
    if (savedRun === undefined) delete process.env.CTC_RUN_DIR;
    else process.env.CTC_RUN_DIR = savedRun;
    if (savedPhase === undefined) delete process.env.CTC_PHASE;
    else process.env.CTC_PHASE = savedPhase;
  });
  const tools = new Map<string, CapturedTool>();
  ownerExtension({
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool);
    },
    on() {
      /* the write guard is checked through ownerMayWrite below */
    },
  });
  return tools;
}

test("the owner extension registers the three tools for Phase 3 only", async (t) => {
  const fx = fixture(t);
  const phase3 = captureTools(t, fx.run, 3);
  const opened = await phase3.get("open_round")!.execute("c1", { nodeId: "E01", plan: plan("A") });
  assert.match(opened.content[0]!.text, /round 1\b/);
  finish(fx, 1, ["A"], ARGUMENT("v1"));
  const closed = await phase3.get("close_round")!.execute("c2", { nodeId: "E01", changed: "substantial", summary: "s" });
  assert.match(closed.content[0]!.text, /round 1 closed/);
  write(path.join(fx.node, "workspace", "scripts", "A_01.R"), "x");
  const archived = await phase3.get("archive_script")!.execute("c3", { nodeId: "E01", script: "A_01.R", reason: "why" });
  assert.match(archived.content[0]!.text, /archived A_01\.R/);

  for (const phase of [1, 2]) {
    const tools = captureTools(t, fx.run, phase);
    for (const [name, params] of [
      ["open_round", { nodeId: "E01", plan: plan("B") }],
      ["close_round", { nodeId: "E01", changed: "none", summary: "s" }],
      ["archive_script", { nodeId: "E01", script: "A_01.R", reason: "why" }],
    ] as const) {
      assert.equal(
        await rejectMessage(tools.get(name)!.execute("c", params)),
        `Not your phase: ${name} is a phase-3 tool and you own P${phase}`,
      );
    }
  }
});

test("the owner's write tool may not touch the loop records, plans or verdicts", async (t) => {
  const fx = fixture(t);
  const inNode = (...parts: string[]) => path.join(fx.node, ...parts);
  assert.equal(ownerMayWrite(fx.run, 3, path.join(loopDir(fx.run, "E01"), "rounds.json")), false);
  assert.equal(ownerMayWrite(fx.run, 3, inNode("rounds", "01", "plan.md")), false);
  assert.equal(ownerMayWrite(fx.run, 3, inNode("rounds", "01", "verdict.md")), false);
  assert.equal(ownerMayWrite(fx.run, 3, inNode("workspace", "argument.md")), true);
  assert.equal(ownerMayWrite(fx.run, 3, inNode("tasks", "C", "brief.md")), true);
  assert.equal(ownerMayWrite(fx.run, 3, path.join(fx.run, "owners", "phase-3", "ledger.md")), true);
});

// ---------------------------------------------------------------------------
// Commits (design §4: each plan and each verdict is a commit)
// ---------------------------------------------------------------------------

test("open_round commits the plan (and on round 1 the snapshots) and leaves the tree clean", async (t) => {
  const fx = fixture(t);
  await openRound(fx.run, { nodeId: "E01", plan: plan("A") });
  assert.equal(git(fx.run, "status", "--porcelain"), "");
  assert.equal(subjects(fx.run)[0], "[P3:plan] E01 round 01");
  const base = "patterns/T01-etiquette/puzzles/P01-rules-by-example/explanations/E01-argument";
  assert.deepEqual(lastFiles(fx.run), [
    `A\t${base}/rounds/01/plan.md`,
    `A\t${base}/workspace/must-check.md`,
    `A\t${base}/workspace/puzzle.md`,
  ]);

  finish(fx, 1, ["A"], ARGUMENT("v1"));
  await closeRound(fx.run, { nodeId: "E01", changed: "substantial", summary: "s" });
  await openRound(fx.run, { nodeId: "E01", plan: plan("B") });
  assert.equal(git(fx.run, "status", "--porcelain"), "");
  assert.equal(subjects(fx.run)[0], "[P3:plan] E01 round 02");
  assert.deepEqual(lastFiles(fx.run), [`A\t${base}/rounds/02/plan.md`], "later rounds commit the plan alone");
});

test("a refused open_round, close_round or archive_script makes no commit", async (t) => {
  const fx = fixture(t);
  const before = subjects(fx.run).length;
  await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: "no plan" }));
  await rejectMessage(closeRound(fx.run, { nodeId: "E01", changed: "substantial", summary: "s" }));
  await rejectMessage(archiveScript(fx.run, { nodeId: "E01", script: "A_01.R", reason: "" }));
  assert.equal(subjects(fx.run).length, before);
  assert.equal(git(fx.run, "status", "--porcelain"), "");
});

test("close_round commits the verdict and rounds.json and leaves the tree clean", async (t) => {
  const fx = fixture(t);
  await openRound(fx.run, { nodeId: "E01", plan: plan("A") });
  finish(fx, 1, ["A"], ARGUMENT("v1"));
  await closeRound(fx.run, { nodeId: "E01", changed: "substantial", summary: "s" });
  assert.equal(git(fx.run, "status", "--porcelain"), "");
  assert.equal(subjects(fx.run)[0], "[P3:verdict] E01 round 01 (substantial)");
  assert.deepEqual(lastFiles(fx.run), [
    "A\towners/phase-3/loop/E01/rounds.json",
    "A\tpatterns/T01-etiquette/puzzles/P01-rules-by-example/explanations/E01-argument/rounds/01/verdict.md",
  ]);

  await openRound(fx.run, { nodeId: "E01", plan: plan("B") });
  finish(fx, 2, ["B"]);
  await closeRound(fx.run, { nodeId: "E01", changed: "none", summary: "quiet" });
  assert.equal(git(fx.run, "status", "--porcelain"), "");
  assert.equal(subjects(fx.run)[0], "[P3:verdict] E01 round 02 (none)");
  assert.ok(lastFiles(fx.run).includes("M\towners/phase-3/loop/E01/rounds.json"));
});

test("archive_script commits the move, removals included, and leaves the tree clean", async (t) => {
  const fx = fixture(t);
  withScript(fx);
  await archiveScript(fx.run, { nodeId: "E01", script: "A_01.R", reason: "superseded" });
  assert.equal(git(fx.run, "status", "--porcelain"), "");
  assert.equal(subjects(fx.run)[0], "[P3:archive] E01 A_01");
  const base = "patterns/T01-etiquette/puzzles/P01-rules-by-example/explanations/E01-argument/workspace";
  assert.deepEqual(lastFiles(fx.run), [
    `A\t${base}/archive/A_01/README.md`,
    `R100\t${base}/output/logs/A_01.txt\t${base}/archive/A_01/A_01.txt`,
    `R100\t${base}/output/numbers/A_01.csv\t${base}/archive/A_01/A_01.csv`,
    `R100\t${base}/scripts/A_01.R\t${base}/archive/A_01/A_01.R`,
  ].sort());
});

test("archive_script commits cleanly when the sources were never committed", async (t) => {
  const fx = fixture(t);
  write(path.join(fx.node, "workspace", "scripts", "A_01.R"), "x");
  await archiveScript(fx.run, { nodeId: "E01", script: "A_01.R", reason: "never committed" });
  assert.equal(git(fx.run, "status", "--porcelain"), "");
  assert.equal(subjects(fx.run)[0], "[P3:archive] E01 A_01");
});

// ---------------------------------------------------------------------------
// Temp files, retries and precedence
// ---------------------------------------------------------------------------

test("open_round copies the puzzle byte-exact and does not write through a planted temp link", async (t) => {
  const fx = fixture(t);
  const bytes = Buffer.from([0x23, 0xff, 0xfe, 0x0a, 0xc3, 0x28, 0x0a]);
  writeFileSync(path.join(fx.puzzle, "workspace", "puzzle.md"), bytes);
  settle(fx.run);

  // A worker plants links at the names a host might guess for its temp files.
  const victim = path.join(fx.run, "victim.txt");
  writeFileSync(victim, "untouched");
  mkdirSync(path.join(fx.node, "workspace"), { recursive: true });
  for (const name of ["puzzle.md", "must-check.md"]) {
    symlinkSync(victim, path.join(fx.node, "workspace", `${name}.${process.pid}.tmp`));
  }
  settle(fx.run);

  await openRound(fx.run, { nodeId: "E01", plan: plan("A") });
  assert.equal(readFileSync(victim, "utf8"), "untouched");
  assert.deepEqual(readFileSync(path.join(fx.node, "workspace", "puzzle.md")), bytes);
  assert.match(readFileSync(path.join(fx.node, "workspace", "must-check.md"), "utf8"), /handbook's silence/);
});

test("archive_script retries when the destination holds only the README an earlier attempt wrote", async (t) => {
  const fx = fixture(t);
  withScript(fx);
  const dest = path.join(fx.node, "workspace", "archive", "A_01");
  write(path.join(dest, "README.md"), "# earlier attempt\n");
  await archiveScript(fx.run, { nodeId: "E01", script: "A_01.R", reason: "second try" });
  assert.match(readFileSync(path.join(dest, "README.md"), "utf8"), /second try/);
  assert.ok(existsSync(path.join(dest, "A_01.R")));
  assert.equal(existsSync(path.join(fx.node, "workspace", "scripts", "A_01.R")), false);
  assert.equal(git(fx.run, "status", "--porcelain"), "");
});

test("archive_script undoes a rename that fails part-way, so the retry is not stuck", { skip: process.getuid?.() === 0 }, async (t) => {
  const fx = fixture(t);
  withScript(fx);
  const numbers = path.join(fx.node, "workspace", "output", "numbers");
  chmodSync(numbers, 0o555); // the script moves, then the registry file cannot leave its folder
  const before = subjects(fx.run).length;
  try {
    await rejectMessage(archiveScript(fx.run, { nodeId: "E01", script: "A_01.R", reason: "why" }));
  } finally {
    chmodSync(numbers, 0o755);
  }

  assert.ok(existsSync(path.join(fx.node, "workspace", "scripts", "A_01.R")), "the script is back");
  assert.ok(existsSync(path.join(numbers, "A_01.csv")));
  assert.deepEqual(readdirSync(path.join(fx.node, "workspace", "archive")), [], "no stem and no stage folder is left");
  assert.equal(subjects(fx.run).length, before, "no commit");

  await archiveScript(fx.run, { nodeId: "E01", script: "A_01.R", reason: "why" });
  assert.ok(existsSync(path.join(fx.node, "workspace", "archive", "A_01", "A_01.csv")));
});

test("close_round at round 6 with roundCap 6: two quiet rounds report two-quiet, not cap", async (t) => {
  const fx = fixture(t, { roundCap: 6 });
  for (let round = 1; round <= 4; round++) await runRound(fx, round, [String.fromCharCode(64 + round)], "substantial");
  assert.match(await runRound(fx, 5, ["E"], "none"), /continue/);
  const last = await runRound(fx, 6, ["F"], "none");
  assert.match(last, /STOP \(two-quiet\)/);
  assert.match(await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: plan("G") })), /STOP recorded \(two-quiet\)/);
});
