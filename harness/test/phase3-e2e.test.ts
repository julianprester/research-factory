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
// model, Docker or `deepis` is involved. The workers' files stay untracked between owner calls, as in a
// real run: `owner().call` records `git status` and HEAD around every tool and asserts a tool commits only its own paths and adds no
// dirty path, and the tree operations (`tree_*`, `submit`) are the sweeps that take the pending files.
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
  NODE_BASE,
  REGISTRY,
  REPORT_FULL,
  REVISION,
  fakeContainer,
  git,
  plan,
  puzzleRun,
  rejectMessage,
  review,
  subjects,
  write,
} from "./explain-fixture.ts";

interface Owner {
  /**
   * Calls the registered tool. Around the call it records `git status --porcelain -uall` and HEAD, and
   * asserts what the tools promise: a refused call changes neither; a call that commits touches only
   * files in its commit and adds no dirty path. `tree_*` and `submit` commit the whole tree (a sweep
   * that takes the workers' pending files with it), so those are checked by the test, not here.
   */
  call(name: string, params: Record<string, unknown>): Promise<string>;
  /** The paths the last call committed, run-relative and sorted; empty when it made no commit. */
  committed: string[];
  /** The result of the owner extension's `tool_call` guard for a `write` of `file`. */
  write(file: string): unknown;
}

type Handler = (event: { toolName: string; input: { path: string } }) => unknown;

const dirty = (run: string): string[] => git(run, "status", "--porcelain", "-uall").split("\n").filter((line) => line !== "").sort();
const head = (run: string): string => git(run, "rev-parse", "HEAD").trim();
/** The calls that are whole-tree operations (`commit()`/`updateNode`): they take the workers' pending files with them. Every other tool commits its own paths only. */
const SWEEPS = new Set(["tree_create", "tree_update", "submit"]);

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
  const handlers = new Map<string, Handler>();
  ownerExtension({
    registerTool(tool: { name: string; execute(id: string, params: unknown): Promise<{ content: { text: string }[] }> }) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
  });
  const self: Owner = {
    committed: [],
    async call(name, params) {
      const tool = tools.get(name);
      assert.ok(tool !== undefined, `${name} is registered`);
      const dirtyBefore = dirty(run);
      const headBefore = head(run);
      let answer: { content: { text: string }[] };
      try {
        answer = await tool.execute("e2e", params);
      } catch (error) {
        assert.equal(head(run), headBefore, `${name} refused: no commit`);
        assert.deepEqual(dirty(run), dirtyBefore, `${name} refused: the working tree is as it was`);
        throw error;
      }
      const headAfter = head(run);
      self.committed =
        headAfter === headBefore ? [] : git(run, "diff", "--name-only", headBefore, headAfter).split("\n").filter((line) => line !== "").sort();
      if (!SWEEPS.has(name)) {
        // A tool that commits its own paths leaves the workers' pending files exactly as they were: no new
        // dirty path, and none swept into its commit. (Its own files are written and committed within the call.)
        assert.deepEqual(dirty(run), dirtyBefore, `${name}: the pending set is identical before and after`);
      }
      return answer.content.map((part) => part.text).join("\n");
    },
    write(file) {
      const guard = handlers.get("tool_call");
      assert.ok(guard !== undefined, "the extension registers a tool_call guard");
      return guard({ toolName: "write", input: { path: file } });
    },
  };
  return self;
}

const memory = (): Memory => ({ head: "h1", nudges: {}, stalled: [], doneStreak: 0 });
/** `ticks` supervisor ticks over `views` with the head unchanged: every one must be silent (neither nudge, start nor done). */
function silentTicks(views: PhaseView[], ticks: number, why: string): void {
  let state = memory();
  for (let tick = 1; tick <= ticks; tick++) {
    const result = decide(views, "h1", state);
    assert.deepEqual(result.actions, [], `${why} (tick ${tick})`);
    state = result.memory;
  }
}
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
  silentTicks([view()], 3, "a running explanation under an input puzzle is left alone");

  // 2. Round 1: tasks A and B and the literature worker; substantial. No sweep of the tree runs between
  // open_round, the workers' files and close_round, so the status shows what each tool commits and leaves.
  const loop = path.relative(run, loopDir(run, "E01"));
  const base = path.relative(run, node);
  assert.equal(base, NODE_BASE);
  const opened1 = await tools.call("open_round", { nodeId: "E01", plan: plan("A", "B") });
  assert.match(opened1, /round 1\b/);
  assert.equal(subjects(run)[0], "[P3:plan] E01 round 01");
  assert.deepEqual(
    tools.committed,
    [`${base}/rounds/01/plan.md`, `${base}/workspace/must-check.md`, `${base}/workspace/puzzle.md`],
    "the plan commit holds the plan and the snapshots, nothing else",
  );
  assert.deepEqual(dirty(run), [], "nothing is pending yet");
  assert.match(await rejectMessage(tools.call("close_round", { nodeId: "E01", changed: "substantial", summary: "too early" })), /handoff/);
  workersFinish(node, 1, ["A", "B"], ARGUMENT_FULL);
  const pending = dirty(run);
  assert.ok(pending.length >= 8, `the workers' files are pending: ${pending.join(", ")}`);
  assert.ok(pending.every((line) => line.startsWith("?? ")), "and untracked");
  const closed1 = await tools.call("close_round", { nodeId: "E01", changed: "substantial", summary: "the first account" });
  assert.match(closed1, /round 1 closed/);
  assert.match(closed1, /continue/);
  assert.equal(subjects(run)[0], "[P3:verdict] E01 round 01 (substantial)");
  assert.deepEqual(
    tools.committed,
    [`${loop}/rounds.json`, `${base}/rounds/01/verdict.md`],
    "the verdict commit holds verdict.md and rounds.json, not the argument or the handoffs",
  );
  assert.deepEqual(dirty(run), pending, "the workers' files are still untracked: only a tree operation sweeps them");

  // The loop has not stopped, so neither reproduce nor submit is open to the owner.
  assert.match(await rejectMessage(tools.call("submit", { nodeId: "E01" })), /gate "STOP".*no STOP is recorded/s);
  assert.match(await rejectMessage(tools.call("reproduce", { nodeId: "E01" })), /no STOP is recorded/);

  // 3. Round 2 (task C): substantial again, so the argument must differ from round 1's.
  await tools.call("open_round", { nodeId: "E01", plan: plan("C") });
  workersFinish(node, 2, ["C"], `${ARGUMENT_FULL}\nRound two adds the timing rival to the account.\n`);
  assert.match(await tools.call("close_round", { nodeId: "E01", changed: "substantial", summary: "a rival is answered" }), /continue/);

  // 4. Rounds 3 and 4 change nothing: the second quiet round stops the loop.
  await tools.call("open_round", { nodeId: "E01", plan: plan("D") });
  quietWorkers(node, 3, "D");
  const closed3 = await tools.call("close_round", { nodeId: "E01", changed: "none", summary: "nothing new" });
  assert.match(closed3, /continue/, "one quiet round does not stop");
  silentTicks([view()], 3, "still running, still left alone");
  await tools.call("open_round", { nodeId: "E01", plan: plan("E") });
  quietWorkers(node, 4, "E");
  const closed4 = await tools.call("close_round", { nodeId: "E01", changed: "none", summary: "still nothing new" });
  assert.match(closed4, /STOP \(two-quiet\)/);
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

  // 6. check-argument passes once the registry, the assets and the links are in place.
  write(path.join(node, "workspace", "output", "assets", "_variables.yml"), 'n_pages: "1234"\n');
  write(
    path.join(node, "workspace", "output", "assets", "variables_sources.csv"),
    "variable,value,rendered,source\nn_pages,1234,1234,output/numbers/A_01.csv#n\n",
  );
  assert.deepEqual(checkArgument(run, node, { citations: () => [] }).problems, []);

  // 7. Submit is refused at each gate not yet met, and each refusal changes nothing. The review comes
  // first (check-argument's review checks), then the revision, then the reproduction.
  assert.match(await rejectMessage(tools.call("submit", { nodeId: "E01" })), /gate "check-argument".*report\.md is missing/s);
  write(path.join(node, "workspace", "reviews", "report.md"), review());
  const before = subjects(run).length;
  assert.deepEqual(checkArgument(run, node, { report: true, citations: () => [] }).problems, [], "check-argument passes with the review");
  assert.match(await rejectMessage(tools.call("submit", { nodeId: "E01" })), /gate "reproduction"/);
  assert.equal(subjects(run).length, before, "a refused submit makes no commit");

  // 8. reproduce: a call stopped by its budget is partial; the next one completes and records.
  setBudgetForTests(0);
  const partial = await tools.call("reproduce", { nodeId: "E01" });
  assert.match(partial, /PARTIAL/);
  assert.match(partial, /call reproduce again/);
  assert.equal(existsSync(path.join(loopDir(run, "E01"), "reproduction.json")), false);
  setBudgetForTests(undefined);
  const complete = await tools.call("reproduce", { nodeId: "E01" });
  assert.match(complete, /reproduced/);
  assert.deepEqual([...exec.calls].sort(), ["A_01.R", "B_01.R", "C_01.R"], "every script ran once, in the container");
  const record = JSON.parse(readFileSync(path.join(loopDir(run, "E01"), "reproduction.json"), "utf8")) as { ok: boolean };
  assert.equal(record.ok, true);
  assert.equal(subjects(run)[0], "[P3:reproduce] E01");
  assert.deepEqual(tools.committed, [`${loop}/reproduction.json`], "the reproduction commit holds the record alone");
  assert.ok(dirty(run).some((line) => line.endsWith("workspace/scripts/A_01.R")), "the scripts are still pending");

  // 9. A finding with no ruling is refused. A script edited after the reproduction invalidates it: reproduce again.
  assert.match(await rejectMessage(tools.call("submit", { nodeId: "E01" })), /gate "revision".*F1/s, "a finding with no ruling");
  write(path.join(node, "workspace", "reviews", "revision.md"), REVISION);
  write(path.join(node, "workspace", "scripts", "A_01.R"), "# analysis A, edited\n");
  assert.match(await rejectMessage(tools.call("submit", { nodeId: "E01" })), /changed since the reproduction/);
  assert.match(await tools.call("reproduce", { nodeId: "E01" }), /reproduced/);
  assert.equal(subjects(run).filter((subject) => subject === "[P3:reproduce] E01").length, 2);

  // 10. The owner cannot hand the node on by hand; submit is the way.
  assert.match(await rejectMessage(tools.call("tree_update", { nodeId: "E01", status: "submitted" })), /use submit/);
  assert.match(await rejectMessage(tools.call("tree_update", { nodeId: "E01", phase: 4 })), /use submit/);
  assert.match(await rejectMessage(tools.call("tree_update", { nodeId: "P01", phase: 4 })), /use promote/);

  const submitted = await tools.call("submit", { nodeId: "E01", note: "the account is settled" });
  assert.match(submitted, /submitted E01: now ready in Phase 4/);
  const sha = git(run, "rev-parse", "--short", "HEAD").trim();
  assert.ok(tools.committed.includes(`${base}/workspace/scripts/A_01.R`), "the submit commit is the tree sweep: it takes the pending scripts");
  assert.ok(tools.committed.includes(`${base}/workspace/argument.md`), "and the argument");
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
  // Submitted, the explanation is in Phase 4; the puzzle is still `input`, so an idle owner is nudged to close it,
  // and two consecutive ticks (the length of the done rule) give no `done`.
  const waiting1 = decide([view(), view(4)], "h2", memory());
  const waiting2 = decide([view(), view(4)], "h2", waiting1.memory);
  for (const [tick, result] of [waiting1, waiting2].entries()) {
    assert.deepEqual(result.actions.map((action) => action.kind), ["nudge"], `tick ${tick + 1}: the open puzzle input keeps the run alive`);
  }
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
  assert.match(await tools.call("close_round", { nodeId: "E01", changed: "substantial", summary: "one" }), /continue/);

  await tools.call("open_round", { nodeId: "E01", plan: plan("B") });
  workersFinish(node, 2, ["B"], `${ARGUMENT_FULL}\nA second account.\n`);
  const closed = await tools.call("close_round", { nodeId: "E01", changed: "substantial", summary: "two" });
  assert.match(closed, /STOP \(cap\)/);
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
