// The owner's tournament tools: `judge_round` (the pool barrier, resumability,
// the summary append) and `check_duplicates` (the light distinctness check).
//
// These tests run against a real temp run - `initRun`, a phase-2 pattern node in
// `input`, real puzzle nodes with cards and merged reviews - so the pool barrier
// and the evolution-round validation see exactly the tree the owner sees. The
// judge is injected (`ToolDeps.transport`, or the module's
// `setTransportForTests` hook for the extension registration test), so no test
// spawns `pi`; cards carry a hidden `SIDE <id> strength <n>` marker that the fake
// judge reads, which makes the ranking recoverable.
//
// Every round test overrides the bootstrap resamples (`bootstrap: 20`) and the
// partial-run test overrides the wall-clock budget, because the module's
// production defaults (200 resamples, 8 minutes) are about a real round.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import ownerExtension from "../owner-extension.ts";
import { createChild, findNode, initRun, updateNode } from "../tree.ts";
import type { Transport } from "../tournament/judge.ts";
import { appendRound, readStop } from "../tournament/stop.ts";
import {
  checkDuplicates,
  judgeRound,
  setBudgetForTests,
  setTransportFactoryForTests,
  setTransportForTests,
  tournamentDir,
} from "../tournament/tools.ts";

const STRENGTH = /SIDE (\S+) strength (-?[0-9.]+)/g;

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ctc-tournament-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** The evidence sections `loadEntrant` is allowed to read from the pattern card. */
const PATTERN = [
  "# E03 Etiquette",
  "",
  "## Measure",
  "12 of 40 pages state the rule by example.",
  "",
  "## Result",
  "The ordering held at depth 2.",
  "",
  "## Verdict",
  "Contingent, with two deviant pages.",
  "",
  "## Worst fits",
  "Two pages do not fit.",
  "",
].join("\n");

interface Fixture {
  run: string;
  /** The submitted puzzle ids, in creation order. */
  ids: string[];
  tournament: string;
}

/**
 * A run with a phase-2 pattern node (status `input`) and `count` puzzle nodes,
 * each with a card carrying its hidden strength and a merged review, all
 * `submitted`. Strength rises with the id, so `P09` is the strongest of nine.
 */
function phase2Run(t: TestContext, count: number): Fixture {
  const run = tempDir(t);
  initRun(run, "data", "interest");
  createChild(run, "D01", "E03 Etiquette", "owner-p1");
  updateNode(run, "T01", { phase: 2, status: "input" }, "owner-p1");
  write(path.join(findNode(run, "T01").dir, "workspace", "pattern.md"), PATTERN);

  const ids: string[] = [];
  for (let index = 1; index <= count; index++) {
    const node = createChild(run, "T01", `Puzzle ${index}`, "owner-p2");
    addDraft(run, node.id, index * 0.5);
    updateNode(run, node.id, { status: "submitted" }, "owner-p2");
    ids.push(node.id);
  }
  return { run, ids, tournament: tournamentDir(run) };
}

/** Write a card with a hidden strength and the merged review a submitted puzzle needs. */
function addDraft(run: string, id: string, strength: number): void {
  const dir = findNode(run, id).dir;
  write(
    path.join(dir, "workspace", "puzzle.md"),
    [
      `# ${id} card`,
      "Lens: status quo",
      "Round: 0",
      "",
      "## Pattern",
      `SIDE ${id} strength ${strength.toFixed(2)}`,
      "",
      "## Violated expectation",
      "The rule is carried by example.",
      "",
    ].join("\n"),
  );
  write(path.join(dir, "workspace", "reviews", "merged.json"), JSON.stringify({ criteria: {}, flags: {} }));
}

/** A judge that names the stronger card (no noise, no position bias, no model). */
function strengthJudge(): Transport {
  return async (prompt: string) => {
    const found = [...prompt.matchAll(STRENGTH)];
    const first = Number(found[0]?.[2] ?? "0");
    const second = Number(found[1]?.[2] ?? "0");
    const winner = first > second + 0.05 ? 1 : second > first + 0.05 ? 2 : 0;
    return JSON.stringify({ winner, reason: `strength ${first} vs ${second}` });
  };
}

/** A judge that always picks the first slot: every match splits, so every result is a draw. */
function positionJudge(): Transport {
  return async () => JSON.stringify({ winner: 1, reason: "the first card" });
}

/** A duplicate check that always says yes in both orders. */
function sameJudge(): Transport {
  return async () => JSON.stringify({ same: true, reason: "the same puzzle" });
}

interface RoundFile {
  round: number;
  matches: { a: string; b: string; result: string }[];
  fit: { scores: Record<string, number>; lower: Record<string, number>; upper: Record<string, number> };
  top: string[];
  played: Record<string, number>;
}

function readRoundFile(dir: string, round: number): RoundFile {
  return JSON.parse(readFileSync(path.join(dir, `round-${round}.json`), "utf8")) as RoundFile;
}

function readRounds(dir: string): { summary: { round: number; top: string[]; children: unknown[] }; decision: unknown }[] {
  return JSON.parse(readFileSync(path.join(dir, "rounds.json"), "utf8")) as {
    summary: { round: number; top: string[]; children: unknown[] };
    decision: unknown;
  }[];
}

/** The logged matches of a round, header line excluded. */
function readLog(dir: string, round: number): { batch: number; pair: [string, string]; match: { a: string; b: string } }[] {
  const file = path.join(dir, `round-${round}.matches.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { header?: unknown })
    .filter((line) => line.header === undefined) as { batch: number; pair: [string, string]; match: { a: string; b: string } }[];
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

async function rejectMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("expected the call to be refused");
}

test("round 0 refuses while one submitted puzzle lacks its merged review, naming it", async (t) => {
  const fixture = phase2Run(t, 9);
  const missing = fixture.ids[4]!;
  rmSync(path.join(findNode(fixture.run, missing).dir, "workspace", "reviews", "merged.json"));

  const message = await rejectMessage(judgeRound(fixture.run, { round: 0 }, { transport: strengthJudge() }));
  assert.match(message, new RegExp(missing), "the refusal names the puzzle");
  assert.match(message, /merged\.json/, "and what it is missing");
  assert.ok(!existsSync(path.join(fixture.tournament, "round-0.matches.jsonl")), "no round was started");
});

test("round 0 refuses while a phase-2 puzzle is active, naming it", async (t) => {
  const fixture = phase2Run(t, 9);
  const running = fixture.ids[2]!;
  updateNode(fixture.run, running, { status: "active" }, "owner-p2");

  const message = await rejectMessage(judgeRound(fixture.run, { round: 0 }, { transport: strengthJudge() }));
  assert.match(message, new RegExp(running), "the refusal names the active puzzle");
  assert.match(message, /active/);
  assert.ok(!existsSync(path.join(fixture.tournament, "round-0.matches.jsonl")));
});

test("round 0 refuses a pool of six puzzles, naming the minimum", async (t) => {
  const fixture = phase2Run(t, 6);
  const message = await rejectMessage(judgeRound(fixture.run, { round: 0 }, { transport: strengthJudge() }));
  assert.match(message, /at least 7/);
  assert.match(message, /6/, "the pool size is stated");
});

test("round 0 completes, writes round-0.json and appends a continue decision", async (t) => {
  const fixture = phase2Run(t, 9);
  const text = await judgeRound(fixture.run, { round: 0 }, { transport: strengthJudge(), bootstrap: 20 });

  assert.match(text, /^COMPLETE/);
  assert.match(text, /Decision: CONTINUE/);
  assert.match(text, /Top 8/);
  assert.match(text, /matches played: \d+/i);
  assert.match(text, /promotion breaks/i);
  assert.ok(text.includes("P09"), `the strongest puzzle is in the top list: ${text}`);

  const stored = readRoundFile(fixture.tournament, 0);
  assert.equal(stored.round, 0);
  assert.ok(stored.matches.length > 0);
  const played = Object.values(stored.played);
  assert.ok(played.every((count) => count >= 6), `every entrant played six or more: ${JSON.stringify(stored.played)}`);

  const rounds = readRounds(fixture.tournament);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0]!.summary.round, 0);
  assert.deepEqual(rounds[0]!.decision, { stop: false });
  assert.deepEqual(rounds[0]!.summary.children, []);
});

test("a partial round says PARTIAL and a second call resumes without repeating a pair", async (t) => {
  const fixture = phase2Run(t, 9);
  const partial = await judgeRound(fixture.run, { round: 0 }, { transport: strengthJudge(), bootstrap: 20, budgetMs: 0 });

  assert.ok(
    partial.startsWith("PARTIAL — call judge_round again with the same arguments to resume"),
    `partial text: ${partial}`,
  );
  assert.match(partial, /matches played/i);
  assert.ok(!existsSync(path.join(fixture.tournament, "round-0.json")), "a partial round writes no round file");
  const firstLog = readLog(fixture.tournament, 0);
  assert.ok(firstLog.length > 0, "the first call played at least one batch");

  const complete = await judgeRound(fixture.run, { round: 0 }, { transport: strengthJudge(), bootstrap: 20 });
  assert.match(complete, /^COMPLETE/);
  const log = readLog(fixture.tournament, 0);
  const keys = log.map((line) => pairKey(line.pair[0], line.pair[1]));
  assert.equal(new Set(keys).size, keys.length, "no pair was judged twice across the resume");
  assert.ok(log.length > firstLog.length, "the second call played the remaining pairs");
  assert.equal(readRounds(fixture.tournament).length, 1, "the round is appended once");
});

test("round 1 plays the forced child/parent pair; beatParent is true when the child wins both orders", async (t) => {
  const fixture = phase2Run(t, 9);
  await judgeRound(fixture.run, { round: 0 }, { transport: strengthJudge(), bootstrap: 20 });

  const child = createChild(fixture.run, "T01", "grounding: crowd", "owner-p2", ["P01"]);
  addDraft(fixture.run, child.id, 99);
  updateNode(fixture.run, child.id, { status: "submitted" }, "owner-p2");

  const text = await judgeRound(
    fixture.run,
    { round: 1, entrants: fixture.ids.slice(0, 6), pairs: [{ child: child.id, parent: "P01" }] },
    { transport: strengthJudge(), bootstrap: 20 },
  );
  assert.match(text, /^COMPLETE/);

  const stored = readRoundFile(fixture.tournament, 1);
  const forced = stored.matches.find((match) => match.a === child.id && match.b === "P01");
  assert.ok(forced, "the forced pair is in the round file with the child as a");
  assert.equal(forced?.result, "a");

  const rounds = readRounds(fixture.tournament);
  const round1 = rounds.find((entry) => entry.summary.round === 1);
  assert.ok(round1);
  assert.deepEqual(round1?.summary.children, [{ child: child.id, parent: "P01", beatParent: true }]);
});

test("a split forced pair does not count as the child beating its parent", async (t) => {
  const fixture = phase2Run(t, 9);
  await judgeRound(fixture.run, { round: 0 }, { transport: strengthJudge(), bootstrap: 20 });

  const child = createChild(fixture.run, "T01", "simplification: crowd", "owner-p2", ["P01"]);
  addDraft(fixture.run, child.id, 99);
  updateNode(fixture.run, child.id, { status: "submitted" }, "owner-p2");

  const text = await judgeRound(
    fixture.run,
    { round: 1, entrants: fixture.ids.slice(0, 6), pairs: [{ child: child.id, parent: "P01" }] },
    { transport: positionJudge(), bootstrap: 20 },
  );
  assert.match(text, /STOP \(no-child-beat-parent\)/);
  assert.match(text, /no more evolution children/, "a STOP says plainly what it forbids");

  const rounds = readRounds(fixture.tournament);
  const round1 = rounds.find((entry) => entry.summary.round === 1);
  assert.deepEqual(round1?.summary.children, [{ child: child.id, parent: "P01", beatParent: false }]);
  assert.deepEqual(round1?.decision, { stop: true, reason: "no-child-beat-parent" });
});

test("judge_round refuses once a STOP is recorded", async (t) => {
  const fixture = phase2Run(t, 9);
  appendRound(path.join(fixture.tournament, "rounds.json"), { round: 0, top: fixture.ids, children: [] });
  appendRound(path.join(fixture.tournament, "rounds.json"), {
    round: 1,
    top: fixture.ids,
    children: [{ child: "P09", parent: "P01", beatParent: false }],
  });
  assert.deepEqual(readStop(path.join(fixture.tournament, "rounds.json")), { stop: true, reason: "no-child-beat-parent" });

  const message = await rejectMessage(judgeRound(fixture.run, { round: 2 }, { transport: strengthJudge() }));
  assert.match(message, /STOP already recorded \(no-child-beat-parent\): no more rounds/);
});

test("judge_round refuses a round number that is not next, naming the expected round", async (t) => {
  const fixture = phase2Run(t, 9);
  appendRound(path.join(fixture.tournament, "rounds.json"), { round: 0, top: fixture.ids, children: [] });

  const message = await rejectMessage(judgeRound(fixture.run, { round: 5 }, { transport: strengthJudge() }));
  assert.match(message, /expected round 1/);
});

test("a pool too small for six matches each is a tool error, not a partial round", async (t) => {
  const fixture = phase2Run(t, 3);
  appendRound(path.join(fixture.tournament, "rounds.json"), { round: 0, top: fixture.ids, children: [] });
  const child = createChild(fixture.run, "T01", "grounding: crowd", "owner-p2", ["P01"]);
  addDraft(fixture.run, child.id, 99);
  updateNode(fixture.run, child.id, { status: "submitted" }, "owner-p2");

  const message = await rejectMessage(
    judgeRound(
      fixture.run,
      { round: 1, entrants: ["P01", "P02"], pairs: [{ child: child.id, parent: "P01" }] },
      { transport: strengthJudge(), bootstrap: 20 },
    ),
  );
  assert.match(message, /judge_round: round 1 cannot progress/);
  assert.match(message, /too small/);
  assert.match(message, /minMatches 6/);
  assert.ok(!readRounds(fixture.tournament).some((entry) => entry.summary.round === 1), "a stuck round is not recorded");
});

test("round 1 validates that every child derives from its parent", async (t) => {
  const fixture = phase2Run(t, 9);
  appendRound(path.join(fixture.tournament, "rounds.json"), { round: 0, top: fixture.ids, children: [] });

  const message = await rejectMessage(
    judgeRound(
      fixture.run,
      { round: 1, entrants: ["P01", "P02"], pairs: [{ child: "P05", parent: "P01" }] },
      { transport: strengthJudge() },
    ),
  );
  assert.match(message, /P05/);
  assert.match(message, /derivedFrom/);
});

test("check_duplicates keeps the higher-rated of a same-puzzle pair and is idempotent", async (t) => {
  const fixture = phase2Run(t, 4);
  write(
    path.join(fixture.tournament, "round-0.json"),
    JSON.stringify({
      round: 0,
      matches: [],
      fit: { scores: { P01: 1, P02: 0, P03: -1, P04: -2 }, lower: {}, upper: {} },
      top: fixture.ids,
      played: {},
    }),
  );

  const text = await checkDuplicates(fixture.run, { ids: ["P01", "P02"] }, { transport: sameJudge() });
  assert.match(text, /P01/);
  assert.match(text, /P02/);
  assert.match(text, /keep P01, drop P02/);

  const file = path.join(fixture.tournament, "distinct.json");
  const first = readFileSync(file, "utf8");
  assert.deepEqual(JSON.parse(first), { checked: ["P01", "P02"], duplicates: [{ keep: "P01", drop: "P02" }] });

  const again = await checkDuplicates(fixture.run, { ids: ["P02", "P01"] }, { transport: sameJudge() });
  assert.match(again, /keep P01, drop P02/);
  assert.equal(readFileSync(file, "utf8"), first, "a re-call writes the same file, not a second entry");

  await checkDuplicates(fixture.run, { ids: ["P02", "P03"] }, { transport: sameJudge() });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    checked: ["P01", "P02", "P03"],
    duplicates: [
      { keep: "P01", drop: "P02" },
      { keep: "P02", drop: "P03" },
    ],
  });
});

test("check_duplicates needs two ids and a round that ranked them", async (t) => {
  const fixture = phase2Run(t, 4);
  write(
    path.join(fixture.tournament, "round-0.json"),
    JSON.stringify({
      round: 0,
      matches: [],
      fit: { scores: { P01: 1, P02: 0 }, lower: {}, upper: {} },
      top: ["P01", "P02"],
      played: {},
    }),
  );

  assert.match(await rejectMessage(checkDuplicates(fixture.run, { ids: ["P01"] }, { transport: sameJudge() })), /at least 2/);
  assert.match(
    await rejectMessage(checkDuplicates(fixture.run, { ids: ["P01", "P03"] }, { transport: sameJudge() })),
    /P03.*no Bradley-Terry score|no Bradley-Terry score.*P03/,
  );
});

test("round 1 resumes with the same forced pairs and records the started head-to-head", async (t) => {
  const fixture = phase2Run(t, 9);
  await judgeRound(fixture.run, { round: 0 }, { transport: strengthJudge(), bootstrap: 20 });
  const child = createChild(fixture.run, "T01", "grounding: crowd", "owner-p2", ["P01", "P02"]);
  addDraft(fixture.run, child.id, 99);
  updateNode(fixture.run, child.id, { status: "submitted" }, "owner-p2");
  const entrants = fixture.ids.slice(0, 6);

  const partial = await judgeRound(
    fixture.run,
    { round: 1, entrants, pairs: [{ child: child.id, parent: "P01" }] },
    { transport: strengthJudge(), bootstrap: 20, budgetMs: 0 },
  );
  assert.ok(partial.startsWith("PARTIAL — call judge_round again with the same arguments to resume"), partial);
  assert.ok(existsSync(path.join(fixture.tournament, "round-1.matches.jsonl")), "the forced batch landed");

  const complete = await judgeRound(
    fixture.run,
    { round: 1, entrants, pairs: [{ child: child.id, parent: "P01" }] },
    { transport: strengthJudge(), bootstrap: 20 },
  );
  assert.match(complete, /^COMPLETE/);
  const rounds = readRounds(fixture.tournament);
  const round1 = rounds.find((entry) => entry.summary.round === 1);
  assert.deepEqual(round1?.summary.children, [{ child: child.id, parent: "P01", beatParent: true }]);
});

test("a round-1 resume with a different parent is refused before it judges anything", async (t) => {
  const fixture = phase2Run(t, 9);
  await judgeRound(fixture.run, { round: 0 }, { transport: strengthJudge(), bootstrap: 20 });
  const child = createChild(fixture.run, "T01", "grounding: crowd", "owner-p2", ["P01", "P02"]);
  addDraft(fixture.run, child.id, 99);
  updateNode(fixture.run, child.id, { status: "submitted" }, "owner-p2");
  const entrants = fixture.ids.slice(0, 6);

  await judgeRound(
    fixture.run,
    { round: 1, entrants, pairs: [{ child: child.id, parent: "P01" }] },
    { transport: strengthJudge(), bootstrap: 20, budgetMs: 0 },
  );
  const logBefore = readLog(fixture.tournament, 1).length;

  const message = await rejectMessage(
    judgeRound(
      fixture.run,
      { round: 1, entrants, pairs: [{ child: child.id, parent: "P02" }] },
      { transport: strengthJudge(), bootstrap: 20 },
    ),
  );
  assert.match(message, new RegExp(`started with child ${child.id} against parent P01`));
  assert.match(message, /resume with the same pairs/);
  assert.equal(readLog(fixture.tournament, 1).length, logBefore, "the refused resume judged nothing");
  assert.ok(!readRounds(fixture.tournament).some((entry) => entry.summary.round === 1), "and recorded nothing");
});

test("a round without children is refused: it would latch STOP with no warning", async (t) => {
  const fixture = phase2Run(t, 9);
  appendRound(path.join(fixture.tournament, "rounds.json"), { round: 0, top: fixture.ids, children: [] });

  const message = await rejectMessage(
    judgeRound(
      fixture.run,
      { round: 1, entrants: fixture.ids.slice(0, 6), pairs: [] },
      { transport: strengthJudge() },
    ),
  );
  assert.match(message, /at least one child\/parent pair/);
  assert.match(message, /latches STOP/);
});

test("a forced pair whose ids already met in an earlier round is refused, naming the pair", async (t) => {
  const fixture = phase2Run(t, 9);
  // The child exists before round 0, so it and P01 are both in the first round's
  // match log: naming them as a round-1 head-to-head would re-use an old pair.
  const child = createChild(fixture.run, "T01", "grounding: crowd", "owner-p2", ["P01"]);
  addDraft(fixture.run, child.id, 99);
  updateNode(fixture.run, child.id, { status: "submitted" }, "owner-p2");
  await judgeRound(fixture.run, { round: 0 }, { transport: strengthJudge(), bootstrap: 20 });

  const message = await rejectMessage(
    judgeRound(
      fixture.run,
      { round: 1, entrants: fixture.ids.slice(0, 6), pairs: [{ child: child.id, parent: "P01" }] },
      { transport: strengthJudge(), bootstrap: 20 },
    ),
  );
  assert.match(message, new RegExp(`child ${child.id} and parent P01 already met`));
  assert.match(message, /old verdict would not be replayed/);
});

test("an engine failure (a held round lock) carries the judge_round prefix", async (t) => {
  const fixture = phase2Run(t, 9);
  const lock = path.join(fixture.tournament, "round-0.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(path.join(lock, "pid"), String(process.pid));

  const message = await rejectMessage(judgeRound(fixture.run, { round: 0 }, { transport: strengthJudge() }));
  assert.match(message, /^judge_round: /);
  assert.match(message, /another round is already running/);
});

test("check_duplicates orients a re-checked pair by the latest scores, keeping one entry", async (t) => {
  const fixture = phase2Run(t, 4);
  const roundFile = path.join(fixture.tournament, "round-0.json");
  const stored = (scores: Record<string, number>): string =>
    JSON.stringify({ round: 0, matches: [], fit: { scores, lower: {}, upper: {} }, top: fixture.ids, played: {} });

  write(roundFile, stored({ P01: 1, P02: 0, P03: -1, P04: -2 }));
  await checkDuplicates(fixture.run, { ids: ["P01", "P02"] }, { transport: sameJudge() });
  const file = path.join(fixture.tournament, "distinct.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).duplicates, [{ keep: "P01", drop: "P02" }]);

  // A later round flips the ranking: the fresh verdict replaces the old
  // orientation instead of sitting beside it.
  write(roundFile, stored({ P01: 0, P02: 1, P03: -1, P04: -2 }));
  await checkDuplicates(fixture.run, { ids: ["P01", "P02"] }, { transport: sameJudge() });
  const flipped = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(flipped.duplicates, [{ keep: "P02", drop: "P01" }]);
  assert.equal(flipped.duplicates.length, 1, "one entry per unordered pair");

  const bytes = readFileSync(file, "utf8");
  await checkDuplicates(fixture.run, { ids: ["P02", "P01"] }, { transport: sameJudge() });
  assert.equal(readFileSync(file, "utf8"), bytes, "a re-call is idempotent at the same scores");
});

interface CapturedTool {
  name: string;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<{ content: { type: string; text: string }[] }>;
}

function fakePi(): { pi: { registerTool(tool: CapturedTool): void; on(): void }; tools: Map<string, CapturedTool> } {
  const tools = new Map<string, CapturedTool>();
  return {
    pi: {
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
      on() {
        /* the write/edit guard is tested in guard.test.ts */
      },
    },
    tools,
  };
}

test("the registered judge_round uses the hooked transport and a tiny test budget", async (t) => {
  const fixture = phase2Run(t, 7);
  const { pi, tools } = fakePi();

  const savedRun = process.env.CTC_RUN_DIR;
  const savedPhase = process.env.CTC_PHASE;
  t.after(() => {
    if (savedRun === undefined) delete process.env.CTC_RUN_DIR;
    else process.env.CTC_RUN_DIR = savedRun;
    if (savedPhase === undefined) delete process.env.CTC_PHASE;
    else process.env.CTC_PHASE = savedPhase;
    setTransportForTests(undefined);
    setTransportFactoryForTests(undefined);
    setBudgetForTests(undefined);
  });
  process.env.CTC_RUN_DIR = fixture.run;
  setTransportForTests(strengthJudge());
  setBudgetForTests(0);
  // If the hook is not consulted, the factory throws and this test fails fast:
  // deleting the hook line can no longer leave the suite green.
  let factoryCalls = 0;
  setTransportFactoryForTests(() => {
    factoryCalls++;
    throw new Error("the transport factory must not be used when the hook is set");
  });
  ownerExtension(pi);

  const judge = tools.get("judge_round");
  const duplicates = tools.get("check_duplicates");
  assert.ok(judge, "judge_round is registered");
  assert.ok(duplicates, "check_duplicates is registered");

  process.env.CTC_PHASE = "1";
  await assert.rejects(() => judge.execute("c1", { round: 0 }), /judge_round is a phase-2 tool and you own P1/);
  await assert.rejects(() => duplicates.execute("c2", { ids: ["P01", "P02"] }), /check_duplicates is a phase-2 tool and you own P1/);

  process.env.CTC_PHASE = "2";
  const answer = await judge.execute("c3", { round: 0 });
  assert.ok(
    answer.content[0]?.text.startsWith("PARTIAL — call judge_round again with the same arguments to resume"),
    `the registered tool reached the module and the hooked judge: ${answer.content[0]?.text}`,
  );
  assert.equal(factoryCalls, 0, "the hook wins over the factory");
  await assert.rejects(() => duplicates.execute("c4", { ids: ["P01"] }), /at least 2/);
});

test("the default transport is built from the run's judgeModel, falling back to model", async (t) => {
  const fixture = phase2Run(t, 7);
  write(
    path.join(fixture.run, "config.json"),
    JSON.stringify({ model: "worker/model", judgeModel: "judge/model", phases: {} }),
  );
  const seen: string[] = [];
  setTransportForTests(undefined);
  setTransportFactoryForTests((model) => {
    seen.push(model);
    return strengthJudge();
  });
  t.after(() => setTransportFactoryForTests(undefined));

  const first = await judgeRound(fixture.run, { round: 0 }, { budgetMs: 0, bootstrap: 20 });
  assert.match(first, /^PARTIAL/);
  assert.deepEqual(seen, ["judge/model"], "the judge model, not the worker model");

  write(path.join(fixture.run, "config.json"), JSON.stringify({ model: "worker/model", phases: {} }));
  const second = await judgeRound(fixture.run, { round: 0 }, { budgetMs: 0, bootstrap: 20 });
  assert.match(second, /^PARTIAL/);
  assert.deepEqual(seen, ["judge/model", "worker/model"], "an absent judgeModel falls back to model");
});
