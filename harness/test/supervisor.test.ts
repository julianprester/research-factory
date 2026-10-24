import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { STALL_RETRY_MS, decide, phasesWithNodes, viewPhase, type Memory, type PhaseView } from "../supervisor.ts";
import { createChild, findNode, initRun, updateNode } from "../tree.ts";

function makeRun(t: TestContext): string {
  const runDir = mkdtempSync(path.join(tmpdir(), "ctc-supervisor-"));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  return runDir;
}

/** A configured, already-started phase by default; tests override what they exercise. */
function view(partial: Partial<PhaseView> & { phase: number }): PhaseView {
  return { owner: "idle", configured: true, started: true, ready: [], running: [], finished: [], inputs: [], ...partial };
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

test("a nudge states the ready and handoff counts without ordering a dispatch", () => {
  const result = decide([view({ phase: 2, ready: ["T03", "T04"], finished: ["T01"] })], "head-1", memory());
  assert.deepEqual(result.actions, [
    {
      kind: "nudge",
      phase: 2,
      message:
        "Continue phase 2: 2 ready, 1 handoffs waiting (T03, T04, T01). Trust tree_list and your ledger; your phase skill's limits still apply.",
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
  assert.deepEqual(moved.memory, { head: "head-2", nudges: { 1: 1 }, stalled: [], doneStreak: 0, stalledAt: {} });
});

test("a stalled phase gets one more nudge after STALL_RETRY_MS with no new commit, then stalls again", () => {
  const phase1 = view({ phase: 1, ready: ["T01"] });
  let state: Memory = memory();
  for (let call = 1; call <= 3; call++) state = decide([phase1], "head-1", state, 0).memory;
  const stalled = decide([phase1], "head-1", state, 1_000);
  assert.deepEqual(stalled.actions, [{ kind: "stalled", phase: 1 }]);

  const early = decide([phase1], "head-1", stalled.memory, 1_000 + STALL_RETRY_MS - 1);
  assert.deepEqual(early.actions, [], "no retry before the cool-down ends");

  const retry = decide([phase1], "head-1", early.memory, 1_000 + STALL_RETRY_MS);
  assert.equal(retry.actions[0]?.kind, "nudge", "the cool-down earns one nudge");
  assert.deepEqual(retry.memory.stalled, [], "the phase is not stalled while it is being retried");

  const again = decide([phase1], "head-1", retry.memory, 1_000 + STALL_RETRY_MS + 60_000);
  assert.deepEqual(again.actions, [{ kind: "stalled", phase: 1 }], "still no commit: stalled again, once");
  const quiet = decide([phase1], "head-1", again.memory, 1_000 + STALL_RETRY_MS + 120_000);
  assert.deepEqual(quiet.actions, [], "and quiet until the next cool-down");
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

test("a real phase-1 input hand-off is started, nudged and done once closed", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  // Phase 0 hands its assembler on as the Phase 1 job list.
  createChild(run, "D01", "Assemble", "owner-p0", [], "prep");
  updateNode(run, "Z01", { phase: 1, status: "input" }, "owner-p0");

  const fresh = viewPhase(run, 1, "gone", { configured: true, started: false, entry: false });
  assert.deepEqual(fresh.inputs, ["Z01"]);
  assert.deepEqual(fresh.ready, []);
  assert.deepEqual(decide([fresh], "head-1", memory()).actions, [
    { kind: "start", phase: 1, reason: "never-started" },
  ]);

  const idle = viewPhase(run, 1, "idle", { configured: true, started: true, entry: false });
  const nudged = decide([idle], "head-1", memory());
  assert.equal(nudged.actions[0]?.kind, "nudge");
  assert.match(
    nudged.actions[0]?.kind === "nudge" ? nudged.actions[0].message : "",
    /open input node \(Z01\).*close the input node/,
  );

  updateNode(run, "Z01", { status: "closed" }, "owner-p1");
  const closed = viewPhase(run, 1, "idle", { configured: true, started: true, entry: false });
  assert.deepEqual(closed.inputs, [], "the closed input node is no work");
  const quiet = decide([closed], "head-1", nudged.memory);
  assert.deepEqual(quiet.actions, []);
  const done = decide([closed], "head-1", quiet.memory);
  assert.deepEqual(done.actions, [{ kind: "done", waitingForUnconfiguredPhases: {} }]);
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
    inputs: [],
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

test("a fresh run's phase 0 is the entry phase, and the hand-off leaves it with no work", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");

  const fresh = viewPhase(run, 0, "gone", { configured: true, started: false, entry: true });
  assert.deepEqual(fresh, {
    phase: 0,
    owner: "gone",
    configured: true,
    started: false,
    ready: ["(entry)"],
    running: [],
    finished: [],
    inputs: [],
  });
  assert.deepEqual(decide([fresh], "head-1", memory()).actions, [
    { kind: "start", phase: 0, reason: "never-started" },
  ]);

  // The Phase 0 owner creates Z01 and Z02, closes Z01 and hands Z02 to phase 1.
  createChild(run, "D01", "Profile", "owner-p0", [], "prep");
  createChild(run, "D01", "Assemble", "owner-p0", [], "prep");
  updateNode(run, "Z01", { status: "closed" }, "owner-p0");
  updateNode(run, "Z02", { phase: 1, status: "ready" }, "owner-p0");

  assert.deepEqual(viewPhase(run, 0, "idle", { configured: true, started: true, entry: true }), {
    phase: 0,
    owner: "idle",
    configured: true,
    started: true,
    ready: [],
    running: [],
    finished: [],
    inputs: [],
  });
  assert.deepEqual(viewPhase(run, 1, "gone", { configured: true, started: false, entry: false }).ready, ["Z02"]);
});

test("phasesWithNodes includes phase 0 prep nodes and skips only the root", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  assert.deepEqual(phasesWithNodes(run), [], "the root alone is no phase");

  createChild(run, "D01", "Profile", "t", [], "prep");
  assert.deepEqual(phasesWithNodes(run), [0], "prep nodes are phase 0 work");

  createChild(run, "D01", "One", "t");
  createChild(run, "T01", "Why?", "t");
  assert.deepEqual(phasesWithNodes(run), [0, 1], "phase 1 and its children are one phase");
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
    inputs: [],
  });
  assert.deepEqual(viewPhase(run, 2, "working", { configured: false, started: false, entry: false }), {
    phase: 2,
    owner: "working",
    configured: false,
    started: false,
    ready: [],
    running: [],
    finished: [],
    inputs: [],
  });
});

test("viewPhase reports an input node as an input, not as ready", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  // A real Phase 0 leaves its assembler as Z07, handed on to phase 1 as input.
  for (let n = 1; n <= 7; n++) createChild(run, "D01", `Node ${n}`, "t", [], "prep");
  updateNode(run, "Z07", { phase: 1, status: "input" }, "t");

  const view1 = viewPhase(run, 1, "idle", { configured: true, started: true, entry: false });
  assert.deepEqual(view1.inputs, ["Z07"]);
  assert.deepEqual(view1.ready, [], "an input node is not queued work");
  assert.deepEqual(view1.running, []);
  assert.deepEqual(view1.finished, []);
});

test("an input node alone earns a gone owner a start", () => {
  const result = decide([view({ phase: 1, owner: "gone", inputs: ["Z07"] })], "head-1", memory());
  assert.deepEqual(result.actions, [{ kind: "start", phase: 1, reason: "gone" }]);
});

test("an idle or done owner with only an input node is nudged to close or continue", () => {
  for (const owner of ["idle", "done"] as const) {
    const result = decide([view({ phase: 1, owner, inputs: ["Z07"] })], "head-1", memory());
    assert.equal(result.actions.length, 1, `${owner}: one action`);
    const action = result.actions[0];
    assert.equal(action?.kind, "nudge");
    assert.equal(
      action?.kind === "nudge" ? action.message : "",
      "Phase 1 has an open input node (Z07) and no work in flight. If the phase is complete, close the input node; otherwise create and dispatch the next nodes. Your phase skill's limits still apply.",
    );
    assert.deepEqual(result.memory.nudges, { 1: 1 });
  }
});

test("ready or finished work beside an input node keeps the usual nudge", () => {
  const result = decide([view({ phase: 1, inputs: ["Z07"], ready: ["T01"] })], "head-1", memory());
  const action = result.actions[0];
  assert.equal(action?.kind, "nudge");
  assert.match(action?.kind === "nudge" ? action.message : "", /^Continue phase 1: 1 ready, 0 handoffs waiting/);
});

test("an input-only phase stalls after three nudges at the same head", () => {
  const phase1 = view({ phase: 1, inputs: ["Z07"] });
  let state = memory();
  for (let call = 1; call <= 3; call++) {
    const result = decide([phase1], "head-1", state);
    assert.equal(result.actions[0]?.kind, "nudge", `call ${call} nudges`);
    state = result.memory;
  }
  assert.deepEqual(decide([phase1], "head-1", state).actions, [{ kind: "stalled", phase: 1 }]);
});

test("running workers beside an input node leave the owner alone", () => {
  const result = decide([view({ phase: 1, inputs: ["Z07"], running: ["T01"] })], "head-1", memory());
  assert.deepEqual(result.actions, []);
});

test("closing the input node leaves no work: two quiet ticks finish the run", () => {
  const closed = view({ phase: 1 });
  const first = decide([view({ phase: 1, inputs: ["Z07"] })], "head-1", memory());
  assert.equal(first.actions[0]?.kind, "nudge");
  const second = decide([closed], "head-1", first.memory);
  assert.deepEqual(second.actions, []);
  const third = decide([closed], "head-1", second.memory);
  assert.deepEqual(third.actions, [{ kind: "done", waitingForUnconfiguredPhases: {} }]);
});

test("a phase-2 tree with an open input node is never done, and closes to done after two quiet ticks", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  // A Phase 1 pattern handed on as the Phase 2 owner's input, with two puzzles:
  // one running, one already submitted.
  createChild(run, "D01", "E03 Etiquette", "owner-p1");
  updateNode(run, "T01", { phase: 2, status: "input" }, "owner-p1");
  const running = createChild(run, "T01", "status quo: crowd", "owner-p2");
  const submitted = createChild(run, "T01", "different level: rooms", "owner-p2");
  updateNode(run, running.id, { status: "active" }, "owner-p2");
  updateNode(run, submitted.id, { status: "submitted" }, "owner-p2");
  assert.equal(findNode(run, submitted.id).phase, 2, "a puzzle child stays in its pattern's phase");

  const view = (owner: "idle" | "gone" | "working", started = true): PhaseView =>
    viewPhase(run, 2, owner, { configured: true, started, entry: false });

  // The pattern node is the open input; the active puzzle (no handoff) is running.
  assert.deepEqual(view("idle").inputs, ["T01"]);
  assert.deepEqual(view("idle").running, [running.id]);
  assert.deepEqual(view("idle").ready, []);

  // An idle owner is left alone while a worker runs, and a gone owner is started.
  assert.deepEqual(decide([view("idle")], "head-1", memory()).actions, [], "running puzzles suppress the nudge");
  assert.deepEqual(decide([view("gone", false)], "head-1", memory()).actions, [
    { kind: "start", phase: 2, reason: "never-started" },
  ]);

  // The puzzle is submitted: only the open input is left, so an idle owner is
  // nudged to finish the phase and close it - and the run is never done.
  updateNode(run, running.id, { status: "submitted" }, "owner-p2");
  const quiet = view("idle");
  assert.deepEqual(quiet.inputs, ["T01"]);
  assert.deepEqual(quiet.running, []);

  let state = memory();
  let result = decide([quiet], "head-1", state);
  assert.equal(result.actions[0]?.kind, "nudge");
  const nudge = result.actions[0];
  assert.equal(
    nudge?.kind === "nudge" ? nudge.message : "",
    "Phase 2 has an open input node (T01) and no work in flight. If the phase is complete, close the input node; otherwise create and dispatch the next nodes. Your phase skill's limits still apply.",
  );
  state = result.memory;
  for (let tick = 0; tick < 5; tick++) {
    result = decide([quiet], "head-1", state);
    assert.ok(
      result.actions.every((action) => action.kind !== "done"),
      `the open input node keeps the run alive: ${JSON.stringify(result.actions)}`,
    );
    state = result.memory;
  }

  // Closing the pattern node leaves nothing running or queued: two quiet ticks
  // finish the run.
  updateNode(run, "T01", { status: "closed" }, "owner-p2");
  const closed = view("idle");
  assert.deepEqual(closed.inputs, []);
  const firstQuiet = decide([closed], "head-2", memory());
  assert.deepEqual(firstQuiet.actions, []);
  const secondQuiet = decide([closed], "head-2", firstQuiet.memory);
  assert.deepEqual(secondQuiet.actions, [{ kind: "done", waitingForUnconfiguredPhases: {} }]);
});

test("a phase-3 tree: never-started, then an explanation that runs, then done with phase 4 waiting", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  // A pattern, and a puzzle under it promoted to Phase 3 and waiting for its owner.
  createChild(run, "D01", "E03 Etiquette", "owner-p1");
  const puzzle = createChild(run, "T01", "status quo: crowd", "owner-p2");
  updateNode(run, puzzle.id, { phase: 3, status: "ready" }, "owner-p2");
  updateNode(run, "T01", { status: "closed" }, "owner-p2");

  const view = (owner: "idle" | "gone" | "working", started = true, phase = 3): PhaseView =>
    viewPhase(run, phase, owner, { configured: phase !== 4, started, entry: false });

  // A ready puzzle and no owner: start it.
  assert.deepEqual(view("gone", false).ready, [puzzle.id]);
  assert.deepEqual(decide([view("gone", false)], "head-1", memory()).actions, [
    { kind: "start", phase: 3, reason: "never-started" },
  ]);

  // The owner takes the puzzle as its input and creates the explanation, active, with no node handoff.
  updateNode(run, puzzle.id, { status: "input" }, "owner-p3");
  const explanation = createChild(run, puzzle.id, "Argument", "owner-p3");
  assert.equal(explanation.phase, 3, "an explanation stays in its puzzle's phase");
  updateNode(run, explanation.id, { status: "active" }, "owner-p3");
  const running = view("idle");
  assert.deepEqual(running.inputs, [puzzle.id]);
  assert.deepEqual(running.running, [explanation.id], "no node-level handoff.md: it is running, not finished");
  assert.deepEqual(running.finished, []);

  // Not done and not nudged while it runs, however many ticks pass.
  let state = memory();
  for (let tick = 0; tick < 5; tick++) {
    const result = decide([running], "head-1", state);
    assert.deepEqual(result.actions, [], `tick ${tick}: left alone`);
    state = result.memory;
  }

  // A running explanation alone (its puzzle already closed) is work in flight too: still not done.
  updateNode(run, puzzle.id, { status: "closed" }, "owner-p3");
  const alone = view("idle");
  assert.deepEqual([alone.inputs, alone.running], [[], [explanation.id]]);
  for (let tick = 0; tick < 5; tick++) {
    const result = decide([alone], "head-1", state);
    assert.deepEqual(result.actions, [], `tick ${tick}: running work is not done and not nudged`);
    state = result.memory;
  }

  // The explanation is submitted to Phase 4 (no skill) and the puzzle closed: two quiet ticks finish the run.
  updateNode(run, explanation.id, { phase: 4, status: "ready" }, "owner-p3");
  updateNode(run, puzzle.id, { status: "closed" }, "owner-p3");
  const phase3 = view("idle");
  const phase4 = view("idle", false, 4);
  assert.deepEqual([phase3.ready, phase3.running, phase3.finished, phase3.inputs], [[], [], [], []]);
  assert.deepEqual(phase4.ready, [explanation.id]);
  const first = decide([phase3, phase4], "head-2", memory());
  assert.deepEqual(first.actions, [], "one quiet tick is not done");
  const second = decide([phase3, phase4], "head-2", first.memory);
  assert.deepEqual(second.actions, [{ kind: "done", waitingForUnconfiguredPhases: { 4: 1 } }]);
});
