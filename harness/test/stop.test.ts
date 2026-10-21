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
// It is written temp-file-and-rename, so a failed or interrupted write cannot
// shred the record, and it is idempotent per round number, so a re-called
// judge_round replaces its own entry instead of double-appending and turning a
// decided round into two contradictory ones. The record is also a **latch**: once
// a round is recorded as STOP, no later round may be appended and no re-record may
// change a stop/continue outcome up to and including that round. Without the latch
// a re-run of an earlier round could quietly reopen a gate the loop had closed.
// Decisions are always recomputed from the stored summaries, so a hand-altered
// `decision` field cannot open it either.
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
    // Load-bearing for the size guard: the latest top is a **strict subset** of the
    // previous round's five, so the membership loop alone would call the sets equal
    // and report a spurious `top-stable`. Only the size check keeps this continue.
    name: "round 2: a top 5 that shrinks to a strict subset of three is never top-stable",
    history: [
      round(0, TOP5),
      round(1, ["p01", "p02", "p03", "p04", "p06"], [child("c1", "p01", true)]),
      round(2, ["p01", "p02", "p03"], [child("c2", "p01", true)]),
    ],
    expected: CONTINUE,
  },
  {
    name: "round 2: a top of three that grows to five is never top-stable",
    history: [
      round(0, ["p01", "p02", "p03"]),
      round(1, ["p01", "p02", "p03"], [child("c1", "p01", true)]),
      round(2, ["p01", "p02", "p03", "p04", "p05"], [child("c2", "p02", true)]),
    ],
    expected: CONTINUE,
  },
  {
    // Deliberate, not an accident of implementation: rule 2 applies from round 1
    // on, so a child that beats its parent without cracking the top five leaves the
    // monitoring set equal to round 0's and stops the loop after a single round.
    // The design says "the same in two consecutive rounds" with no exemption for
    // round 1, and the owner skill will tell the owner to expect this.
    name: "round 1: a child beat its parent but the top 5 equals round 0's, which is top-stable",
    history: [round(0, TOP5), round(1, TOP5, [child("c1", "p06", true)])],
    expected: { stop: true, reason: "top-stable" },
  },
  {
    // `top` is compared as a set, so a repeated id collapses: a five-entry list with
    // a repeat names the same four entrants as the previous round's four.
    name: "round 2: a duplicated id in top collapses, so the sets can still be stable",
    history: [
      round(0, TOP5),
      round(1, ["p01", "p02", "p03", "p04"], [child("c1", "p05", true)]),
      round(2, ["p01", "p01", "p02", "p03", "p04"], [child("c2", "p05", true)]),
    ],
    expected: { stop: true, reason: "top-stable" },
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
    // `decideStop` is a pure rule over the history it is given and judges only the
    // latest round; the latch that keeps a recorded stop closed lives in
    // `readStop`/`appendRound`, not here.
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

test("appendRound: a successful write leaves no temp file behind", (t) => {
  const file = roundsFile(t);
  appendRound(file, round(0, TOP5));
  appendRound(file, round(1, OTHER_TOP5, [child("c1", "p01", true)]));
  const left = readdirSync(path.dirname(file));
  assert.deepEqual(left, ["rounds.json"], `stray files after the writes: ${left.join(", ")}`);
});

test("appendRound: a failed write leaves the previous record intact", (t) => {
  const file = roundsFile(t);
  appendRound(file, round(0, TOP5));
  const before = readFileSync(file, "utf8");

  // The write goes to `<file>.<pid>.tmp`, so an unwritable temp path is a write
  // failure in the middle of the update. The record must be exactly as it was:
  // this is the property the temp-file-and-rename scheme exists for.
  const temp = `${file}.${process.pid}.tmp`;
  mkdirSync(temp, { recursive: true });
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  assert.throws(
    () => appendRound(file, round(1, OTHER_TOP5, [child("c1", "p01", true)])),
    /EISDIR|illegal operation on a directory/,
  );
  assert.equal(readFileSync(file, "utf8"), before, "a failed write must not change the record");
  assert.deepEqual(readStop(file), { stop: false });

  // With the obstruction gone the same call succeeds, so the failure left no state.
  rmSync(temp, { recursive: true, force: true });
  assert.deepEqual(appendRound(file, round(1, OTHER_TOP5, [child("c1", "p01", true)])), { stop: false });
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
  appendRound(file, round(3, ["p13", "p02", "p03", "p04", "p05"], [child("c3", "p02", true)]));
  assert.deepEqual(readStop(file), { stop: false });

  // The re-run round 1 now ranks TOP5, which is round 0's top set: round 1 becomes
  // top-stable, and every later decision is recomputed from the new history.
  const decision = appendRound(file, round(1, TOP5, [child("c1", "p02", true)]));
  assert.deepEqual(decision, { stop: true, reason: "top-stable" });
  assert.deepEqual(readStop(file), { stop: true, reason: "top-stable" });
  const stored = JSON.parse(readFileSync(file, "utf8")) as RoundRecord[];
  assert.deepEqual(
    stored.map((entry) => [entry.summary.round, entry.decision]),
    [
      [0, { stop: false }],
      [1, { stop: true, reason: "top-stable" }],
      [2, { stop: false }],
      [3, { stop: false }],
    ],
  );
});

// --- the latch ---------------------------------------------------------------
// A recorded STOP is what refuses the owner's `tree_create`, so it must not be
// undone by a re-run of the round that produced it or by a later round being
// recorded. Three paths, one each test: lifting the stop by re-recording, adding
// a round after the stop, and the idempotent re-call that must still work.

test("latch: a re-record that would lift the recorded stop is refused", (t) => {
  const file = roundsFile(t);
  appendRound(file, round(0, TOP5));
  appendRound(file, round(1, ["p11", "p02", "p03", "p04", "p05"], [child("c1", "p02", true)]));
  appendRound(file, round(2, ["p12", "p02", "p03", "p04", "p05"], [child("c2", "p02", true)]));
  appendRound(file, round(3, ["p12", "p02", "p03", "p04", "p05"], [child("c3", "p02", true)]));
  assert.deepEqual(readStop(file), { stop: true, reason: "top-stable" });
  const before = readFileSync(file, "utf8");

  // Re-ranking round 2 would break round 3's stable top and turn the STOP into a
  // continue - exactly the silence the latch exists to prevent.
  assert.throws(
    () => appendRound(file, round(2, ["p22", "p02", "p03", "p04", "p05"], [child("c2", "p02", true)])),
    /STOP is a latch and stands at round 3 \(top-stable\)/,
  );
  assert.equal(readFileSync(file, "utf8"), before, "a refused append must leave the record untouched");
  assert.deepEqual(readStop(file), { stop: true, reason: "top-stable" });
});

test("latch: a round after a recorded stop is refused", (t) => {
  const file = roundsFile(t);
  appendRound(file, round(0, TOP5));
  appendRound(file, round(1, OTHER_TOP5, [child("c1", "p01", false)]));
  assert.deepEqual(readStop(file), { stop: true, reason: "no-child-beat-parent" });
  const before = readFileSync(file, "utf8");

  // This round would continue on its own (a beating child, a changed top), but the
  // loop is over: recording it would reopen the gate.
  assert.throws(
    () => appendRound(file, round(2, ["p07", "p02", "p03", "p04", "p05"], [child("c2", "p02", true)])),
    /STOP already recorded at round 1 \(no-child-beat-parent\): no more rounds/,
  );
  assert.equal(readFileSync(file, "utf8"), before, "a refused append must leave the record untouched");
  assert.deepEqual(readStop(file), { stop: true, reason: "no-child-beat-parent" });
});

test("latch: an identical re-record of a stopped round is allowed and changes nothing", (t) => {
  const file = roundsFile(t);
  const stopped = round(1, OTHER_TOP5, [child("c1", "p01", false)]);
  appendRound(file, round(0, TOP5));
  appendRound(file, stopped);
  const before = readFileSync(file, "utf8");

  // The idempotent re-call the brief demands: same round, same summary, still STOP.
  assert.deepEqual(appendRound(file, stopped), { stop: true, reason: "no-child-beat-parent" });
  assert.equal(readFileSync(file, "utf8"), before, "an identical re-record must not touch the record");
  assert.deepEqual(readStop(file), { stop: true, reason: "no-child-beat-parent" });
});

test("latch: a stopped round may be re-recorded while the stop outcome is unchanged", (t) => {
  const file = roundsFile(t);
  appendRound(file, round(0, TOP5));
  appendRound(file, round(1, OTHER_TOP5, [child("c1", "p01", false)]));

  // A different losing child is still a losing child, so round 1 still stops; the
  // latch holds and the corrected record is accepted.
  const decision = appendRound(file, round(1, OTHER_TOP5, [child("c9", "p01", false), child("c1", "p02", false)]));
  assert.deepEqual(decision, { stop: true, reason: "no-child-beat-parent" });
  assert.deepEqual(readStop(file), { stop: true, reason: "no-child-beat-parent" });
  const stored = JSON.parse(readFileSync(file, "utf8")) as RoundRecord[];
  assert.equal(stored.length, 2);
  assert.deepEqual(stored[1]!.summary.children, [child("c9", "p01", false), child("c1", "p02", false)]);
});

test("latch: readStop self-corrects a record whose decision fields were altered to continue", (t) => {
  const file = roundsFile(t);
  mkdirSync(path.dirname(file), { recursive: true });
  // Parseable, but the stored decisions lie: round 1's summary has no beating child.
  writeFileSync(
    file,
    JSON.stringify([
      { summary: round(0, TOP5), decision: { stop: false } },
      { summary: round(1, OTHER_TOP5, [child("c1", "p01", false)]), decision: { stop: false } },
    ]),
  );
  assert.deepEqual(readStop(file), { stop: true, reason: "no-child-beat-parent" });
  // And the gate stays closed for an append, which derives the same latch.
  assert.throws(
    () => appendRound(file, round(2, ["p07", "p02", "p03", "p04", "p05"], [child("c2", "p02", true)])),
    /STOP already recorded at round 1/,
  );
});

test("latch: readStop reports the earliest stop even when a later round would continue", (t) => {
  const file = roundsFile(t);
  mkdirSync(path.dirname(file), { recursive: true });
  // Only reachable by hand (appendRound refuses a round after a stop), but the read
  // side must still answer with the stop: a later `continue` may not reopen the gate.
  writeFileSync(
    file,
    JSON.stringify([
      { summary: round(0, TOP5), decision: { stop: false } },
      {
        summary: round(1, OTHER_TOP5, [child("c1", "p01", false)]),
        decision: { stop: true, reason: "no-child-beat-parent" },
      },
      { summary: round(2, ["p07", "p02", "p03", "p04", "p05"], [child("c2", "p02", true)]), decision: { stop: false } },
    ]),
  );
  assert.deepEqual(readStop(file), { stop: true, reason: "no-child-beat-parent" });
});

test("latch: a re-record before the latch returns the latch's decision, not the round's own", (t) => {
  const file = roundsFile(t);
  appendRound(file, round(0, TOP5));
  appendRound(file, round(1, ["p11", "p02", "p03", "p04", "p05"], [child("c1", "p02", true)]));
  appendRound(file, round(2, ["p12", "p02", "p03", "p04", "p05"], [child("c2", "p02", true)]));
  appendRound(file, round(3, ["p12", "p02", "p03", "p04", "p05"], [child("c3", "p02", true)]));
  assert.deepEqual(readStop(file), { stop: true, reason: "top-stable" });

  // Round 2's own verdict stays continue, but the caller must be told the STOP that
  // stands, because that is the decision the owner's tree_create gate reads.
  const decision = appendRound(file, round(2, ["p12", "p02", "p03", "p04", "p05"], [child("c9", "p02", true)]));
  assert.deepEqual(decision, { stop: true, reason: "top-stable" });
  const stored = JSON.parse(readFileSync(file, "utf8")) as RoundRecord[];
  assert.deepEqual(stored[2]!.decision, { stop: false });
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
  const altered = JSON.stringify([{ summary: { round: 0 }, decision: { stop: "maybe" } }]);
  writeFileSync(file, altered);
  assert.throws(() => readStop(file), /entry 0/);
  assert.throws(() => appendRound(file, round(1, TOP5, [child("c1", "p01", true)])), /entry 0/);
  assert.equal(readFileSync(file, "utf8"), altered, "a refused append must not clobber the record");
});

test("appendRound: an invalid round number is refused", (t) => {
  const file = roundsFile(t);
  // Round 0 is recorded first, so only the integer guard can reject 0.5: without it
  // the round would simply land between 0 and 1 and the append would succeed.
  appendRound(file, round(0, TOP5));
  const before = readFileSync(file, "utf8");
  assert.throws(() => appendRound(file, round(0.5, TOP5)), /integer round number >= 0, got 0\.5/);
  assert.throws(() => appendRound(file, round(-1, TOP5)), /integer round number >= 0, got -1/);
  assert.equal(readFileSync(file, "utf8"), before, "a refused append must leave the record untouched");
});

test("appendRound: a hole above the recorded round is refused before writing", (t) => {
  const file = roundsFile(t);
  appendRound(file, round(0, TOP5));
  appendRound(file, round(1, OTHER_TOP5, [child("c1", "p01", true)]));
  const stored = JSON.parse(readFileSync(file, "utf8")) as RoundRecord[];
  // A hand-edited record with round 4 missing: re-recording round 1 must not write
  // a set that still has the hole, because rule 2 would silently skip round 4.
  writeFileSync(
    file,
    JSON.stringify([
      ...stored,
      { summary: round(2, ["p07", "p02", "p03", "p04", "p05"], [child("c2", "p01", true)]), decision: { stop: false } },
      { summary: round(4, ["p08", "p02", "p03", "p04", "p05"], [child("c4", "p01", true)]), decision: { stop: false } },
    ]),
  );
  const before = readFileSync(file, "utf8");
  assert.throws(
    () => appendRound(file, round(1, OTHER_TOP5, [child("c1", "p01", true)])),
    /round 3 is missing/,
  );
  assert.equal(readFileSync(file, "utf8"), before, "a refused append must leave the record untouched");
});
