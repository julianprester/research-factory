import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { decide, viewPhase, type Memory, type PhaseView } from "../supervisor.ts";
import { createChild, initRun, updateNode } from "../tree.ts";

function makeRun(t: TestContext): string {
  const runDir = mkdtempSync(path.join(tmpdir(), "ctc-supervisor-"));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  return runDir;
}

function view(partial: Partial<PhaseView> & { phase: number }): PhaseView {
  return { owner: "idle", ready: [], running: [], finished: [], ...partial };
}

function memory(head = "head-1"): Memory {
  return { head, nudges: {}, stalled: [], doneStreak: 0 };
}

test("a gone owner is restarted", () => {
  const result = decide([view({ phase: 1, owner: "gone", ready: ["T01"] })], {}, "head-1", memory());
  assert.deepEqual(result.actions, [{ kind: "restart", phase: 1 }]);
});

test("an idle owner whose workers are running is left alone", () => {
  const result = decide([view({ phase: 1, running: ["T01"] })], {}, "head-1", memory());
  assert.deepEqual(result.actions, [], "no nudge and not done");
});

test("an idle owner is nudged when a handoff is waiting", () => {
  const result = decide([view({ phase: 1, finished: ["T01"] })], {}, "head-1", memory());
  assert.equal(result.actions.length, 1);
  const action = result.actions[0];
  assert.equal(action.kind, "nudge");
  if (action.kind !== "nudge") return;
  assert.match(action.message, /Continue phase 1/);
  assert.ok(action.message.includes("T01"), action.message);
});

test("a nudge names the ready nodes and the waiting handoffs", () => {
  const result = decide([view({ phase: 2, ready: ["T03", "T04"], finished: ["T01"] })], {}, "head-1", memory());
  assert.deepEqual(result.actions, [
    {
      kind: "nudge",
      phase: 2,
      message: "Continue phase 2: ready T03, T04; handoffs waiting in T01. Trust tree_list and your ledger.",
    },
  ]);
});

test("a working owner with ready nodes is left alone", () => {
  const result = decide([view({ phase: 1, owner: "working", ready: ["T01"] })], {}, "head-1", memory());
  assert.deepEqual(result.actions, []);
});

test("blocked and unknown owners are left alone", () => {
  for (const owner of ["blocked", "unknown"] as const) {
    const result = decide([view({ phase: 1, owner, ready: ["T01"] })], {}, "head-1", memory());
    assert.deepEqual(result.actions, [], owner);
  }
});

test("an owner stalls after three nudges at the same head", () => {
  const phase1 = view({ phase: 1, ready: ["T01"] });
  let state: Memory = { head: "head-1", nudges: {}, stalled: [], doneStreak: 0 };
  for (let call = 1; call <= 3; call++) {
    const result = decide([phase1], {}, "head-1", state);
    assert.equal(result.actions[0]?.kind, "nudge", `call ${call} nudges`);
    state = result.memory;
  }
  assert.deepEqual(state.nudges, { 1: 3 });

  const fourth = decide([phase1], {}, "head-1", state);
  assert.deepEqual(fourth.actions, [{ kind: "stalled", phase: 1 }], "the fourth becomes stalled, once");
  assert.deepEqual(fourth.memory.stalled, [1]);

  const fifth = decide([phase1], {}, "head-1", fourth.memory);
  assert.deepEqual(fifth.actions, [], "a stalled phase gets no further nudges");

  const moved = decide([phase1], {}, "head-2", fifth.memory);
  assert.equal(moved.actions[0]?.kind, "nudge", "a new head starts nudging again");
  assert.deepEqual(moved.memory, { head: "head-2", nudges: { 1: 1 }, stalled: [], doneStreak: 0 });
});

test("the run is done after two consecutive empty ticks", () => {
  const empty = view({ phase: 1 });
  const first = decide([empty], { 2: 2 }, "head-1", memory());
  assert.deepEqual(first.actions, [], "one empty tick is not enough");
  assert.equal(first.memory.doneStreak, 1);
  const second = decide([empty], { 2: 2 }, "head-1", first.memory);
  assert.deepEqual(second.actions, [{ kind: "done", waitingForUnownedPhases: { 2: 2 } }]);
});

test("done wins over restart, even for a gone owner", () => {
  const gone = view({ phase: 1, owner: "gone" });
  const first = decide([gone], {}, "head-1", memory());
  assert.deepEqual(first.actions, [], "no done yet, and no restart either");
  const second = decide([gone], {}, "head-1", first.memory);
  assert.deepEqual(second.actions, [{ kind: "done", waitingForUnownedPhases: {} }]);
});

test("an owned phase with no nodes and an idle owner is not done on the first tick", () => {
  // Regression: run.sh used to start the supervisor before prompting the owner,
  // so the first tick saw exactly this and ended the run unsupervised.
  const result = decide([view({ phase: 1, owner: "idle" })], {}, "head-1", memory());
  assert.deepEqual(result.actions, []);
  assert.equal(result.memory.doneStreak, 1);
});

test("work between two empty ticks resets the done streak", () => {
  const empty = view({ phase: 1 });
  const first = decide([empty], {}, "head-1", memory());
  assert.deepEqual(first.actions, []);
  assert.equal(first.memory.doneStreak, 1);

  const withWork = decide([view({ phase: 1, ready: ["T01"] })], {}, "head-1", first.memory);
  assert.equal(withWork.actions[0]?.kind, "nudge");
  assert.equal(withWork.memory.doneStreak, 0, "work resets the streak");

  const third = decide([empty], {}, "head-1", withWork.memory);
  assert.deepEqual(third.actions, [], "the streak starts over at one");
  const fourth = decide([empty], {}, "head-1", third.memory);
  assert.deepEqual(fourth.actions, [{ kind: "done", waitingForUnownedPhases: {} }]);
});

test("viewPhase splits a phase's nodes into ready, running and finished", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  const first = createChild(run, "D01", "One", "t");
  createChild(run, "D01", "Two", "t");
  createChild(run, "D01", "Three", "t");
  updateNode(run, "T01", { status: "active" }, "t");
  updateNode(run, "T02", { status: "active" }, "t");
  writeFileSync(path.join(first.dir, "handoff.md"), "Status: DONE\n");

  assert.deepEqual(viewPhase(run, 1, "idle"), {
    phase: 1,
    owner: "idle",
    ready: ["T03"],
    running: ["T02"],
    finished: ["T01"],
  });
  assert.deepEqual(viewPhase(run, 2, "working"), { phase: 2, owner: "working", ready: [], running: [], finished: [] });
});
