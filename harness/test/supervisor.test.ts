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
  return { head, nudges: {}, stalled: [] };
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
  let state: Memory = { head: "head-1", nudges: {}, stalled: [] };
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
  assert.deepEqual(moved.memory, { head: "head-2", nudges: { 1: 1 }, stalled: [] });
});

test("the run is done when no owned phase has work", () => {
  const result = decide([view({ phase: 1 })], { 2: 2 }, "head-1", memory());
  assert.deepEqual(result.actions, [{ kind: "done", waitingForUnownedPhases: { 2: 2 } }]);
});

test("done wins over restart, even for a gone owner", () => {
  const result = decide([view({ phase: 1, owner: "gone" })], {}, "head-1", memory());
  assert.deepEqual(result.actions, [{ kind: "done", waitingForUnownedPhases: {} }]);
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
