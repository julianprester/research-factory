// The Phase 2 chain end to end, as the final review drove it in /tmp/p2probe.
//
// One test over a real temp run: three patterns handed to Phase 2, twelve
// puzzles with complete cards and real merged reviews, round 0 as a PARTIAL that
// resumes with identical arguments, an evolution round with a forced
// child/parent head-to-head, a STOP, the gates that refuse after it (evolved
// `tree_create`, `judge_round`, the owner's write tool), the distinctness check,
// promotion of a final-round participant to phase 3 `ready` (and refusal of a
// puzzle eliminated before the final round), and the supervisor staying not-done
// until the pattern nodes are closed.
//
// The judge is a fake that reads a hidden strength out of each card; the
// citation runner is injected into `promote`, so no model or `deepis` is called.
// The bootstrap is the module seam's smaller value, which keeps the whole test
// a few seconds. Helpers are local; the test has no dependency on /tmp.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import ownerExtension from "../owner-extension.ts";
import { decide, viewPhase, type Memory } from "../supervisor.ts";
import { mergeReviews, parseReview } from "../tools/merge-reviews.ts";
import { createChild, findNode, initRun, listNodes, updateNode } from "../tree.ts";
import { readStop } from "../tournament/stop.ts";
import {
  checkDuplicates,
  judgeRound,
  promote,
  setTransportForTests,
  tournamentDir,
} from "../tournament/tools.ts";
import type { Transport } from "../tournament/judge.ts";

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** The four sections `loadEntrant` may read from a pattern card. */
function patternCard(patternId: string): string {
  return [
    `# ${patternId} pattern`,
    "",
    "## Measure",
    "Registered measure: the fraction of pages that state the rule by example.",
    "",
    "## Result",
    "0.41 (95% CI 0.35-0.47) against the registered 0.75 threshold; 12 of 40 pages.",
    "",
    "## Verdict",
    "Contingent: holds in sections with a procedure, breaks in sections with an owner.",
    "",
    "## Worst fits",
    "Two pages state the rule formally and then give an example that contradicts it.",
    "",
    "## Robustness",
    "Holds under the leave-one-section-out refit.",
    "",
  ].join("\n");
}

interface CardOptions {
  id: string;
  strength: number;
  lens: string;
  round: number;
  derivedFrom?: string[];
}

/** A complete card: the seven headings, both readings, and a hidden strength line. */
function card(o: CardOptions): string {
  const header = [`# ${o.id} — ${o.lens}: the residual in the etiquette corpus`, `Lens: ${o.lens}`, `Round: ${o.round}`];
  if (o.derivedFrom !== undefined && o.derivedFrom.length > 0) {
    header.push(`Derived from: ${o.derivedFrom.join(", ")}`, "Move: grounding");
  }
  return [
    ...header,
    "",
    "## Pattern",
    `SIDE ${o.id} strength ${o.strength.toFixed(2)}`,
    "E03 measured that 12 of 40 pages state the rule by example rather than formally, 0.41 against a",
    "registered 0.75; the pattern holds where a procedure exists and fails where a page names an owner.",
    "",
    "## Violated expectation",
    "E03 expected that etiquette documents would formalise rules once a rule became auditable. Shearing",
    "(2018) argues formalisation follows auditability, which the 0.41 rate denies.",
    "",
    "## A case of",
    "The pattern is a case of selective formalisation: an organisation formalises only the rules a",
    "carrier can audit, and keeps the rest as example.",
    "",
    "## Why it matters",
    "The debate on rule formalisation predicts a ratchet towards formal rules. A resolution would say",
    "when the ratchet stops and what carries the rest.",
    "",
    "## Admissible explanations",
    "A status quo reading: the nearest existing theory already explains the residual.",
    "An artifact reading: the corpus is a public handbook whose rendering drops examples.",
    "",
    "## Limits",
    "The handbook documents prescriptions, not what anyone did; the two deviant pages are a thin cell.",
    "",
    "## Literature log",
    'deepis search "rule formalisation auditability" (18 hits); context read on two chunks.',
    "",
  ].join("\n");
}

/** A review in the format merge-reviews.ts parses, with the ratings the case needs. */
function review(id: string, fit: "strong" | "adequate" | "weak"): string {
  return [
    `# Review of ${id}`,
    "",
    "## Fit",
    `Rating: ${fit} — the card follows the pattern's result and does not restate it.`,
    "",
    "## Plausibility",
    "Rating: adequate — the status-quo rival is answered by the card's concept.",
    "",
    "## Relevance",
    "Rating: adequate — the card names the formalisation debate and what a resolution would change.",
    "",
    "## Data-character check",
    "Result: ok",
    "",
    "## Known-result check",
    "Result: not-applicable",
    "",
    "## Findings",
    "None.",
    "",
    "## Phase 3 must check",
    "- Does the residual hold on the pages that name an owner?",
    "",
    "Status: DONE",
    "",
  ].join("\n");
}

/** Write the card and the two reviews, and merge them with the real library function. */
function writePuzzle(dir: string, markdown: string, fit: "strong" | "adequate" | "weak"): void {
  write(path.join(dir, "workspace", "puzzle.md"), markdown);
  const a = review("the card", fit);
  const b = review("the card", "adequate");
  write(path.join(dir, "workspace", "reviews", "a.md"), a);
  write(path.join(dir, "workspace", "reviews", "b.md"), b);
  const parsedA = parseReview(a);
  const parsedB = parseReview(b);
  assert.ok(parsedA !== null && parsedB !== null, "the fixture reviews parse");
  write(
    path.join(dir, "workspace", "reviews", "merged.json"),
    `${JSON.stringify(mergeReviews(parsedA, parsedB), null, 2)}\n`,
  );
}

const STRENGTH = /SIDE (\S+) strength (-?[0-9.]+)/g;

function pairKey(left: string, right: string): string {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

interface World {
  strength: Map<string, number>;
  duplicates: Set<string>;
}

/** The two card blocks of a judge prompt, between the labels the prompt writes. */
function blocks(prompt: string): [string, string] {
  const one = prompt.indexOf("## Puzzle 1");
  const oneEnd = prompt.indexOf("**Evidence behind Puzzle 1**");
  const two = prompt.indexOf("## Puzzle 2");
  const twoEnd = prompt.indexOf("**Evidence behind Puzzle 2**");
  return [prompt.slice(one, oneEnd), prompt.slice(two, twoEnd)];
}

function idOf(block: string): string {
  return /# (P\d+)/.exec(block)?.[1] ?? "?";
}

/** A content-following judge with no position bias; a duplicate checker backed by `world`. */
function fakeJudge(world: World): Transport {
  return async (prompt: string): Promise<string> => {
    const [one, two] = blocks(prompt);
    const a = idOf(one);
    const b = idOf(two);
    if (prompt.includes("the same puzzle, not which is better")) {
      return JSON.stringify({ same: world.duplicates.has(pairKey(a, b)), reason: `${a} vs ${b}` });
    }
    const sa = world.strength.get(a) ?? 0;
    const sb = world.strength.get(b) ?? 0;
    const winner = sa > sb + 0.05 ? 1 : sb > sa + 0.05 ? 2 : 0;
    return JSON.stringify({ winner, reason: `strength ${sa} vs ${sb}` });
  };
}

interface FakePi {
  call(name: string, params: Record<string, unknown>): Promise<string>;
  handler(event: { toolName: string; input: { path: string } }): unknown;
}

function fakePi(extension: (pi: unknown) => void): FakePi {
  const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<{ content: { text: string }[] }> }>();
  const handlers: ((event: { toolName: string; input: { path: string } }) => unknown)[] = [];
  extension({
    registerTool(tool: { name: string; execute: (id: string, params: unknown) => Promise<{ content: { text: string }[] }> }) {
      tools.set(tool.name, tool);
    },
    on(_event: string, handler: (event: { toolName: string; input: { path: string } }) => unknown) {
      handlers.push(handler);
    },
  });
  return {
    async call(name, params) {
      const tool = tools.get(name);
      assert.ok(tool !== undefined, `${name} is registered`);
      const answer = await tool.execute("e2e", params);
      return answer.content.map((part) => part.text).join("\n");
    },
    handler(event) {
      assert.ok(handlers.length > 0, "the owner extension registers a tool_call handler");
      return handlers[0]!(event);
    },
  };
}

async function refuse(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("expected the call to be refused");
}

function memory(): Memory {
  return { head: "h1", nudges: {}, stalled: [], doneStreak: 0 };
}

test("the Phase 2 chain runs end to end", async (t) => {
  const run = mkdtempSync(path.join(tmpdir(), "ctc-phase2-e2e-"));
  t.after(() => {
    setTransportForTests(undefined);
    rmSync(run, { recursive: true, force: true });
  });
  const world: World = { strength: new Map(), duplicates: new Set() };

  // 1. Three patterns handed to Phase 2 and opened as job lists.
  initRun(run, "data", "etiquette rules");
  const patterns: string[] = [];
  for (const title of ["E01 control addressed to offices", "E02 repair route formalisation", "E03 procedure vs identification"]) {
    const node = createChild(run, "D01", title, "owner-p1");
    updateNode(run, node.id, { phase: 2, status: "ready" }, "owner-p1", "hand to phase 2");
    updateNode(run, node.id, { status: "input" }, "owner-p2", "job list");
    write(path.join(findNode(run, node.id).dir, "workspace", "pattern.md"), patternCard(node.id));
    patterns.push(node.id);
  }
  assert.equal(patterns.length, 3);

  // 2. Twelve puzzles, four under each pattern, with cards and real merges.
  const puzzles: string[] = [];
  let strength = 12;
  for (const [index, pattern] of patterns.entries()) {
    for (let at = 1; at <= 4; at++) {
      const lens = ["status quo", "different level", "different theory", "concept that dissolves it"][(index + at) % 4]!;
      const node = createChild(run, pattern, `${lens}: residual ${index}-${at}`, "owner-p2");
      world.strength.set(node.id, strength--);
      writePuzzle(findNode(run, node.id).dir, card({ id: node.id, strength: world.strength.get(node.id)!, lens, round: 0 }), "adequate");
      updateNode(run, node.id, { status: "submitted" }, "owner-p2");
      puzzles.push(node.id);
    }
  }
  assert.equal(puzzles.length, 12);

  // 3. The supervisor never finishes while an input pattern is open.
  const neverDone = decide(
    [viewPhase(run, 2, "idle", { configured: true, started: true, entry: false })],
    "h1",
    memory(),
  );
  assert.ok(!neverDone.actions.some((action) => action.kind === "done"), "not done with open input nodes");
  assert.ok(
    neverDone.actions.some((action) => action.kind === "nudge" && action.message.includes("open input node")),
    "an idle owner with only submitted puzzles gets the open-input nudge",
  );

  // 4. Round 0: PARTIAL first, then the identical arguments resume it.
  const tournament = tournamentDir(run);
  const partial = await judgeRound(run, { round: 0 }, { transport: fakeJudge(world), bootstrap: 10, budgetMs: 1 });
  assert.match(partial, /^PARTIAL — call judge_round again with the same arguments to resume/);
  assert.ok(!existsSync(path.join(tournament, "round-0.json")), "a partial round writes no round file");

  const round0Text = await judgeRound(run, { round: 0 }, { transport: fakeJudge(world), bootstrap: 10 });
  assert.match(round0Text, /^COMPLETE/);
  assert.match(round0Text, /Decision: CONTINUE/);
  const log = readFileSync(path.join(tournament, "round-0.matches.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { pair?: [string, string]; header?: unknown })
    .filter((line) => line.header === undefined);
  const keys = log.map((line) => pairKey(line.pair![0], line.pair![1]));
  assert.equal(new Set(keys).size, keys.length, "the resume judged no pair twice");
  const round0 = JSON.parse(readFileSync(path.join(tournament, "round-0.json"), "utf8")) as {
    top: string[];
    sides: string[];
  };
  assert.equal(round0.sides.length, 12, "the round file records its participants");

  // 5. Promotion before STOP is refused.
  assert.match(
    await refuse(promote(run, { nodeId: round0.top[0]! }, { citations: () => [] })),
    /promote: no STOP recorded/,
  );

  // 6. Round 1: two children stronger than their parents.
  const children: { id: string; parent: string }[] = [];
  for (const [index, parent] of round0.top.slice(0, 2).entries()) {
    const node = createChild(run, findNode(run, parent).parent!, `grounding: child of ${parent}`, "owner-p2", [parent]);
    world.strength.set(node.id, 30 - index);
    writePuzzle(
      findNode(run, node.id).dir,
      card({ id: node.id, strength: 30 - index, lens: "status quo", round: 1, derivedFrom: [parent] }),
      "strong",
    );
    updateNode(run, node.id, { status: "submitted" }, "owner-p2");
    children.push({ id: node.id, parent });
  }
  const round1Text = await judgeRound(
    run,
    {
      round: 1,
      entrants: round0.top.slice(0, 8),
      pairs: children.map((child) => ({ child: child.id, parent: child.parent })),
    },
    { transport: fakeJudge(world), bootstrap: 10 },
  );
  assert.match(round1Text, /^COMPLETE/);
  assert.match(round1Text, /Decision: CONTINUE/);
  const round1 = JSON.parse(readFileSync(path.join(tournament, "round-1.json"), "utf8")) as { sides: string[]; top: string[] };

  // 7. Round 2: weak children cannot beat their parents, so the loop stops.
  const weak: { id: string; parent: string }[] = [];
  for (const [index, parent] of round1.top.slice(0, 2).entries()) {
    const node = createChild(run, findNode(run, parent).parent!, `simplification: child of ${parent}`, "owner-p2", [parent]);
    world.strength.set(node.id, 0.1 + index * 0.01);
    writePuzzle(
      findNode(run, node.id).dir,
      card({ id: node.id, strength: 0.1 + index * 0.01, lens: "different level", round: 2, derivedFrom: [parent] }),
      "weak",
    );
    updateNode(run, node.id, { status: "submitted" }, "owner-p2");
    weak.push({ id: node.id, parent });
  }
  const round2Text = await judgeRound(
    run,
    {
      round: 2,
      entrants: round1.top.slice(0, 8),
      pairs: weak.map((child) => ({ child: child.id, parent: child.parent })),
    },
    { transport: fakeJudge(world), bootstrap: 10 },
  );
  assert.match(round2Text, /STOP \(no-child-beat-parent\)/);
  assert.deepEqual(readStop(path.join(tournament, "rounds.json")), {
    stop: true,
    reason: "no-child-beat-parent",
  });
  const round2 = JSON.parse(readFileSync(path.join(tournament, "round-2.json"), "utf8")) as {
    sides: string[];
    top: string[];
    fit: { scores: Record<string, number> };
  };
  const participants = new Set(round2.sides);
  const finalTop = round2.top.filter((id) => participants.has(id));
  assert.ok(finalTop.length >= 8, "the final round ranks its participants");

  // 8. The gates refuse through the owner extension.
  process.env.CTC_RUN_DIR = run;
  process.env.CTC_PHASE = "2";
  t.after(() => {
    delete process.env.CTC_RUN_DIR;
    delete process.env.CTC_PHASE;
  });
  const pi = fakePi(ownerExtension);
  assert.match(
    await refuse(pi.call("tree_create", { parentId: patterns[0], title: "grounding: late", derivedFrom: [round0.top[0]] })),
    /^STOP recorded \(no-child-beat-parent\): no more evolution$/,
  );
  assert.match(await pi.call("tree_create", { parentId: patterns[0], title: "status quo: plain after stop" }), /^created P\d+ puzzle 2 ready/);
  assert.match(
    await refuse(pi.call("tree_update", { nodeId: finalTop[0], phase: 3, status: "ready" })),
    /use promote: puzzles reach Phase 3 only through the gated promote tool/,
  );
  assert.match(
    await refuse(pi.call("judge_round", { round: 3, entrants: [finalTop[0]], pairs: [{ child: finalTop[0], parent: finalTop[1] }] })),
    /STOP already recorded/,
  );
  assert.equal(
    (pi.handler({ toolName: "write", input: { path: path.join(tournament, "rounds.json") } }) as { block?: boolean } | undefined)?.block,
    true,
    "the owner cannot forge the tournament records",
  );
  assert.equal(
    pi.handler({ toolName: "write", input: { path: path.join(run, "owners", "phase-2", "ledger.md") } }),
    undefined,
    "the ledger is still an owner write",
  );

  // 9. Distinctness among the final round's top eight, with one confirmed pair.
  const candidateIds = finalTop.slice(0, 8);
  world.duplicates.add(pairKey(candidateIds[1]!, candidateIds[2]!));
  const dedupe = await checkDuplicates(run, { ids: candidateIds }, { transport: fakeJudge(world) });
  assert.match(dedupe, /keep /);
  assert.match(dedupe, /drop /);

  // 10. A puzzle eliminated before the final round is not promotable; a participant is.
  const eliminated = puzzles.find((id) => !participants.has(id) && findNode(run, id).phase === 2 && findNode(run, id).status === "submitted");
  assert.ok(eliminated !== undefined, "a round-0 puzzle did not play the final round");
  assert.match(
    await refuse(promote(run, { nodeId: eliminated! }, { citations: () => [] })),
    new RegExp(`${eliminated} is not ranked in the final round \\(round 2\\)`),
  );
  const champion = candidateIds[0]!;
  const promoted = await promote(run, { nodeId: champion, note: "top of the final round" }, { citations: () => [] });
  assert.match(promoted, /^promoted P\d+ to phase 3 \(rank 1 of \d+/);
  const championNode = findNode(run, champion);
  assert.equal(championNode.phase, 3);
  assert.equal(championNode.status, "ready");
  assert.match(
    await refuse(promote(run, { nodeId: champion }, { citations: () => [] })),
    /already in phase 3/,
  );

  // 11. Sweep every phase-2 puzzle not promoted, then close the patterns: done.
  for (const node of listNodes(run)) {
    if (node.type === "puzzle" && node.phase === 2 && node.status !== "parked") {
      updateNode(run, node.id, { status: "parked" }, "owner-p2", "ranked below the break or never submitted");
    }
  }
  for (const pattern of patterns) updateNode(run, pattern, { status: "closed" }, "owner-p2", "Phase 2 complete");

  let mem = memory();
  const tick = (head: string) => {
    const views = [
      viewPhase(run, 2, "idle", { configured: true, started: true, entry: false }),
      viewPhase(run, 3, "gone", { configured: false, started: false, entry: false }),
    ];
    const answer = decide(views, head, mem);
    mem = answer.memory;
    return answer.actions;
  };
  const firstQuiet = tick("h2");
  assert.ok(!firstQuiet.some((action) => action.kind === "done"), "one quiet tick is not done");
  const done = tick("h2").find((action) => action.kind === "done");
  assert.ok(done !== undefined, "the run is done once every puzzle is parked and the patterns are closed");
  assert.deepEqual(
    (done as { waitingForUnconfiguredPhases: Record<string, number> }).waitingForUnconfiguredPhases,
    { 3: 1 },
    "the promoted puzzle waits for a phase 3 skill a human has not configured",
  );
});
