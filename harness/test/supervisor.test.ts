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

/** A configured, already-started phase by default; tests override what they exercise. */
function view(partial: Partial<PhaseView> & { phase: number }): PhaseView {
  return { owner: "idle", configured: true, started: true, ready: [], running: [], finished: [], ...partial };
}

function memory(head = "head-1"): Memory {
  return { head, nudges: {}, stalled: [], doneStreak: 0 };
}

test("a gone owner whose phase has ready work is started", () => {
  const result = decide([view({ phase: 1, owner: "gone", ready: ["T01"] })], "head-1", memory());
  assert.deepEqual(result.actions, [{ kind: "start", phase: 1, reason: "gone" }]);
});

test("a gone owner whose phase still has running workers is started again", () => {
  const result = decide([view({ phase: 1, owner: "gone", running: ["T01"] })], "head-1", memory());
  assert.deepEqual(result.actions, [{ kind: "start", phase: 1, reason: "gone" }]);
});

test("a phase that was never started is started when it has work", () => {
  const result = decide([view({ phase: 1, owner: "gone", started: false, ready: ["T02"] })], "head-1", memory());
  assert.deepEqual(result.actions, [{ kind: "start", phase: 1, reason: "never-started" }]);
});

test("a gone owner with no work is never started", () => {
  for (const started of [true, false]) {
    const first = decide([view({ phase: 1, owner: "gone", started })], "head-1", memory());
    assert.deepEqual(first.actions, [], `started ${started}: no start without work`);
    const second = decide([view({ phase: 1, owner: "gone", started })], "head-1", first.memory);
    assert.deepEqual(second.actions, [{ kind: "done", waitingForUnconfiguredPhases: {} }], "done instead");
  }
});

test("an idle owner whose workers are running is left alone", () => {
  const result = decide([view({ phase: 1, running: ["T01"] })], "head-1", memory());
  assert.deepEqual(result.actions, [], "no nudge and not done");
});

test("an idle owner is nudged when a handoff is waiting", () => {
  const result = decide([view({ phase: 1, finished: ["T01"] })], "head-1", memory());
  assert.equal(result.actions.length, 1);
  const action = result.actions[0];
  assert.equal(action.kind, "nudge");
  if (action.kind !== "nudge") return;
  assert.match(action.message, /Continue phase 1/);
  assert.ok(action.message.includes("T01"), action.message);
});

test("a nudge names the ready nodes and the waiting handoffs", () => {
  const result = decide([view({ phase: 2, ready: ["T03", "T04"], finished: ["T01"] })], "head-1", memory());
  assert.deepEqual(result.actions, [
    {
      kind: "nudge",
      phase: 2,
      message: "Continue phase 2: ready T03, T04; handoffs waiting in T01. Trust tree_list and your ledger.",
    },
  ]);
});

test("a working owner with ready nodes is left alone", () => {
  const result = decide([view({ phase: 1, owner: "working", ready: ["T01"] })], "head-1", memory());
  assert.deepEqual(result.actions, []);
});

test("blocked and unknown owners are left alone", () => {
  for (const owner of ["blocked", "unknown"] as const) {
    const result = decide([view({ phase: 1, owner, ready: ["T01"] })], "head-1", memory());
    assert.deepEqual(result.actions, [], owner);
  }
});

test("an unconfigured phase with work is never started or nudged; it is reported at done", () => {
  const configuredQuiet = view({ phase: 1 });
  const unconfigured = view({ phase: 2, owner: "gone", started: false, configured: false, ready: ["T03", "T04"] });

  const first = decide([configuredQuiet, unconfigured], "head-1", memory());
  assert.deepEqual(first.actions, [], "no start for an unconfigured phase");
  assert.equal(first.memory.doneStreak, 1);

  const second = decide([configuredQuiet, unconfigured], "head-1", first.memory);
  assert.deepEqual(second.actions, [{ kind: "done", waitingForUnconfiguredPhases: { 2: 2 } }]);
});

test("an unconfigured phase with an idle owner and ready nodes is never nudged", () => {
  const unconfigured = view({ phase: 2, configured: false, ready: ["T03"] });
  const first = decide([unconfigured], "head-1", memory());
  assert.deepEqual(first.actions, []);
  const second = decide([unconfigured], "head-1", first.memory);
  assert.deepEqual(second.actions, [{ kind: "done", waitingForUnconfiguredPhases: { 2: 1 } }]);
});

test("an owner stalls after three nudges at the same head", () => {
  const phase1 = view({ phase: 1, ready: ["T01"] });
  let state: Memory = { head: "head-1", nudges: {}, stalled: [], doneStreak: 0 };
  for (let call = 1; call <= 3; call++) {
    const result = decide([phase1], "head-1", state);
    assert.equal(result.actions[0]?.kind, "nudge", `call ${call} nudges`);
    state = result.memory;
  }
  assert.deepEqual(state.nudges, { 1: 3 });

  const fourth = decide([phase1], "head-1", state);
  assert.deepEqual(fourth.actions, [{ kind: "stalled", phase: 1 }], "the fourth becomes stalled, once");
  assert.deepEqual(fourth.memory.stalled, [1]);

  const fifth = decide([phase1], "head-1", fourth.memory);
  assert.deepEqual(fifth.actions, [], "a stalled phase gets no further nudges");

  const moved = decide([phase1], "head-2", fifth.memory);
  assert.equal(moved.actions[0]?.kind, "nudge", "a new head starts nudging again");
  assert.deepEqual(moved.memory, { head: "head-2", nudges: { 1: 1 }, stalled: [], doneStreak: 0 });
});

test("the run is done after two consecutive empty ticks", () => {
  const empty = view({ phase: 1 });
  const first = decide([empty], "head-1", memory());
  assert.deepEqual(first.actions, [], "one empty tick is not enough");
  assert.equal(first.memory.doneStreak, 1);
  const second = decide([empty], "head-1", first.memory);
  assert.deepEqual(second.actions, [{ kind: "done", waitingForUnconfiguredPhases: {} }]);
});

test("an owned phase with no nodes and an idle owner is not done on the first tick", () => {
  // Regression: run.sh used to start the supervisor before prompting the owner,
  // so the first tick saw exactly this and ended the run unsupervised.
  const result = decide([view({ phase: 1, owner: "idle" })], "head-1", memory());
  assert.deepEqual(result.actions, []);
  assert.equal(result.memory.doneStreak, 1);
});

test("work between two empty ticks resets the done streak", () => {
  const empty = view({ phase: 1 });
  const first = decide([empty], "head-1", memory());
  assert.deepEqual(first.actions, []);
  assert.equal(first.memory.doneStreak, 1);

  const withWork = decide([view({ phase: 1, ready: ["T01"] })], "head-1", first.memory);
  assert.equal(withWork.actions[0]?.kind, "nudge");
  assert.equal(withWork.memory.doneStreak, 0, "work resets the streak");

  const third = decide([empty], "head-1", withWork.memory);
  assert.deepEqual(third.actions, [], "the streak starts over at one");
  const fourth = decide([empty], "head-1", third.memory);
  assert.deepEqual(fourth.actions, [{ kind: "done", waitingForUnconfiguredPhases: {} }]);
});

test("a fresh run's entry phase has work and is started, not done", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  const fresh = viewPhase(run, 1, "gone", { configured: true, started: false, entry: true });
  assert.deepEqual(fresh, {
    phase: 1,
    owner: "gone",
    configured: true,
    started: false,
    ready: ["(entry)"],
    running: [],
    finished: [],
  });
  const result = decide([fresh], "head-1", memory());
  assert.deepEqual(result.actions, [{ kind: "start", phase: 1, reason: "never-started" }]);
});

test("the entry marker applies only while the tree has nothing but the root", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  createChild(run, "D01", "One", "t");
  const entry = viewPhase(run, 1, "idle", { configured: true, started: false, entry: true });
  assert.deepEqual(entry.ready, ["T01"], "the existing node is the work, not the entry marker");
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

  assert.deepEqual(viewPhase(run, 1, "idle", { configured: true, started: false, entry: false }), {
    phase: 1,
    owner: "idle",
    configured: true,
    started: false,
    ready: ["T03"],
    running: ["T02"],
    finished: ["T01"],
  });
  assert.deepEqual(viewPhase(run, 2, "working", { configured: false, started: false, entry: false }), {
    phase: 2,
    owner: "working",
    configured: false,
    started: false,
    ready: [],
    running: [],
    finished: [],
  });
});
