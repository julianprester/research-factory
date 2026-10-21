// The stopping rule is what keeps the evolution loop honest: the code, not the
// owner, decides when the rounds are done. Three signals, in this order - no
// child beat its parent (a split is a draw, so only a win in both orders counts),
// the top five are the same set two rounds running, or the hard cap of four
// rounds was reached with the loop still improving. The order is load-bearing:
// a capped round whose children all failed to beat their parents reports the
// failed improvement, not the cap, because "we ran out of rounds" and "the loop
// stopped improving" mean different things to the owner's record.
//
// The stop record itself is `rounds.json`: an array of `{summary, decision}`.
// It is written temp-file-and-rename, so a crash mid-write cannot shred the
// record, and it is idempotent per round number, so a re-called judge_round
// replaces its own entry instead of double-appending and turning a decided
// round into two contradictory ones.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  appendRound,
  decideStop,
  EVOLUTION_CAP,
  readStop,
  TOP_SIZE,
  type Decision,
  type RoundRecord,
  type RoundSummary,
} from "../tournament/stop.ts";

const TOP5 = ["p01", "p02", "p03", "p04", "p05"];
const OTHER_TOP5 = ["p06", "p02", "p03", "p04", "p05"];

/** One child's head-to-head against its parent. */
function child(name: string, parent: string, beatParent: boolean): RoundSummary["children"][number] {
  return { child: name, parent, beatParent };
}

function round(roundNumber: number, top: string[], children: RoundSummary["children"] = []): RoundSummary {
  return { round: roundNumber, top, children };
}

/** The rounds 0..n of a run that keeps improving: children beat parents, the top churns. */
function improvingHistory(latest: number): RoundSummary[] {
  const history = [round(0, TOP5)];
  for (let r = 1; r <= latest; r++) {
    history.push(round(r, [`p1${r}`, "p02", "p03", "p04", "p05"], [child(`c${r}`, "p02", true)]));
  }
  return history;
}

function tempDir(t: TestContext, label = "ctc-stop-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), label));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The stop-record file, under a directory appendRound has to create itself. */
function roundsFile(t: TestContext): string {
  return path.join(tempDir(t), "owners", "phase-2", "tournament", "rounds.json");
}

interface Case {
  name: string;
  history: RoundSummary[];
  expected: Decision;
}

const CONTINUE: Decision = { stop: false };

const CASES: Case[] = [
  {
    name: "no history at all is continue",
    history: [],
    expected: CONTINUE,
  },
  {
    name: "round 0 never stops, even with no children",
    history: [round(0, TOP5)],
    expected: CONTINUE,
  },
  {
    name: "round 1: a child beat its parent and the top changed is continue",
    history: [round(0, TOP5), round(1, OTHER_TOP5, [child("c1", "p01", true)])],
    expected: CONTINUE,
  },
  {
    name: "round 1: no child beat its parent stops with no-child-beat-parent",
    history: [round(0, TOP5), round(1, OTHER_TOP5, [child("c1", "p01", false), child("c2", "p02", false)])],
    expected: { stop: true, reason: "no-child-beat-parent" },
  },
  {
    name: "round 1: zero children counts as no child beating",
    history: [round(0, TOP5), round(1, OTHER_TOP5, [])],
    expected: { stop: true, reason: "no-child-beat-parent" },
  },
  {
    name: "round 1: one winner among losers is enough to continue",
    history: [
      round(0, TOP5),
      round(1, OTHER_TOP5, [child("c1", "p01", false), child("c2", "p02", true)]),
    ],
    expected: CONTINUE,
  },
  {
    name: "round 2: identical top-5 sets in a different order is top-stable",
    history: [
      round(0, TOP5),
      round(1, ["p05", "p04", "p03", "p02", "p01"], [child("c1", "p01", true)]),
      round(2, TOP5, [child("c2", "p02", true)]),
    ],
    expected: { stop: true, reason: "top-stable" },
  },
  {
    name: "round 2: the same top-5 set with a different 6th is still top-stable",
    history: [
      round(0, TOP5),
      round(1, [...TOP5, "p06"], [child("c1", "p01", true)]),
      round(2, [...TOP5, "p07"], [child("c2", "p02", true)]),
    ],
    expected: { stop: true, reason: "top-stable" },
  },
  {
    name: "round 2: fewer than TOP_SIZE entries compare what is there",
    history: [
      round(0, ["p01", "p02", "p03"]),
      round(1, ["p03", "p02", "p01"], [child("c1", "p01", true)]),
      round(2, ["p02", "p01", "p03"], [child("c2", "p02", true)]),
    ],
    expected: { stop: true, reason: "top-stable" },
  },
  {
    name: "round 2: sets that differ in size are never top-stable",
    history: [
      round(0, ["p01", "p02", "p03"]),
      round(1, ["p01", "p02", "p03"], [child("c1", "p01", true)]),
      round(2, ["p01", "p02", "p03", "p04", "p05"], [child("c2", "p02", true)]),
    ],
    expected: CONTINUE,
  },
  {
    name: "round 2: one changed entrant in the top 5 is continue",
    history: [
      round(0, TOP5),
      round(1, TOP5, [child("c1", "p01", true)]),
      round(2, ["p01", "p02", "p03", "p04", "p08"], [child("c2", "p02", true)]),
    ],
    expected: CONTINUE,
  },
  {
    name: "rule order: a failed improvement outranks a stable top",
    history: [
      round(0, TOP5),
      round(1, TOP5, [child("c1", "p01", true)]),
      round(2, TOP5, [child("c2", "p02", false)]),
    ],
    expected: { stop: true, reason: "no-child-beat-parent" },
  },
  {
    name: "round 3: still improving is continue (the cap is 4, not 3)",
    history: improvingHistory(3),
    expected: CONTINUE,
  },
  {
    name: "round 4: improvements run into the cap",
    history: improvingHistory(4),
    expected: { stop: true, reason: "cap" },
  },
  {
    name: "rule order: round 4 with a child that did not beat its parent is no-child-beat-parent, not cap",
    history: [
      ...improvingHistory(3),
      round(4, ["p14", "p02", "p03", "p04", "p05"], [child("c4", "p02", false)]),
    ],
    expected: { stop: true, reason: "no-child-beat-parent" },
  },
  {
    name: "rule order: round 4 whose top is unchanged is top-stable, not cap",
    history: [
      ...improvingHistory(3),
      round(4, ["p13", "p02", "p03", "p04", "p05"], [child("c4", "p02", true)]),
    ],
    expected: { stop: true, reason: "top-stable" },
  },
  {
    name: "a later round with no improvement stays stopped",
    history: [...improvingHistory(3), round(4, ["p14", "p02", "p03", "p04", "p05"], []), round(5, OTHER_TOP5, [])],
    expected: { stop: true, reason: "no-child-beat-parent" },
  },
  {
    name: "the latest round decides, not an earlier stop",
    history: [
      round(0, TOP5),
      round(1, TOP5, []),
      round(2, ["p07", "p02", "p03", "p04", "p05"], [child("c2", "p02", true)]),
    ],
    expected: CONTINUE,
  },
];

for (const testCase of CASES) test(`decideStop: ${testCase.name}`, () => {
  assert.deepEqual(decideStop(testCase.history), testCase.expected);
});

test("the constants are the designed ones", () => {
  assert.equal(EVOLUTION_CAP, 4);
  assert.equal(TOP_SIZE, 5);
});

test("decideStop: history order does not matter, round numbers do", () => {
  const history = improvingHistory(4);
  const shuffled = [history[2]!, history[0]!, history[4]!, history[1]!, history[3]!];
  assert.deepEqual(decideStop(shuffled), { stop: true, reason: "cap" });
});

test("appendRound: round 0 is recorded as continue and readStop reads it back", (t) => {
  const file = roundsFile(t);
  assert.deepEqual(appendRound(file, round(0, TOP5)), { stop: false });
  assert.deepEqual(readStop(file), { stop: false });

  const stored = JSON.parse(readFileSync(file, "utf8")) as RoundRecord[];
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0]!.summary, round(0, TOP5));
  assert.deepEqual(stored[0]!.decision, { stop: false });
});

test("appendRound: a stopped round is recorded and readStop returns the latest decision", (t) => {
  const file = roundsFile(t);
  appendRound(file, round(0, TOP5));
  const decision = appendRound(file, round(1, OTHER_TOP5, [child("c1", "p01", false)]));
  assert.deepEqual(decision, { stop: true, reason: "no-child-beat-parent" });
  assert.deepEqual(readStop(file), { stop: true, reason: "no-child-beat-parent" });

  const stored = JSON.parse(readFileSync(file, "utf8")) as RoundRecord[];
  assert.deepEqual(
    stored.map((entry) => entry.summary.round),
    [0, 1],
  );
  assert.deepEqual(stored[1]!.decision, { stop: true, reason: "no-child-beat-parent" });
});

test("appendRound: re-recording a round replaces its entry instead of double-appending", (t) => {
  const file = roundsFile(t);
  appendRound(file, round(0, TOP5));
  appendRound(file, round(1, OTHER_TOP5, [child("c1", "p01", true)]));
  assert.deepEqual(readStop(file), { stop: false });

  // The judge round was called again and this time the child lost the head-to-head.
  const decision = appendRound(file, round(1, OTHER_TOP5, [child("c1", "p01", false)]));
  assert.deepEqual(decision, { stop: true, reason: "no-child-beat-parent" });

  const stored = JSON.parse(readFileSync(file, "utf8")) as RoundRecord[];
  assert.equal(stored.length, 2, "a re-called round must not add a second entry");
  assert.deepEqual(stored[1]!.summary.children, [child("c1", "p01", false)]);
  assert.deepEqual(readStop(file), { stop: true, reason: "no-child-beat-parent" });
});

test("appendRound: re-recording the same summary is a no-op on the record", (t) => {
  const file = roundsFile(t);
  const summary = round(0, TOP5);
  appendRound(file, summary);
  appendRound(file, summary);
  const stored = JSON.parse(readFileSync(file, "utf8")) as unknown[];
  assert.equal(stored.length, 1);
});

test("appendRound: a gap in the rounds is refused", (t) => {
  const file = roundsFile(t);
  assert.throws(
    () => appendRound(file, round(1, TOP5, [child("c1", "p01", true)])),
    /round 0 is missing/,
  );
  assert.equal(existsSync(file), false, "a refused append must not create the file");

  appendRound(file, round(0, TOP5));
  assert.throws(() => appendRound(file, round(2, TOP5, [child("c2", "p01", true)])), /round 1 is missing/);
  assert.throws(() => appendRound(file, round(4, TOP5, [child("c4", "p01", true)])), /rounds 1, 2, 3 are missing/);
});

test("appendRound: the file is written atomically, leaving no temp file behind", (t) => {
  const file = roundsFile(t);
  appendRound(file, round(0, TOP5));
  appendRound(file, round(1, OTHER_TOP5, [child("c1", "p01", true)]));
  const left = readdirSync(path.dirname(file));
  assert.deepEqual(left, ["rounds.json"], `stray files after the writes: ${left.join(", ")}`);
});

test("appendRound: a stale temp file from a crash is ignored, not read as the record", (t) => {
  const file = roundsFile(t);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.99999.tmp`, '[{"summary": {');
  assert.deepEqual(readStop(file), { stop: false });
  assert.deepEqual(appendRound(file, round(0, TOP5)), { stop: false });
  assert.deepEqual(readStop(file), { stop: false });
  const stored = JSON.parse(readFileSync(file, "utf8")) as unknown[];
  assert.equal(stored.length, 1);
});

test("appendRound: re-recording an earlier round recomputes the later decisions", (t) => {
  const file = roundsFile(t);
  appendRound(file, round(0, TOP5));
  appendRound(file, round(1, ["p11", "p02", "p03", "p04", "p05"], [child("c1", "p02", true)]));
  appendRound(file, round(2, ["p12", "p02", "p03", "p04", "p05"], [child("c2", "p02", true)]));
  appendRound(file, round(3, ["p12", "p02", "p03", "p04", "p05"], [child("c3", "p02", true)]));
  assert.deepEqual(readStop(file), { stop: true, reason: "top-stable" });

  // The re-run round 2 now ranks differently, so round 3 is no longer stable.
  appendRound(file, round(2, ["p22", "p02", "p03", "p04", "p05"], [child("c2", "p02", true)]));
  assert.deepEqual(readStop(file), { stop: false });
  const stored = JSON.parse(readFileSync(file, "utf8")) as RoundRecord[];
  assert.deepEqual(
    stored.map((entry) => entry.decision),
    [{ stop: false }, { stop: false }, { stop: false }, { stop: false }],
  );
});

test("appendRound: a duplicated round in a hand-damaged record heals to one entry", (t) => {
  const file = roundsFile(t);
  appendRound(file, round(0, TOP5));
  appendRound(file, round(1, OTHER_TOP5, [child("c1", "p01", true)]));
  const stored = JSON.parse(readFileSync(file, "utf8")) as RoundRecord[];
  writeFileSync(file, JSON.stringify([stored[0], stored[1], stored[1]]));

  appendRound(file, round(1, OTHER_TOP5, [child("c1", "p01", true)]));
  const healed = JSON.parse(readFileSync(file, "utf8")) as RoundRecord[];
  assert.deepEqual(
    healed.map((entry) => entry.summary.round),
    [0, 1],
  );
});

test("readStop: a missing file is continue", (t) => {
  assert.deepEqual(readStop(path.join(tempDir(t), "owners", "phase-2", "tournament", "rounds.json")), {
    stop: false,
  });
});

test("readStop: a damaged stop record throws rather than reporting continue", (t) => {
  const file = roundsFile(t);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '[{"summary": {"round": 0');
  assert.throws(() => readStop(file), /not valid JSON/);
});

test("appendRound: a damaged stop record throws and is left untouched", (t) => {
  const file = roundsFile(t);
  mkdirSync(path.dirname(file), { recursive: true });
  const damaged = '[{"summary": {"round": 0';
  writeFileSync(file, damaged);
  assert.throws(() => appendRound(file, round(0, TOP5)), /not valid JSON/);
  assert.equal(readFileSync(file, "utf8"), damaged, "a refused append must not clobber the record");
});

test("appendRound: a record of unknown shape is refused, not trusted", (t) => {
  const file = roundsFile(t);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify([{ summary: { round: 0 }, decision: { stop: "maybe" } }]));
  assert.throws(() => readStop(file), /entry 0/);
});

test("appendRound: an invalid round number is refused", (t) => {
  const file = roundsFile(t);
  assert.throws(() => appendRound(file, round(-1, TOP5)), /round/);
  assert.throws(() => appendRound(file, round(0.5, TOP5)), /round/);
});
