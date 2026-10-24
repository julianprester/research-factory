// The Phase 3 chain end to end, through the owner extension's registered tools.
//
// A puzzle already in Phase 3 (promotion is Phase 2's, and phase2-e2e covers it), then
// everything the owner does with its tools: `tree_create` for the explanation, `open_round`
// and `close_round` over four rounds (two substantial, two quiet) to the two-quiet STOP,
// the refusals that follow it, `reproduce` (a partial call, then a complete one),
// `submit` refused at each gate it has not met yet and then accepted, and the supervisor
// seeing a node it must not call done until the explanation has gone to Phase 4.
//
// Workers and scripts are simulated by writing the files they would leave (scripts,
// handoffs, a literature report, `argument.md`, the registry and assets, the review and
// the revision); the container is a fake `Exec` and the citation runner a stub, so no
// model, Docker or `deepis` is involved. After each worker step `settle` commits what the
// "workers" wrote, so `git status` after an owner tool shows only what that tool left.
// Helpers are shared with explain-tools.test.ts through explain-fixture.ts.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { loopDir, readRounds } from "../explain/rounds.ts";
import { setBudgetForTests, setCitationsForTests, setExecForTests } from "../explain/tools.ts";
import ownerExtension from "../owner-extension.ts";
import { decide, viewPhase, type Memory, type PhaseView } from "../supervisor.ts";
import { checkArgument } from "../tools/check-argument.ts";
import { findNode } from "../tree.ts";
import {
  ARGUMENT_FULL,
  REGISTRY,
  REPORT_FULL,
  REVISION,
  fakeContainer,
  git,
  plan,
  puzzleRun,
  rejectMessage,
  review,
  settle,
  subjects,
  write,
} from "./explain-fixture.ts";

interface Owner {
  call(name: string, params: Record<string, unknown>): Promise<string>;
  /** The result of the owner extension's `tool_call` guard for a `write` of `file`. */
  write(file: string): unknown;
}

/** The real extension, registered with `CTC_RUN_DIR`/`CTC_PHASE=3` as a launched owner session sees them. */
function owner(t: TestContext, run: string): Owner {
  const saved = { run: process.env.CTC_RUN_DIR, phase: process.env.CTC_PHASE };
  process.env.CTC_RUN_DIR = run;
  process.env.CTC_PHASE = "3";
  t.after(() => {
    for (const [name, value] of [["CTC_RUN_DIR", saved.run], ["CTC_PHASE", saved.phase]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const tools = new Map<string, { execute(id: string, params: unknown): Promise<{ content: { text: string }[] }> }>();
  const guards: ((event: { toolName: string; input: { path: string } }) => unknown)[] = [];
  ownerExtension({
    registerTool(tool: { name: string; execute(id: string, params: unknown): Promise<{ content: { text: string }[] }> }) {
      tools.set(tool.name, tool);
    },
    on(_event: string, handler: (event: { toolName: string; input: { path: string } }) => unknown) {
      guards.push(handler);
    },
  });
  return {
    async call(name, params) {
      const tool = tools.get(name);
      assert.ok(tool !== undefined, `${name} is registered`);
      const answer = await tool.execute("e2e", params);
      return answer.content.map((part) => part.text).join("\n");
    },
    write(file) {
      assert.ok(guards.length > 0, "the extension registers a tool_call guard");
      return guards[0]!({ toolName: "write", input: { path: file } });
    },
  };
}

const memory = (): Memory => ({ head: "h1", nudges: {}, stalled: [], doneStreak: 0 });
const clean = (run: string, why: string) => assert.equal(git(run, "status", "--porcelain"), "", why);

/** What a round's workers leave: a handoff per task, the literature handoff and report, the scripts and their registries. */
function workersFinish(node: string, round: number, tasks: string[], argument: string): void {
  const nn = String(round).padStart(2, "0");
  for (const letter of tasks) {
    write(path.join(node, "tasks", letter, "handoff.md"), `Status: DONE\n\nTask ${letter} done.\n`);
    write(path.join(node, "workspace", "scripts", `${letter}_01.R`), `# analysis ${letter}\n`);
    write(path.join(node, "workspace", "output", "numbers", `${letter}_01.csv`), REGISTRY);
  }
  write(path.join(node, "tasks", `lit-${nn}`, "handoff.md"), "Status: DONE\n");
  write(path.join(node, "workspace", "reports", `${nn}.md`), REPORT_FULL(round));
  write(path.join(node, "workspace", "argument.md"), argument);
}

/** A round that changed nothing: the workers report, the argument stays as it was. */
function quietWorkers(node: string, round: number, task: string): void {
  const nn = String(round).padStart(2, "0");
  write(path.join(node, "tasks", task, "handoff.md"), `Status: DONE\n\nTask ${task} confirmed the registry.\n`);
  write(path.join(node, "tasks", `lit-${nn}`, "handoff.md"), "Status: DONE\n");
  write(path.join(node, "workspace", "reports", `${nn}.md`), REPORT_FULL(round));
}

test("the Phase 3 chain runs end to end", async (t) => {
  const { run } = puzzleRun(t);
  const tools = owner(t, run);
  const exec = fakeContainer();
  setExecForTests(exec.exec);
  setCitationsForTests(() => []);
  t.after(() => {
    setExecForTests(undefined);
    setCitationsForTests(undefined);
    setBudgetForTests(undefined);
  });
  const view = (phase = 3): PhaseView =>
    viewPhase(run, phase, "idle", { configured: phase === 3, started: true, entry: false });

  // 1. The owner takes the puzzle as its input and creates the explanation, which it then sets active.
  assert.deepEqual(view().ready, ["P01"], "a ready puzzle in Phase 3, with no owner yet");
  assert.deepEqual(decide([viewPhase(run, 3, "gone", { configured: true, started: false, entry: false })], "h1", memory()).actions, [
    { kind: "start", phase: 3, reason: "never-started" },
  ]);
  await tools.call("tree_update", { nodeId: "P01", status: "input" });
  const created = await tools.call("tree_create", { parentId: "P01", title: "Argument" });
  assert.match(created, /^created E01 explanation 3 ready argument/);
  await tools.call("tree_update", { nodeId: "E01", status: "active" });
  const node = findNode(run, "E01").dir;
  clean(run, "tree tools commit their own writes");
  assert.deepEqual(view().running, ["E01"], "no node-level handoff: running, so neither done nor nudged");
  assert.deepEqual(decide([view()], "h1", memory()).actions, []);

  // 2. Round 1: tasks A and B and the literature worker; substantial.
  const opened1 = await tools.call("open_round", { nodeId: "E01", plan: plan("A", "B") });
  assert.match(opened1, /round 1\b/);
  clean(run, "open_round");
  assert.equal(subjects(run)[0], "[P3:plan] E01 round 01");
  assert.match(await rejectMessage(tools.call("close_round", { nodeId: "E01", changed: "substantial", summary: "too early" })), /handoff/);
  workersFinish(node, 1, ["A", "B"], ARGUMENT_FULL);
  settle(run);
  const closed1 = await tools.call("close_round", { nodeId: "E01", changed: "substantial", summary: "the first account" });
  assert.match(closed1, /round 1 closed/);
  assert.match(closed1, /continue/);
  clean(run, "close_round 1");
  assert.equal(subjects(run)[0], "[P3:verdict] E01 round 01 (substantial)");

  // The loop has not stopped, so neither reproduce nor submit is open to the owner.
  assert.match(await rejectMessage(tools.call("submit", { nodeId: "E01" })), /gate "STOP".*no STOP is recorded/s);
  assert.match(await rejectMessage(tools.call("reproduce", { nodeId: "E01" })), /no STOP is recorded/);
  clean(run, "refused submit and reproduce before STOP");

  // 3. Round 2 (task C): substantial again, so the argument must differ from round 1's.
  await tools.call("open_round", { nodeId: "E01", plan: plan("C") });
  clean(run, "open_round 2");
  workersFinish(node, 2, ["C"], `${ARGUMENT_FULL}\nRound two adds the timing rival to the account.\n`);
  settle(run);
  assert.match(await tools.call("close_round", { nodeId: "E01", changed: "substantial", summary: "a rival is answered" }), /continue/);
  clean(run, "close_round 2");

  // 4. Rounds 3 and 4 change nothing: the second quiet round stops the loop.
  await tools.call("open_round", { nodeId: "E01", plan: plan("D") });
  quietWorkers(node, 3, "D");
  settle(run);
  const closed3 = await tools.call("close_round", { nodeId: "E01", changed: "none", summary: "nothing new" });
  assert.match(closed3, /continue/, "one quiet round does not stop");
  clean(run, "close_round 3");
  assert.deepEqual(decide([view()], "h1", memory()).actions, [], "still running, still left alone");
  await tools.call("open_round", { nodeId: "E01", plan: plan("E") });
  quietWorkers(node, 4, "E");
  settle(run);
  const closed4 = await tools.call("close_round", { nodeId: "E01", changed: "none", summary: "still nothing new" });
  assert.match(closed4, /STOP \(two-quiet\)/);
  clean(run, "close_round 4");
  assert.deepEqual(
    readRounds(run, "E01").map((round) => [round.round, round.changed]),
    [[1, true], [2, true], [3, false], [4, false]],
  );

  // 5. STOP is a latch.
  assert.equal(
    await rejectMessage(tools.call("open_round", { nodeId: "E01", plan: plan("F") })),
    "STOP recorded (two-quiet): no more rounds",
  );
  assert.equal(existsSync(path.join(node, "tasks", "F")), false);
  assert.equal(existsSync(path.join(node, "rounds", "05")), false);
  clean(run, "a refused open_round");

  // 6. check-argument passes once the registry, the assets and the links are in place.
  write(path.join(node, "workspace", "output", "assets", "_variables.yml"), 'n_pages: "1234"\n');
  write(
    path.join(node, "workspace", "output", "assets", "variables_sources.csv"),
    "variable,value,rendered,source\nn_pages,1234,1234,output/numbers/A_01.csv#n\n",
  );
  settle(run);
  assert.deepEqual(checkArgument(run, node, { citations: () => [] }).problems, []);

  // 7. Submit is refused at each gate not yet met, and each refusal changes nothing. The review comes
  // first (check-argument's review checks), then the revision, then the reproduction.
  assert.match(await rejectMessage(tools.call("submit", { nodeId: "E01" })), /gate "check-argument".*report\.md is missing/s);
  write(path.join(node, "workspace", "reviews", "report.md"), review());
  settle(run);
  const before = subjects(run).length;
  assert.deepEqual(checkArgument(run, node, { report: true, citations: () => [] }).problems, [], "check-argument passes with the review");
  assert.match(await rejectMessage(tools.call("submit", { nodeId: "E01" })), /gate "reproduction"/);
  assert.equal(subjects(run).length, before, "a refused submit makes no commit");
  clean(run, "a refused submit");

  // 8. reproduce: a call stopped by its budget is partial; the next one completes and records.
  setBudgetForTests(0);
  const partial = await tools.call("reproduce", { nodeId: "E01" });
  assert.match(partial, /PARTIAL/);
  assert.match(partial, /call reproduce again/);
  assert.equal(existsSync(path.join(loopDir(run, "E01"), "reproduction.json")), false);
  clean(run, "a partial reproduce");
  setBudgetForTests(undefined);
  const complete = await tools.call("reproduce", { nodeId: "E01" });
  assert.match(complete, /reproduced/);
  assert.deepEqual([...exec.calls].sort(), ["A_01.R", "B_01.R", "C_01.R"], "every script ran once, in the container");
  const record = JSON.parse(readFileSync(path.join(loopDir(run, "E01"), "reproduction.json"), "utf8")) as { ok: boolean };
  assert.equal(record.ok, true);
  assert.equal(subjects(run)[0], "[P3:reproduce] E01");
  clean(run, "reproduce");

  // 9. A finding with no ruling is refused. A script edited after the reproduction invalidates it: reproduce again.
  assert.match(await rejectMessage(tools.call("submit", { nodeId: "E01" })), /gate "revision".*F1/s, "a finding with no ruling");
  write(path.join(node, "workspace", "reviews", "revision.md"), REVISION);
  write(path.join(node, "workspace", "scripts", "A_01.R"), "# analysis A, edited\n");
  settle(run);
  assert.match(await rejectMessage(tools.call("submit", { nodeId: "E01" })), /changed since the reproduction/);
  assert.match(await tools.call("reproduce", { nodeId: "E01" }), /reproduced/);
  assert.equal(subjects(run).filter((subject) => subject === "[P3:reproduce] E01").length, 2);
  clean(run, "the second reproduce");

  // 10. The owner cannot hand the node on by hand; submit is the way.
  assert.match(await rejectMessage(tools.call("tree_update", { nodeId: "E01", status: "submitted" })), /use submit/);
  assert.match(await rejectMessage(tools.call("tree_update", { nodeId: "E01", phase: 4 })), /use submit/);
  assert.match(await rejectMessage(tools.call("tree_update", { nodeId: "P01", phase: 4 })), /use promote/);
  clean(run, "refused tree_update calls");

  const submitted = await tools.call("submit", { nodeId: "E01", note: "the account is settled" });
  assert.match(submitted, /submitted E01: now ready in Phase 4/);
  const sha = git(run, "rev-parse", "--short", "HEAD").trim();
  assert.ok(submitted.includes(sha), `the reply names the commit ${sha}`);
  assert.deepEqual([findNode(run, "E01").phase, findNode(run, "E01").status], [4, "ready"]);
  clean(run, "submit");

  // 11. The log carries the loop: a plan and a verdict per round, and the reproduction.
  const log = subjects(run);
  for (const nn of ["01", "02", "03", "04"]) {
    assert.ok(log.includes(`[P3:plan] E01 round ${nn}`), `a plan commit for round ${nn}`);
    assert.ok(log.some((subject) => subject.startsWith(`[P3:verdict] E01 round ${nn} (`)), `a verdict commit for round ${nn}`);
  }
  assert.equal(log.filter((subject) => subject === "[P3:reproduce] E01").length, 2, "one commit per complete reproduction: the partial call made none");
  assert.match(log[0]!, /^\[P4:updateNode\] E01 — status ready, phase 4/);

  // 12. The supervisor: with the puzzle still `input` Phase 3 is not done; closed, two quiet ticks finish
  // the run with Phase 4 (no skill) reported as waiting.
  const waiting = decide([view(), view(4)], "h2", memory());
  assert.ok(waiting.actions.every((action) => action.kind !== "done"), "the open puzzle input keeps the run alive");
  await tools.call("tree_update", { nodeId: "P01", status: "closed" });
  const first = decide([view(), view(4)], "h3", memory());
  assert.deepEqual(first.actions, []);
  const second = decide([view(), view(4)], "h3", first.memory);
  assert.deepEqual(second.actions, [{ kind: "done", waitingForUnconfiguredPhases: { 4: 1 } }]);
});

test("a loop stopped at the cap records STOP (cap), and the owner's write tool cannot touch its records", async (t) => {
  const { run } = puzzleRun(t, { roundCap: 2 });
  const tools = owner(t, run);
  await tools.call("tree_create", { parentId: "P01", title: "Argument" });
  await tools.call("tree_update", { nodeId: "E01", status: "active" });
  const node = findNode(run, "E01").dir;

  await tools.call("open_round", { nodeId: "E01", plan: plan("A") });
  workersFinish(node, 1, ["A"], ARGUMENT_FULL);
  settle(run);
  assert.match(await tools.call("close_round", { nodeId: "E01", changed: "substantial", summary: "one" }), /continue/);

  await tools.call("open_round", { nodeId: "E01", plan: plan("B") });
  workersFinish(node, 2, ["B"], `${ARGUMENT_FULL}\nA second account.\n`);
  settle(run);
  const closed = await tools.call("close_round", { nodeId: "E01", changed: "substantial", summary: "two" });
  assert.match(closed, /STOP \(cap\)/);
  clean(run, "close_round at the cap");
  assert.equal(
    await rejectMessage(tools.call("open_round", { nodeId: "E01", plan: plan("C") })),
    "STOP recorded (cap): no more rounds",
  );

  // The plan, the verdict and the loop records are the tools' alone; the argument, briefs and the ledger are the owner's.
  const blocked = (file: string) => (tools.write(file) as { block?: boolean } | undefined)?.block === true;
  assert.equal(blocked(path.join(node, "rounds", "01", "plan.md")), true);
  assert.equal(blocked(path.join(node, "rounds", "02", "verdict.md")), true);
  assert.equal(blocked(path.join(loopDir(run, "E01"), "rounds.json")), true);
  assert.equal(blocked(path.join(loopDir(run, "E01"), "reproduction.json")), true);
  assert.equal(blocked(path.join(run, "owners", "phase-3", "loop", "E01", "anything.md")), true);
  assert.equal(blocked(path.join(node, "workspace", "scripts", "A_01.R")), true, "scripts are the workers'");
  assert.equal(blocked(path.join(node, "workspace", "argument.md")), false);
  assert.equal(blocked(path.join(node, "tasks", "C", "brief.md")), false);
  assert.equal(blocked(path.join(run, "owners", "phase-3", "ledger.md")), false);
});
