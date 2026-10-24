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
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { workspaceHash } from "../explain/reproduce.ts";
import { loopDir, readRounds } from "../explain/rounds.ts";
import {
  archiveScript,
  closeRound,
  openRound,
  reproduce,
  setBudgetForTests,
  setCitationsForTests,
  setExecForTests,
  submit,
} from "../explain/tools.ts";
import { ownerMayWrite } from "../guard.ts";
import { createChild, updateNode } from "../tree.ts";
import {
  ARGUMENT,
  ARGUMENT_FULL,
  ASSET_SOURCES,
  ASSET_VARIABLES,
  NODE_BASE,
  REGISTRY,
  REPORT_FULL,
  REVISION,
  captureTools,
  config,
  fakeContainer,
  finish,
  fixture,
  git,
  inWorkspace,
  lastFiles,
  plan,
  rejectMessage,
  review,
  runRound,
  settle,
  subjects,
  tempDir,
  write,
  type Fixture,
} from "./explain-fixture.ts";


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
  write(path.join(fx.node, "tasks", "C", "handoff.md"), "Status: DONE\n");
  assert.match(await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: plan("C") })), /letter C already has a folder in tasks\//);
  const text = await openRound(fx.run, { nodeId: "E01", plan: plan("D") });
  assert.match(text, /round 2\b/);
});

test("open_round refuses a letter that is not above every letter used, and names the letter and the greatest used", async (t) => {
  const fx = fixture(t);
  await runRound(fx, 1, ["C", "D"], "substantial");
  const message = await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: plan("B") }));
  assert.match(message, /letter B/);
  assert.match(message, /greatest letter already used \(D\)/);
  assert.equal(existsSync(path.join(fx.node, "rounds", "02")), false, "a refused round writes nothing");
  assert.equal(existsSync(path.join(fx.node, "tasks", "B")), false);

  // One low letter among higher ones refuses the whole plan; a letter equal to the greatest was reused (its own message).
  assert.match(await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: plan("E", "A") })), /letter A.*greatest letter already used \(D\)/);
  assert.match(await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: plan("D") })), /letter D was used in round 1/);
  assert.match(await openRound(fx.run, { nodeId: "E01", plan: plan("E", "F") }), /round 2\b/);
});

test("open_round counts a tasks/ folder with content as used, so a lower letter is refused even without a record", async (t) => {
  const fx = fixture(t);
  write(path.join(fx.node, "tasks", "G", "handoff.md"), "Status: DONE\n");
  const message = await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: plan("C") }));
  assert.match(message, /letter C.*greatest letter already used \(G\)/);
  assert.match(await openRound(fx.run, { nodeId: "E01", plan: plan("H") }), /round 1\b/);
});

test("open_round tolerates a task folder that holds only brief.md (briefs written first), and does not count it as used", async (t) => {
  const fx = fixture(t);
  write(path.join(fx.node, "tasks", "A", "brief.md"), "# brief A\n");
  write(path.join(fx.node, "tasks", "B", "brief.md"), "# brief B\n");
  mkdirSync(path.join(fx.node, "tasks", "C"), { recursive: true });
  assert.match(await openRound(fx.run, { nodeId: "E01", plan: plan("A", "B", "C") }), /round 1\b/);
  assert.equal(readFileSync(path.join(fx.node, "tasks", "A", "brief.md"), "utf8"), "# brief A\n", "the owner's brief is kept");
});

test("open_round still refuses a task folder that holds anything besides brief.md", async (t) => {
  const fx = fixture(t);
  write(path.join(fx.node, "tasks", "A", "brief.md"), "# brief\n");
  write(path.join(fx.node, "tasks", "A", "handoff.md"), "Status: DONE\n");
  assert.match(await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: plan("A") })), /letter A already has a folder in tasks\//);
  rmSync(path.join(fx.node, "tasks", "A"), { recursive: true });
  write(path.join(fx.node, "tasks", "B", "brief.md"), "# brief\n");
  mkdirSync(path.join(fx.node, "tasks", "B", "workspace"));
  assert.match(await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: plan("B") })), /letter B already has a folder in tasks\//);
  // A brief that is a link is not a brief.
  rmSync(path.join(fx.node, "tasks", "B"), { recursive: true });
  mkdirSync(path.join(fx.node, "tasks", "C"));
  write(path.join(fx.run, "elsewhere.md"), "x");
  symlinkSync(path.join(fx.run, "elsewhere.md"), path.join(fx.node, "tasks", "C", "brief.md"));
  assert.match(await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: plan("C") })), /letter C already has a folder in tasks\//);
  assert.equal(existsSync(path.join(fx.node, "rounds")), false, "nothing was written");
});

test("open_round counts a brief-only folder for a later letter as unused: the lower plan letters go through", async (t) => {
  const fx = fixture(t);
  write(path.join(fx.node, "tasks", "D", "brief.md"), "# brief D\n");
  assert.match(await openRound(fx.run, { nodeId: "E01", plan: plan("B", "D") }), /round 1\b/);
});

test("open_round on round 1 prepares the exploration split, so a missing split is refused at the owner with nothing written", async (t) => {
  const fx = fixture(t);
  rmSync(path.join(fx.run, "prep", "Z01-profile", "workspace", "split", "exploration.txt"));
  settle(fx.run);
  const before = subjects(fx.run).length;
  const message = await rejectMessage(openRound(fx.run, { nodeId: "E01", plan: plan("A") }));
  assert.match(message, /exploration\.txt is missing: the run has no split to analyse/);
  assert.equal(existsSync(path.join(fx.node, "rounds")), false);
  assert.equal(existsSync(path.join(fx.node, "tasks")), false);
  assert.equal(existsSync(path.join(fx.node, "workspace", "puzzle.md")), false);
  assert.equal(subjects(fx.run).length, before, "no commit");
  assert.equal(git(fx.run, "status", "--porcelain"), "");
});

test("open_round on round 1 copies the exploration files and keeps them out of git; round 2 does not need the split", async (t) => {
  const fx = fixture(t);
  await openRound(fx.run, { nodeId: "E01", plan: plan("A") });
  assert.equal(readFileSync(path.join(fx.run, "analysis-data", "exploration", "a.csv"), "utf8"), "a,1\n");
  assert.match(readFileSync(path.join(fx.run, ".gitignore"), "utf8"), /^analysis-data\/$/m);
  assert.equal(git(fx.run, "status", "--porcelain"), "", "the copy is ignored and the tree stays clean");
  finish(fx, 1, ["A"], ARGUMENT("v1"));
  await closeRound(fx.run, { nodeId: "E01", changed: "substantial", summary: "s" });
  rmSync(path.join(fx.run, "prep", "Z01-profile", "workspace", "split", "exploration.txt"));
  assert.match(await openRound(fx.run, { nodeId: "E01", plan: plan("B") }), /round 2\b/);
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

test("close_round's verdict commit holds the node's workspace/ and tasks/, and never .analysis/ or analysis-data/ (design §4)", async (t) => {
  const fx = fixture(t);
  await openRound(fx.run, { nodeId: "E01", plan: plan("A") });
  // Nothing hides the run-level scratch from git, so a sweeping commit would take it.
  write(path.join(fx.run, ".gitignore"), "");
  write(path.join(fx.run, ".analysis", "repro", "scratch.txt"), "scratch");
  write(path.join(fx.run, "analysis-data", "exploration", "a.csv"), "a,1\n");
  // The workers' files, deliberately not settled: they are pending until close_round.
  write(path.join(fx.node, "tasks", "A", "handoff.md"), "Status: DONE\n");
  write(path.join(fx.node, "tasks", "lit-01", "handoff.md"), "Status: DONE\n");
  write(path.join(fx.node, "workspace", "reports", "01.md"), "Round: 1\n");
  write(path.join(fx.node, "workspace", "argument.md"), ARGUMENT("v1"));
  write(path.join(fx.node, "workspace", "scripts", "A_01.R"), "x <- 1\n");
  write(path.join(fx.node, "workspace", "output", "numbers", "A_01.csv"), REGISTRY);
  await closeRound(fx.run, { nodeId: "E01", changed: "substantial", summary: "s" });

  const base = `${NODE_BASE}`;
  assert.equal(subjects(fx.run)[0], "[P3:verdict] E01 round 01 (substantial)");
  assert.deepEqual(
    lastFiles(fx.run),
    [
      "A\towners/phase-3/loop/E01/rounds.json",
      `A\t${base}/rounds/01/verdict.md`,
      `A\t${base}/tasks/A/handoff.md`,
      `A\t${base}/tasks/lit-01/handoff.md`,
      `A\t${base}/workspace/argument.md`,
      `A\t${base}/workspace/output/numbers/A_01.csv`,
      `A\t${base}/workspace/reports/01.md`,
      `A\t${base}/workspace/scripts/A_01.R`,
    ].sort(),
  );
  assert.equal(git(fx.run, "status", "--porcelain", "-uall").split("\n").filter((line) => line !== "" && !line.endsWith(".gitignore")).sort().join("|"), "?? .analysis/repro/scratch.txt|?? analysis-data/exploration/a.csv");
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

// ---------------------------------------------------------------------------
// reproduce and submit (design §9, §10)
// ---------------------------------------------------------------------------

const recordFile = (fx: Fixture) => path.join(loopDir(fx.run, "E01"), "reproduction.json");
const readRecord = (fx: Fixture) => JSON.parse(readFileSync(recordFile(fx), "utf8")) as { ok: boolean; workspaceHash: string; mismatches: string[] };

/** A node whose rounds have stopped, with a script, its registry, the argument, the reports and a review. */
async function closedOut(t: TestContext, rounds: Array<"substantial" | "none"> = ["substantial", "none", "none"]): Promise<Fixture> {
  const fx = fixture(t);
  write(inWorkspace(fx, "scripts", "A_01.R"), "# A\n");
  write(inWorkspace(fx, "output", "numbers", "A_01.csv"), REGISTRY);
  for (const [at, changed] of rounds.entries()) await runRound(fx, at + 1, [String.fromCharCode(65 + at)], changed);
  write(inWorkspace(fx, "argument.md"), ARGUMENT_FULL);
  for (let round = 1; round <= rounds.length; round++) write(inWorkspace(fx, "reports", `${String(round).padStart(2, "0")}.md`), REPORT_FULL(round));
  write(inWorkspace(fx, "scripts", "assets.R"), "# assets\n");
  write(inWorkspace(fx, "output", "assets", "_variables.yml"), ASSET_VARIABLES);
  write(inWorkspace(fx, "output", "assets", "variables_sources.csv"), ASSET_SOURCES);
  write(inWorkspace(fx, "reviews", "report.md"), review());
  write(inWorkspace(fx, "reviews", "revision.md"), REVISION);
  settle(fx.run);
  return fx;
}

/** A closed-out node that has been reproduced (ok) and passes every gate. */
async function reproduced(t: TestContext): Promise<Fixture> {
  const fx = await closedOut(t);
  const text = await reproduce(fx.run, { nodeId: "E01" }, { exec: fakeContainer().exec });
  assert.match(text, /reproduced/);
  assert.equal(readRecord(fx).ok, true);
  return fx;
}

const passCitations = () => [] as string[];
const submitOk = (fx: Fixture, note?: string) => submit(fx.run, { nodeId: "E01", note }, { citations: passCitations });
const submitMessage = (fx: Fixture) => rejectMessage(submit(fx.run, { nodeId: "E01" }, { citations: passCitations }));

test("reproduce is refused until a STOP is recorded, and writes nothing", async (t) => {
  const fx = await closedOut(t, ["substantial", "none"]);
  const before = subjects(fx.run).length;
  const fake = fakeContainer();
  assert.match(await rejectMessage(reproduce(fx.run, { nodeId: "E01" }, { exec: fake.exec })), /no STOP is recorded/);
  assert.equal(existsSync(recordFile(fx)), false);
  assert.deepEqual(fake.calls, [], "no script ran");
  assert.equal(subjects(fx.run).length, before);
  assert.equal(git(fx.run, "status", "--porcelain"), "");
});

test("reproduce refuses a node that is not an explanation in Phase 3", async (t) => {
  const fx = await closedOut(t);
  assert.match(await rejectMessage(reproduce(fx.run, { nodeId: "T01" }, { exec: fakeContainer().exec })), /not an explanation node/);
});

test("reproduce: a partial call says to call again, the next completes, and the record is committed", async (t) => {
  const fx = await closedOut(t);
  write(inWorkspace(fx, "scripts", "B_01.R"), "# B\n");
  write(inWorkspace(fx, "output", "numbers", "B_01.csv"), REGISTRY);
  settle(fx.run);
  const fake = fakeContainer({ delayMs: 60 });
  const first = await reproduce(fx.run, { nodeId: "E01" }, { exec: fake.exec, budgetMs: 30 });
  assert.match(first, /PARTIAL/);
  assert.match(first, /call reproduce again/);
  assert.equal(existsSync(recordFile(fx)), false, "a partial run records nothing");
  assert.equal(git(fx.run, "status", "--porcelain"), "", "the resume state does not dirty the tree");

  const second = await reproduce(fx.run, { nodeId: "E01" }, { exec: fake.exec, budgetMs: 30_000 });
  assert.match(second, /reproduced/);
  assert.deepEqual(fake.calls, ["A_01.R", "B_01.R", "assets.R"], "each script ran once: the second call resumed");
  const record = readRecord(fx);
  assert.deepEqual(record, { ok: true, workspaceHash: workspaceHash(fx.node), mismatches: [] });
  assert.equal(subjects(fx.run)[0], "[P3:reproduce] E01");
  assert.deepEqual(lastFiles(fx.run), ["A\towners/phase-3/loop/E01/reproduction.json"]);
  assert.equal(git(fx.run, "status", "--porcelain"), "");
});

test("reproduce records ok:false with the mismatches, and prints them", async (t) => {
  const fx = await closedOut(t);
  const drift = fakeContainer({ registry: "name,value,note\nn,1235,\n" });
  const text = await reproduce(fx.run, { nodeId: "E01" }, { exec: drift.exec });
  assert.match(text, /did NOT reproduce/);
  assert.match(text, /A_01\.csv "n": 1234 vs 1235/);
  const record = readRecord(fx);
  assert.equal(record.ok, false);
  assert.equal(record.mismatches.length, 1);
  assert.equal(git(fx.run, "status", "--porcelain"), "");
  assert.equal(subjects(fx.run)[0], "[P3:reproduce] E01");
});

test("reproduce: a completed ok:false run does not wedge the node: the next call re-runs the scripts and can succeed", async (t) => {
  const fx = await closedOut(t);
  const flaky = fakeContainer({ registry: "name,value,note\nn,1235,\n" });
  assert.match(await reproduce(fx.run, { nodeId: "E01" }, { exec: flaky.exec }), /did NOT reproduce/);
  assert.deepEqual(flaky.calls, ["A_01.R", "assets.R"]);
  assert.equal(readRecord(fx).ok, false);
  assert.match(await reproduce(fx.run, { nodeId: "E01" }, { exec: flaky.exec }), /did NOT reproduce/);
  assert.deepEqual(flaky.calls, ["A_01.R", "assets.R", "A_01.R", "assets.R"], "the second call ran the scripts again instead of repeating the old answer");

  const good = fakeContainer();
  assert.match(await reproduce(fx.run, { nodeId: "E01" }, { exec: good.exec }), /reproduced/);
  assert.deepEqual(good.calls, ["A_01.R", "assets.R"]);
  assert.equal(readRecord(fx).ok, true);
  assert.equal(git(fx.run, "status", "--porcelain"), "");
  await submitOk(fx);
});

test("reproduce records the hash taken before the scripts ran", async (t) => {
  const fx = await closedOut(t);
  const before = workspaceHash(fx.node);
  // An edit to the owner's registry while the scripts run is an edit after the check began.
  const racing = fakeContainer({ onRun: () => write(inWorkspace(fx, "output", "numbers", "A_01.csv"), "name,value,note\nn,1234,edited\n") });
  await reproduce(fx.run, { nodeId: "E01" }, { exec: racing.exec });
  assert.equal(readRecord(fx).workspaceHash, before);
  assert.notEqual(workspaceHash(fx.node), before);
  assert.match(await submitMessage(fx), /changed since the reproduction/);
});

test("reproduce reports a link planted in the reproduced registry, cleans up, and the next call starts fresh", async (t) => {
  const fx = await closedOut(t);
  const planting = fakeContainer({
    onRun: (host) => {
      if (!existsSync(path.join(host, "numbers", "L.csv"))) symlinkSync(path.join(host, "numbers", "A_01.csv"), path.join(host, "numbers", "L.csv"));
    },
  });
  const text = await reproduce(fx.run, { nodeId: "E01" }, { exec: planting.exec });
  assert.match(text, /did NOT reproduce/);
  assert.match(text, /L\.csv.*link/);
  const record = readRecord(fx);
  assert.equal(record.ok, false);
  assert.match(record.mismatches.join("\n"), /L\.csv.*link/);
  assert.equal(readdirSync(path.join(fx.run, ".analysis", "repro")).length, 0, "the scratch folder is gone");
  assert.equal(existsSync(path.join(fx.run, ".analysis", "repro-state")) && readdirSync(path.join(fx.run, ".analysis", "repro-state")).length > 0, false, "the state file is gone");
  assert.equal(git(fx.run, "status", "--porcelain"), "");

  const again = fakeContainer();
  assert.match(await reproduce(fx.run, { nodeId: "E01" }, { exec: again.exec }), /reproduced/);
  assert.deepEqual(again.calls, ["A_01.R", "assets.R"], "the scripts ran again from the start");
  assert.equal(readRecord(fx).ok, true);
});

test("reproduce does not follow a link where it cleans up", async (t) => {
  const fx = await closedOut(t);
  const outside = tempDir(t);
  write(path.join(outside, "keep.txt"), "keep");
  const planting = fakeContainer({
    onRun: (host) => {
      symlinkSync(path.join(host, "numbers", "A_01.csv"), path.join(host, "numbers", "L.csv"));
      symlinkSync(outside, path.join(host, "numbers", "out"));
    },
  });
  await reproduce(fx.run, { nodeId: "E01" }, { exec: planting.exec });
  assert.equal(readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep");
});

/** A folder outside the scratch holding sentinels where a cleanup would reach through a link: `names` are files in it, the node's folder name a sub-folder. */
function sentinelFolder(t: TestContext, fx: Fixture, names: string[]): string {
  const target = tempDir(t);
  for (const name of names) write(path.join(target, name), "keep");
  write(path.join(target, path.basename(fx.node), "sentinel.txt"), "keep");
  return target;
}

const listing = (dir: string) => readdirSync(dir, { recursive: true }).map(String).sort();

test("reproduce leaves a linked .analysis/repro alone, says so, records the failure, and submit refuses", async (t) => {
  const fx = await closedOut(t);
  const target = sentinelFolder(t, fx, ["other.txt"]);
  const before = listing(target);
  mkdirSync(path.join(fx.run, ".analysis"), { recursive: true });
  symlinkSync(target, path.join(fx.run, ".analysis", "repro"));
  const container = fakeContainer();
  const text = await reproduce(fx.run, { nodeId: "E01" }, { exec: container.exec });
  assert.match(text, /did NOT reproduce/);
  assert.match(text, /could not remove \.analysis\/repro\/E01-argument.*a link or a file is on its path/);
  assert.deepEqual(listing(target), before, "nothing in the linked folder was touched");
  assert.equal(readFileSync(path.join(target, "E01-argument", "sentinel.txt"), "utf8"), "keep");
  assert.deepEqual(container.calls, [], "no script ran through the link");
  assert.equal(readRecord(fx).ok, false);
  assert.match(await submitMessage(fx), /gate "reproduction"/);
  assert.equal(git(fx.run, "status", "--porcelain"), "");
});

test("reproduce leaves a linked .analysis/repro-state alone, says so, records the failure, and submit refuses", async (t) => {
  const fx = await closedOut(t);
  const target = sentinelFolder(t, fx, ["E01.json"]);
  const before = listing(target);
  mkdirSync(path.join(fx.run, ".analysis"), { recursive: true });
  symlinkSync(target, path.join(fx.run, ".analysis", "repro-state"));
  const container = fakeContainer();
  const text = await reproduce(fx.run, { nodeId: "E01" }, { exec: container.exec });
  assert.match(text, /did NOT reproduce/);
  assert.match(text, /could not remove \.analysis\/repro-state\/E01\.json.*a link or a file is on its path/);
  assert.deepEqual(listing(target), before, "the state file in the linked folder was neither deleted nor written");
  assert.equal(readFileSync(path.join(target, "E01.json"), "utf8"), "keep");
  assert.deepEqual(container.calls, [], "no script ran with its state behind a link");
  assert.equal(readRecord(fx).ok, false);
  assert.match(await submitMessage(fx), /gate "reproduction"/);
});

test("reproduce keeps a planted link in the reproduced registry a failure when .analysis/repro-state is a link too", async (t) => {
  const fx = await closedOut(t);
  const target = sentinelFolder(t, fx, ["E01.json"]);
  mkdirSync(path.join(fx.run, ".analysis"), { recursive: true });
  symlinkSync(target, path.join(fx.run, ".analysis", "repro-state"));
  const planting = fakeContainer({
    onRun: (host) => symlinkSync(path.join(host, "numbers", "A_01.csv"), path.join(host, "numbers", "L.csv")),
  });
  assert.match(await reproduce(fx.run, { nodeId: "E01" }, { exec: planting.exec }), /did NOT reproduce/);
  assert.equal(readFileSync(path.join(target, "E01.json"), "utf8"), "keep");
});

test("reproduce gitignores .analysis before it creates any scratch: a call stopped by its budget leaves the tree clean", async (t) => {
  const fx = await closedOut(t);
  assert.equal(existsSync(path.join(fx.run, ".analysis")), false);
  const text = await reproduce(fx.run, { nodeId: "E01" }, { exec: fakeContainer().exec, budgetMs: 0 });
  assert.match(text, /PARTIAL/);
  assert.equal(existsSync(path.join(fx.run, ".analysis", "repro")), true, "the scratch exists");
  assert.equal(git(fx.run, "status", "--porcelain"), "");
  assert.match(readFileSync(path.join(fx.run, ".gitignore"), "utf8"), /^\.analysis\/$/m);
});

test("readRounds refuses a rounds.json that is a link or not a regular file, rather than reading no rounds", async (t) => {
  const fx = await closedOut(t);
  const file = path.join(loopDir(fx.run, "E01"), "rounds.json");
  const bytes = readFileSync(file);
  rmSync(file);
  write(path.join(fx.run, "elsewhere-rounds.json"), bytes.toString("utf8"));
  symlinkSync(path.join(fx.run, "elsewhere-rounds.json"), file);
  assert.throws(() => readRounds(fx.run, "E01"), /rounds\.json is a link/);
  assert.match(await submitMessage(fx), /gate "STOP".*is a link/s);
  unlinkSync(file);
  mkdirSync(file);
  assert.throws(() => readRounds(fx.run, "E01"), /rounds\.json is not a regular file/);
  rmSync(file, { recursive: true });
  assert.deepEqual(readRounds(fx.run, "E01"), [], "an absent record is still no rounds");
});

test("reproduce and submit are registered for Phase 3 only", async (t) => {
  const fx = await closedOut(t);
  const phase3 = captureTools(t, fx.run, 3);
  setExecForTests(fakeContainer().exec);
  setCitationsForTests(passCitations);
  t.after(() => {
    setExecForTests(undefined);
    setCitationsForTests(undefined);
  });
  const done = await phase3.get("reproduce")!.execute("c1", { nodeId: "E01" });
  assert.match(done.content[0]!.text, /reproduced/);
  const submitted = await phase3.get("submit")!.execute("c2", { nodeId: "E01", note: "ready" });
  assert.match(submitted.content[0]!.text, /submitted E01/);
  for (const phase of [1, 2]) {
    const tools = captureTools(t, fx.run, phase);
    for (const name of ["reproduce", "submit"]) {
      assert.equal(await rejectMessage(tools.get(name)!.execute("c", { nodeId: "E01" })), `Not your phase: ${name} is a phase-3 tool and you own P${phase}`);
    }
  }
});

test("the extension's reproduce uses the budget hook", async (t) => {
  const fx = await closedOut(t);
  const phase3 = captureTools(t, fx.run, 3);
  setExecForTests(fakeContainer().exec);
  setBudgetForTests(0);
  t.after(() => {
    setExecForTests(undefined);
    setBudgetForTests(undefined);
  });
  const partial = await phase3.get("reproduce")!.execute("c1", { nodeId: "E01" });
  assert.match(partial.content[0]!.text, /PARTIAL/);
});

// --- submit: every gate in turn -------------------------------------------

test("submit succeeds when every gate holds: phase 4 ready, one commit named in the reply", async (t) => {
  const fx = await reproduced(t);
  const before = subjects(fx.run).length;
  const text = await submitOk(fx, "the argument is settled");
  const sha = git(fx.run, "rev-parse", "--short", "HEAD").trim();
  assert.match(text, /submitted E01/);
  assert.ok(text.includes(sha), `the reply names ${sha}: ${text}`);
  assert.match(text, /preregist/i);
  assert.equal(subjects(fx.run).length, before + 1, "one commit");
  assert.equal(subjects(fx.run)[0], "[P4:updateNode] E01 — status ready, phase 4, note");
  assert.match(git(fx.run, "log", "-1", "--format=%b").trim(), /the argument is settled/);
  assert.equal(git(fx.run, "status", "--porcelain"), "");
  const state = JSON.parse(readFileSync(path.join(fx.node, "node.json"), "utf8")) as { phase: number; status: string };
  assert.deepEqual([state.phase, state.status], [4, "ready"]);
});

test("submit still passes after an edit to argument.md, and the commit carries the edit", async (t) => {
  const fx = await reproduced(t);
  write(inWorkspace(fx, "argument.md"), `${ARGUMENT_FULL}\nA late sentence.\n`);
  await submitOk(fx);
  assert.match(git(fx.run, "show", "HEAD:" + `${NODE_BASE}/workspace/argument.md`), /A late sentence/);
  assert.equal(git(fx.run, "status", "--porcelain"), "");
});

test("submit refuses without a STOP", async (t) => {
  const fx = await closedOut(t, ["substantial", "none"]);
  assert.match(await submitMessage(fx), /gate "STOP"/);
});

test("submit refuses a node with no scripts (a vacuous reproduction must not pass)", async (t) => {
  const fx = await closedOut(t);
  // A reproduction of nothing: the record is ok, for the hash of the empty workspace.
  rmSync(inWorkspace(fx, "scripts", "A_01.R"));
  rmSync(inWorkspace(fx, "scripts", "assets.R"));
  rmSync(inWorkspace(fx, "output", "numbers", "A_01.csv"));
  rmSync(inWorkspace(fx, "output", "assets"), { recursive: true });
  write(inWorkspace(fx, "argument.md"), ARGUMENT_FULL.replace(/\n.*A_01\.csv.*\n/, "\nNo numbers.\n"));
  settle(fx.run);
  await reproduce(fx.run, { nodeId: "E01" }, { exec: fakeContainer().exec });
  assert.equal(readRecord(fx).ok, true, "the vacuous reproduction is ok, which is why submit must refuse it");
  assert.match(await submitMessage(fx), /gate "no scripts"/);
});

test("submit refuses on a check-argument problem", async (t) => {
  const fx = await reproduced(t);
  write(inWorkspace(fx, "argument.md"), ARGUMENT_FULL.replace("## Limitations", "Limitations"));
  const message = await submitMessage(fx);
  assert.match(message, /gate "check-argument"/);
  assert.match(message, /lacks the heading "## Limitations"/);
});

test("submit uses the injected citation check, and a citation problem refuses", async (t) => {
  const fx = await reproduced(t);
  const message = await rejectMessage(submit(fx.run, { nodeId: "E01" }, { citations: () => ["quote not found"] }));
  assert.match(message, /gate "check-argument"/);
  assert.match(message, /quote not found/);
});

test("submit takes its citation check from the test hook when none is passed", async (t) => {
  const fx = await reproduced(t);
  setCitationsForTests(() => ["hooked problem"]);
  t.after(() => setCitationsForTests(undefined));
  assert.match(await rejectMessage(submit(fx.run, { nodeId: "E01" })), /hooked problem/);
});

test("submit refuses without a reproduction record", async (t) => {
  const fx = await closedOut(t);
  const message = await submitMessage(fx);
  assert.match(message, /gate "reproduction"/);
  assert.match(message, /no reproduction record/);
});

test("submit refuses a failed reproduction", async (t) => {
  const fx = await closedOut(t);
  await reproduce(fx.run, { nodeId: "E01" }, { exec: fakeContainer({ registry: "name,value,note\nn,9,\n" }).exec });
  const message = await submitMessage(fx);
  assert.match(message, /gate "reproduction"/);
  assert.match(message, /did not reproduce/);
});

test("submit refuses a record it cannot read, whatever the reason (fail closed)", async (t) => {
  const fx = await reproduced(t);
  writeFileSync(recordFile(fx), "{not json");
  assert.match(await submitMessage(fx), /gate "reproduction".*unreadable/s);
  writeFileSync(recordFile(fx), JSON.stringify({ ok: true }));
  assert.match(await submitMessage(fx), /gate "reproduction".*unreadable/s);
  const real = readFileSync(recordFile(fx));
  rmSync(recordFile(fx));
  writeFileSync(path.join(fx.run, "elsewhere.json"), real);
  symlinkSync(path.join(fx.run, "elsewhere.json"), recordFile(fx));
  assert.match(await submitMessage(fx), /gate "reproduction".*link/s);
});

test("submit refuses a script edited after reproduce, and a number edited after it (Review Focus 4)", async (t) => {
  const fx = await reproduced(t);
  write(inWorkspace(fx, "scripts", "A_01.R"), "# A, edited after the check\n");
  const message = await submitMessage(fx);
  assert.match(message, /gate "reproduction"/);
  assert.match(message, /changed since the reproduction/);
  assert.notEqual(workspaceHash(fx.node), readRecord(fx).workspaceHash);

  write(inWorkspace(fx, "scripts", "A_01.R"), "# A\n");
  await submitOk(fx).catch(() => assert.fail("restoring the script restores the hash"));
});

test("submit refuses a registry number edited after reproduce", async (t) => {
  const fx = await reproduced(t);
  write(inWorkspace(fx, "output", "numbers", "A_01.csv"), "name,value,note\nn,1234,a new note\n");
  assert.match(await submitMessage(fx), /changed since the reproduction/);
});

test("submit refuses an assets file edited after reproduce, and the edit is caught by the hash", async (t) => {
  const fx = await reproduced(t);
  const before = workspaceHash(fx.node);
  write(inWorkspace(fx, "output", "assets", "_variables.yml"), 'n_pages: "9999"\n');
  assert.notEqual(workspaceHash(fx.node), before);
  const message = await submitMessage(fx);
  assert.match(message, /gate "reproduction"/);
  assert.match(message, /changed since the reproduction/);
  assert.match(message, /output\/assets/, "the refusal names the assets among what is hashed");

  write(inWorkspace(fx, "output", "assets", "_variables.yml"), ASSET_VARIABLES);
  await submitOk(fx).catch(() => assert.fail("restoring the file restores the hash"));
});

test("reproduce fails on a stale rendered value in _variables.yml, and submit refuses it", async (t) => {
  const fx = await closedOut(t);
  // The owner's assets were rendered from an older registry value; the assets script now writes the current one.
  write(inWorkspace(fx, "output", "assets", "_variables.yml"), 'n_pages: "1233"\n');
  const text = await reproduce(fx.run, { nodeId: "E01" }, { exec: fakeContainer().exec });
  assert.match(text, /did NOT reproduce/);
  assert.match(text, /output\/assets\/_variables\.yml/);
  assert.equal(readRecord(fx).ok, false);
  assert.match(await submitMessage(fx), /gate "reproduction".*output\/assets\/_variables\.yml/s);
});

test("reproduce and submit work for a workspace with no assets folder", async (t) => {
  const fx = await closedOut(t);
  rmSync(inWorkspace(fx, "scripts", "assets.R"));
  rmSync(inWorkspace(fx, "output", "assets"), { recursive: true });
  // check-argument wants the assets pair, so only reproduce is checked here.
  assert.match(await reproduce(fx.run, { nodeId: "E01" }, { exec: fakeContainer().exec }), /reproduced/);
  assert.equal(readRecord(fx).ok, true);
});

test("submit refuses without a review report", async (t) => {
  const fx = await reproduced(t);
  rmSync(inWorkspace(fx, "reviews", "report.md"));
  assert.match(await submitMessage(fx), /reviews\/report\.md is missing/);
});

test("submit refuses a BLOCKED review", async (t) => {
  const fx = await reproduced(t);
  write(inWorkspace(fx, "reviews", "report.md"), review("BLOCKED"));
  const message = await submitMessage(fx);
  assert.match(message, /gate "review"/);
  assert.match(message, /BLOCKED/);
});

test("submit refuses a finding with no revision line, and an overruled one with no reason", async (t) => {
  const fx = await reproduced(t);
  write(inWorkspace(fx, "reviews", "revision.md"), "nothing here\n");
  const missing = await submitMessage(fx);
  assert.match(missing, /gate "revision"/);
  assert.match(missing, /no ruling for F1/);
  rmSync(inWorkspace(fx, "reviews", "revision.md"));
  assert.match(await submitMessage(fx), /no ruling for F1/, "an absent revision.md rules on nothing");
  write(inWorkspace(fx, "reviews", "revision.md"), "F1: overruled --\n");
  assert.match(await submitMessage(fx), /F1 is overruled with no reason/);
  write(inWorkspace(fx, "reviews", "revision.md"), "F1: overruled - the registry row is in the reproduction\n");
  await submitOk(fx);
});

test("submit passes a review with no findings without a revision file", async (t) => {
  const fx = await reproduced(t);
  write(inWorkspace(fx, "reviews", "report.md"), review("DONE", ["None."]));
  rmSync(inWorkspace(fx, "reviews", "revision.md"));
  await submitOk(fx);
});

test("submit reads the review, the revision and the record without following a link", async (t) => {
  const fx = await reproduced(t);
  for (const name of ["report.md", "revision.md"]) {
    const file = inWorkspace(fx, "reviews", name);
    const bytes = readFileSync(file);
    rmSync(file);
    write(path.join(fx.run, `${name}.real`), bytes.toString("utf8"));
    symlinkSync(path.join(fx.run, `${name}.real`), file);
    assert.match(await submitMessage(fx), /is a link/, `${name} as a link`);
    unlinkSync(file);
    writeFileSync(file, bytes);
  }
  await submitOk(fx);
});

test("a refused submit makes no commit and leaves the node where it was", async (t) => {
  const fx = await reproduced(t);
  write(inWorkspace(fx, "reviews", "report.md"), review("BLOCKED"));
  settle(fx.run);
  const before = subjects(fx.run).length;
  await rejectMessage(submit(fx.run, { nodeId: "E01" }, { citations: passCitations }));
  assert.equal(subjects(fx.run).length, before);
  assert.equal(git(fx.run, "status", "--porcelain"), "");
  const state = JSON.parse(readFileSync(path.join(fx.node, "node.json"), "utf8")) as { phase: number; status: string };
  assert.deepEqual([state.phase, state.status], [3, "ready"]);
});

test("submit's reply names its own commit, not whatever HEAD is by the time it is read", async (t) => {
  const fx = await reproduced(t);
  const text = await submitOk(fx);
  const own = git(fx.run, "log", "-1", "--format=%h", "--grep", "[P4:updateNode] E01", "--fixed-strings").trim();
  git(fx.run, "commit", "--allow-empty", "-q", "-m", "an unrelated commit by another tool");
  assert.notEqual(git(fx.run, "rev-parse", "--short", "HEAD").trim(), own);
  assert.ok(text.includes(own), `the reply names ${own}: ${text}`);
  assert.equal(git(fx.run, "log", "-1", "--format=%s", own).trim(), "[P4:updateNode] E01 — status ready, phase 4");
});

test("submit's reply names the submit commit even when another commit lands as it finishes", async (t) => {
  const fx = await reproduced(t);
  // A post-commit hook makes another commit the moment the submit commit exists: HEAD has moved
  // on by the time submit builds its reply, which must still name its own commit.
  const hook = path.join(fx.run, ".git", "hooks", "post-commit");
  write(hook, `#!/bin/sh\nif git log -1 --format=%s | grep -qF '[P4:updateNode] E01'; then\n  git -c user.name=t -c user.email=t@t commit --allow-empty -q -m 'raced commit' --no-verify\nfi\n`);
  chmodSync(hook, 0o755);
  const text = await submitOk(fx);
  assert.equal(subjects(fx.run)[0], "raced commit", "another commit really landed after the submit commit");
  const own = git(fx.run, "rev-parse", "--short", "HEAD~1").trim();
  assert.ok(text.includes(own), `the reply names ${own}, not HEAD: ${text}`);
  assert.ok(!text.includes(git(fx.run, "rev-parse", "--short", "HEAD").trim()));
});

test("submit refuses a second time: the node is no longer in Phase 3", async (t) => {
  const fx = await reproduced(t);
  await submitOk(fx);
  assert.match(await submitMessage(fx), /Not your phase/);
});

// --- tree_update and tree_create ------------------------------------------

test("tree_update refuses submitted and a phase change on an explanation, but not other statuses", async (t) => {
  const fx = fixture(t);
  const tools = captureTools(t, fx.run, 3);
  const update = (params: Record<string, unknown>) => tools.get("tree_update")!.execute("c", { nodeId: "E01", ...params });
  assert.match(await rejectMessage(update({ status: "submitted" })), /use submit/);
  assert.match(await rejectMessage(update({ phase: 4 })), /use submit/);
  assert.match(await rejectMessage(update({ status: "ready", phase: 4 })), /use submit/);
  const active = await update({ status: "active" });
  assert.match(active.content[0]!.text, /E01 explanation 3 active/);
  const same = await update({ phase: 3, note: "no change" });
  assert.match(same.content[0]!.text, /E01 explanation 3/);
});

test("tree_create refuses an explanation under a puzzle that is not in Phase 3", async (t) => {
  const fx = fixture(t);
  const second = createChild(fx.run, "T01", "Another puzzle", "owner-p2");
  updateNode(fx.run, second.id, { phase: 2 }, "owner-p2");
  settle(fx.run);
  const before = subjects(fx.run).length;
  const phase2 = captureTools(t, fx.run, 2);
  const message = await rejectMessage(phase2.get("tree_create")!.execute("c", { parentId: second.id, title: "Too early" }));
  assert.match(message, /promote/);
  assert.match(message, /Phase 3/);
  assert.equal(subjects(fx.run).length, before);

  const phase3 = captureTools(t, fx.run, 3);
  const made = await phase3.get("tree_create")!.execute("c", { parentId: "P01", title: "Second take" });
  assert.match(made.content[0]!.text, /created E02 explanation 3 ready/);
});
