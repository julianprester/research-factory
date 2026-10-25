// The Phase 3 loop's records: the stop decision, the plan format, the round file.
//
// `decideStop` is a table over `changed` histories; `stopOf` is the latch over it.
// `parsePlan` is the one reading of `plan.md`. `readRounds`/`appendRound` own
// `rounds.json`, which must be contiguous, atomic and unreadable-means-error.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  appendRound,
  argumentSha,
  decideStop,
  loopDir,
  parsePlan,
  readRounds,
  ROUND_CAP,
  stopOf,
  writeAtomic,
  type RoundRecord,
} from "../explain/rounds.ts";

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ctc-rounds-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A history from a string of `c` (changed) and `n` (none), one character per round. */
function history(pattern: string): RoundRecord[] {
  return [...pattern].map((flag, index) => ({
    round: index + 1,
    changed: flag === "c",
    argumentSha: `sha${index + 1}`,
    summary: `round ${index + 1}`,
    letters: [String.fromCharCode(65 + index)],
  }));
}

test("the default cap is six", () => {
  assert.equal(ROUND_CAP, 6);
});

test("decideStop table", () => {
  const cases: [string, string, number | undefined, ReturnType<typeof decideStop>][] = [
    ["no rounds", "", undefined, { stop: false }],
    ["one round", "c", undefined, { stop: false }],
    ["changed, none", "cn", undefined, { stop: false }],
    ["none, none", "nn", undefined, { stop: true, reason: "two-quiet" }],
    ["none, changed, none", "ncn", undefined, { stop: false }],
    ["changed, none, none", "cnn", undefined, { stop: true, reason: "two-quiet" }],
    ["six changed rounds", "cccccc", undefined, { stop: true, reason: "cap" }],
    ["five changed rounds", "ccccc", undefined, { stop: false }],
    ["two quiet at round 6 is two-quiet, not cap", "cccc" + "nn", undefined, { stop: true, reason: "two-quiet" }],
    ["a single quiet round at the cap is cap", "cccccn", undefined, { stop: true, reason: "cap" }],
    ["a configured cap of 3", "ccc", 3, { stop: true, reason: "cap" }],
    ["a configured cap of 3, not yet reached", "cc", 3, { stop: false }],
    ["a configured cap of 8 lets round 6 continue", "cccccc", 8, { stop: false }],
  ];
  for (const [name, pattern, cap, expected] of cases) {
    assert.deepEqual(decideStop(history(pattern), cap), expected, name);
  }
});

test("decideStop needs the two quiet rounds to be consecutive", () => {
  const gap: RoundRecord[] = [
    { round: 1, changed: false, argumentSha: "a", summary: "s", letters: ["A"] },
    { round: 3, changed: false, argumentSha: "b", summary: "s", letters: ["B"] },
  ];
  assert.deepEqual(decideStop(gap), { stop: false });
});

test("stopOf is a latch: a stop in a prefix stands whatever follows", () => {
  assert.deepEqual(stopOf(history("cnnc")), { stop: true, reason: "two-quiet" });
  assert.deepEqual(stopOf(history("ccccccc"), 6), { stop: true, reason: "cap" });
  assert.deepEqual(stopOf(history("cnc")), { stop: false });
});

test("stopOf honours a recorded stop, whatever cap the config holds now", () => {
  const recorded = history("cc").map((record, index) => (index === 1 ? { ...record, stop: "cap" as const } : record));
  assert.deepEqual(stopOf(recorded, 6), { stop: true, reason: "cap" }, "a raised cap does not un-latch it");
  assert.deepEqual(stopOf(recorded, 2), { stop: true, reason: "cap" });
  const quiet = history("cnn").map((record, index) => (index === 2 ? { ...record, stop: "cap" as const } : record));
  assert.deepEqual(stopOf(quiet, 6), { stop: true, reason: "cap" }, "the recorded reason is the one reported, not a re-derived one");
  assert.deepEqual(stopOf(history("cc"), 6), { stop: false }, "records without a stop read as before");
  assert.deepEqual(stopOf(history("cc"), 2), { stop: true, reason: "cap" }, "and still derive it from the cap");
});

test("rounds.json keeps a recorded stop, and refuses a stop that is not one of the two reasons", (t) => {
  const run = tempDir(t);
  const [one, two] = history("cc");
  appendRound(run, "E01", one!, 2);
  appendRound(run, "E01", { ...two!, stop: "cap" }, 2);
  assert.deepEqual(readRounds(run, "E01")[1]?.stop, "cap");
  assert.equal(Object.hasOwn(readRounds(run, "E01")[0]!, "stop"), false, "an old-style record gains no key");
  const file = path.join(loopDir(run, "E01"), "rounds.json");
  writeFileSync(file, JSON.stringify([{ ...one!, stop: "tired" }]));
  assert.throws(() => readRounds(run, "E01"), /rounds:.*entry 0/);
  writeFileSync(file, JSON.stringify([one!]));
  assert.deepEqual(readRounds(run, "E01"), [one], "the old shape still reads");
});

test("parsePlan accepts a two-task plan", () => {
  const plan = parsePlan(
    [
      "# Round 1",
      "",
      "## Questions",
      "- Does the ordering hold at depth 2?",
      "",
      "## Tasks",
      "",
      "### Task A: Measure the ordering",
      "Inputs: the exploration split.",
      "",
      "### Task B: Test the artifact reading",
      "Definition of done: a registry of the counts.",
      "",
    ].join("\n"),
  );
  assert.deepEqual(plan, {
    questions: "- Does the ordering hold at depth 2?",
    tasks: [
      { letter: "A", aim: "Measure the ordering" },
      { letter: "B", aim: "Test the artifact reading" },
    ],
  });
});

test("parsePlan rejects what it cannot read as a plan", () => {
  const questions = "## Questions\nWhy?\n\n";
  assert.equal(parsePlan(`${questions}## Tasks\n\n### Task AB: two letters\n`), null, "a two-letter task");
  assert.equal(parsePlan(`${questions}## Tasks\n\n### Task a: lowercase\n`), null, "a lowercase letter");
  assert.equal(parsePlan(`${questions}## Tasks\n\n### Task A: ok\n\n### Task B - no colon\n`), null, "a malformed task heading");
  assert.equal(parsePlan(`${questions}### Task A: aim\n`), null, "a missing ## Tasks");
  assert.equal(parsePlan("## Tasks\n\n### Task A: aim\n"), null, "a missing ## Questions");
  assert.equal(parsePlan(`${questions}## Tasks\n\nNothing yet.\n`), null, "no task listed");
  assert.equal(parsePlan(`${questions}## Tasks\n\n\`\`\`\n### Task A: in a fence\n\`\`\`\n`), null, "a task in a fence");
});

test("parsePlan bends on heading case and a trailing colon", () => {
  const plan = parsePlan("## questions:\nWhy?\n\n## **Tasks**\n### Task C: aim\r\n");
  assert.deepEqual(plan?.tasks, [{ letter: "C", aim: "aim" }]);
});

test("rounds.json: absent is empty, appends are contiguous, the file is atomic", (t) => {
  const run = tempDir(t);
  assert.deepEqual(readRounds(run, "E01"), []);
  const [one, two] = history("cn");
  appendRound(run, "E01", one!);
  appendRound(run, "E01", two!);
  assert.deepEqual(readRounds(run, "E01"), [one, two]);
  assert.deepEqual(
    readdirSync(loopDir(run, "E01")),
    ["rounds.json"],
    "no temp file is left behind",
  );
  assert.throws(() => appendRound(run, "E01", history("cncn")[3]!), /next round is 3/);
  assert.throws(() => appendRound(run, "E01", { ...one!, round: 2 }), /next round is 3/);
});

test("appendRound refuses any round after a stop", (t) => {
  const run = tempDir(t);
  for (const record of history("nn")) appendRound(run, "E01", record);
  assert.throws(() => appendRound(run, "E01", history("nnc")[2]!), /STOP recorded \(two-quiet\): no more rounds/);
  assert.equal(readRounds(run, "E01").length, 2);
});

test("a damaged rounds.json is an error, never a fresh start", (t) => {
  const run = tempDir(t);
  const file = path.join(loopDir(run, "E01"), "rounds.json");
  mkdirSync(path.dirname(file), { recursive: true });
  for (const bad of ["{ not json", "{}", JSON.stringify([{ round: 2, changed: true }]), JSON.stringify(history("cc").reverse())]) {
    writeFileSync(file, bad);
    assert.throws(() => readRounds(run, "E01"), /rounds:/, bad);
  }
});

test("argumentSha hashes the regular file and refuses a link", (t) => {
  const node = tempDir(t);
  mkdirSync(path.join(node, "workspace"));
  assert.throws(() => argumentSha(node), /argument\.md is missing/);
  writeFileSync(path.join(node, "workspace", "argument.md"), "one");
  const first = argumentSha(node);
  assert.match(first, /^[0-9a-f]{64}$/);
  writeFileSync(path.join(node, "workspace", "argument.md"), "two");
  assert.notEqual(argumentSha(node), first);

  rmSync(path.join(node, "workspace", "argument.md"));
  writeFileSync(path.join(node, "elsewhere.md"), "one");
  symlinkSync(path.join(node, "elsewhere.md"), path.join(node, "workspace", "argument.md"));
  assert.throws(() => argumentSha(node), /link/);
  assert.ok(existsSync(path.join(node, "elsewhere.md")));
});

test("writeAtomic does not write through a link planted at the old predictable temp name", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "out.md");
  const victim = path.join(dir, "victim.txt");
  writeFileSync(victim, "untouched");
  symlinkSync(victim, `${file}.${process.pid}.tmp`);

  const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
  writeAtomic(file, bytes);
  assert.equal(readFileSync(victim, "utf8"), "untouched");
  assert.deepEqual(readFileSync(file), bytes, "bytes are written exactly");
  assert.deepEqual(readdirSync(dir).sort(), [path.basename(`${file}.${process.pid}.tmp`), "out.md", "victim.txt"].sort());

  writeAtomic(file, "text");
  assert.equal(readFileSync(file, "utf8"), "text");
});

test("parsePlan accepts a reopen task heading, and reads its letter from the R<n><L> form", () => {
  const plan = parsePlan("## Questions\nWhy?\n\n## Tasks\n\n### Task R1A: reopen aim\n### Task R12C: another\n");
  assert.deepEqual(plan?.tasks, [
    { letter: "R1A", aim: "reopen aim" },
    { letter: "R12C", aim: "another" },
  ]);
  assert.equal(parsePlan("## Questions\nWhy?\n\n## Tasks\n\n### Task R1: no letter\n"), null, "a reopen number with no letter");
  assert.equal(parsePlan("## Questions\nWhy?\n\n## Tasks\n\n### Task R1a: lowercase\n"), null, "a lowercase letter after digits");
});

test("rounds.json: an old file without reopen reads unchanged, and a reopen number is kept when positive", (t) => {
  const run = tempDir(t);
  const file = path.join(loopDir(run, "E01"), "rounds.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const original = history("cccccc");
  writeFileSync(file, JSON.stringify(original));
  assert.deepEqual(readRounds(run, "E01"), original, "an old file reads as before");
  assert.equal(Object.hasOwn(readRounds(run, "E01")[0]!, "reopen"), false, "an old record gains no reopen key");

  const reopened = { ...history("c")[0]!, round: 7, reopen: 1 };
  writeFileSync(file, JSON.stringify([...original, reopened]));
  assert.equal(readRounds(run, "E01")[6]?.reopen, 1);
  for (const bad of [0, 1.5, -1, "1"]) {
    writeFileSync(file, JSON.stringify([...original, { ...reopened, reopen: bad }]));
    assert.throws(() => readRounds(run, "E01"), /rounds:.*entry 6/, `reopen ${JSON.stringify(bad)} is refused`);
  }
});

/** Six changed loop-0 rounds, the sixth storing its `cap` stop, written through appendRound. */
function stoppedOriginal(run: string): void {
  history("cccccc").forEach((record, index) => {
    appendRound(run, "E01", index === 5 ? { ...record, stop: "cap" } : record, 6);
  });
}

/** A reopen-n record for round `round`, changed or quiet. */
function reopenRecord(round: number, reopen: number, changed: boolean): RoundRecord {
  return { round, changed, argumentSha: `sha${round}`, summary: `round ${round}`, letters: ["A"], reopen };
}

test("appendRound: a reopen round follows a loop-0 cap stop, and its own loop stops at reopenRounds", (t) => {
  const run = tempDir(t);
  stoppedOriginal(run);
  appendRound(run, "E01", reopenRecord(7, 1, true), 6, 2);
  appendRound(run, "E01", reopenRecord(8, 1, true), 6, 2);
  const records = readRounds(run, "E01");
  assert.equal(records[6]?.reopen, 1, "round 7 is in reopen 1");
  assert.equal(records[7]?.stop, "cap", "round 8 stops reopen 1 at reopenRounds 2, and the stop is stored");
  assert.equal(Object.hasOwn(records[6]!, "stop"), false, "round 7 does not stop its loop");
  assert.throws(() => appendRound(run, "E01", reopenRecord(9, 1, true), 6, 2), /STOP recorded \(cap\) in reopen 1: no more rounds/);
  assert.equal(readRounds(run, "E01").length, 8);
});

test("appendRound: two quiet reopen rounds stop reopen 1 early, and a further round is refused", (t) => {
  const run = tempDir(t);
  stoppedOriginal(run);
  appendRound(run, "E01", reopenRecord(7, 1, false), 6, 2);
  appendRound(run, "E01", reopenRecord(8, 1, false), 6, 2);
  assert.equal(readRounds(run, "E01")[7]?.stop, "two-quiet");
  assert.throws(() => appendRound(run, "E01", reopenRecord(9, 1, true), 6, 2), /STOP recorded \(two-quiet\) in reopen 1/);
});

test("appendRound: a stop stored in a reopen round stands when reopenRounds is raised later", (t) => {
  const run = tempDir(t);
  stoppedOriginal(run);
  appendRound(run, "E01", reopenRecord(7, 1, true), 6, 2);
  appendRound(run, "E01", reopenRecord(8, 1, true), 6, 2);
  assert.throws(() => appendRound(run, "E01", reopenRecord(9, 1, true), 6, 9), /STOP recorded \(cap\) in reopen 1/);
});

test("appendRound: a reopen 2 round after reopen 1 stopped is accepted, and reopen 1 takes no more", (t) => {
  const run = tempDir(t);
  stoppedOriginal(run);
  appendRound(run, "E01", reopenRecord(7, 1, false), 6, 2);
  appendRound(run, "E01", reopenRecord(8, 1, false), 6, 2);
  appendRound(run, "E01", reopenRecord(9, 2, true), 6, 2);
  assert.equal(readRounds(run, "E01")[8]?.reopen, 2);
  assert.throws(() => appendRound(run, "E01", reopenRecord(10, 1, true), 6, 2), /reopen 1/, "reopen 1 is not the current loop");
  assert.equal(readRounds(run, "E01").length, 9);
});

test("appendRound: a loop-0 round after loop 0 stopped is refused, even with reopens recorded", (t) => {
  const run = tempDir(t);
  stoppedOriginal(run);
  const loopZero = (round: number): RoundRecord => ({ ...reopenRecord(round, 1, true), reopen: undefined });
  assert.throws(() => appendRound(run, "E01", loopZero(7), 6, 2), /STOP recorded \(cap\): no more rounds/, "before any reopen");
  appendRound(run, "E01", reopenRecord(7, 1, true), 6, 2);
  assert.throws(() => appendRound(run, "E01", loopZero(8), 6, 2), /STOP recorded \(cap\): no more rounds/, "after a reopen round");
  assert.equal(readRounds(run, "E01").length, 7);
});

test("appendRound: a reopen round is refused while loop 0 has not stopped", (t) => {
  const run = tempDir(t);
  for (const record of history("ccccc")) appendRound(run, "E01", record, 6);
  assert.throws(() => appendRound(run, "E01", reopenRecord(6, 1, true), 6, 2), /loop 0 has not stopped/);
  assert.equal(readRounds(run, "E01").length, 5);
});

test("appendRound: round numbers stay contiguous across loops", (t) => {
  const run = tempDir(t);
  stoppedOriginal(run);
  assert.throws(() => appendRound(run, "E01", reopenRecord(8, 1, true), 6, 2), /next round is 7/, "a reopen round that skips a number");
  assert.throws(() => appendRound(run, "E01", reopenRecord(6, 1, true), 6, 2), /next round is 7/, "a reopen round that repeats a number");
  assert.equal(readRounds(run, "E01").length, 6);
});

test("appendRound: a stop given in a reopen round must be the one its loop decides", (t) => {
  const run = tempDir(t);
  stoppedOriginal(run);
  assert.throws(
    () => appendRound(run, "E01", { ...reopenRecord(7, 1, true), stop: "two-quiet" }, 6, 2),
    /stop "two-quiet" is not what reopen 1 decides/,
    "a stop on a loop that continues is refused",
  );
  appendRound(run, "E01", reopenRecord(7, 1, false), 6, 2);
  assert.throws(
    () => appendRound(run, "E01", { ...reopenRecord(8, 1, true), stop: "two-quiet" }, 6, 2),
    /stop "two-quiet" is not what reopen 1 decides/,
    "a wrong reason on the stopping round is refused",
  );
  assert.equal(readRounds(run, "E01").length, 7);
});

/** An original-loop record (no `reopen`), as the owner's close_round writes one. */
function originalRecord(round: number, changed = true): RoundRecord {
  return { round, changed, argumentSha: `sha${round}`, summary: `round ${round}`, letters: ["A"] };
}

/** The rounds file's bytes, or undefined when it is absent. */
function bytesOf(run: string): string | undefined {
  const file = path.join(loopDir(run, "E01"), "rounds.json");
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

/** A refused append throws the message and leaves the rounds file exactly as it was. */
function refusedWritingNothing(run: string, record: RoundRecord, cap: number, reopenRounds: number, pattern: RegExp, label: string): void {
  const before = bytesOf(run);
  assert.throws(() => appendRound(run, "E01", record, cap, reopenRounds), pattern, label);
  assert.equal(bytesOf(run), before, `${label}: the file is unchanged`);
}

test("appendRound refuses a record that readRounds would refuse, and writes nothing (I1)", (t) => {
  const run = tempDir(t);
  const [one, two] = history("cc");
  appendRound(run, "E01", one!, 6);
  const bad: [string, unknown][] = [
    ["reopen 0", { ...two!, reopen: 0 }],
    ["reopen null", { ...two!, reopen: null }],
    ["reopen a string", { ...two!, reopen: "1" }],
    ["a stop that is not a reason", { ...two!, stop: "nope" }],
    ["a non-string summary", { ...two!, summary: 7 }],
    ["letters that are not strings", { ...two!, letters: [1] }],
    ["a changed that is not a boolean", { ...two!, changed: "yes" }],
  ];
  for (const [label, record] of bad) {
    refusedWritingNothing(run, record as RoundRecord, 6, 2, /not a round record/, label);
  }
  assert.deepEqual(readRounds(run, "E01"), [one], "the history still reads");
});

test("appendRound refuses an unreadable record when no rounds file exists yet (I1)", (t) => {
  const run = tempDir(t);
  refusedWritingNothing(run, { ...originalRecord(1), reopen: 0 }, 6, 2, /not a round record/, "reopen 0 on round 1");
  assert.equal(bytesOf(run), undefined, "no file is created");
});

test("appendRound refuses an original round once a reopen round is recorded, even under a raised cap (I2)", (t) => {
  const run = tempDir(t);
  // A legacy six-round file: no stop is stored, so the cap decides loop 0.
  writeAtomic(path.join(loopDir(run, "E01"), "rounds.json"), `${JSON.stringify(history("cccccc"))}\n`);
  appendRound(run, "E01", reopenRecord(7, 1, true), 6, 2);
  refusedWritingNothing(run, originalRecord(8), 9, 2, /cannot record original round 8: reopen rounds follow it/, "loop 0 after a reopen under cap 9");
  const records = readRounds(run, "E01");
  assert.equal(records.length, 7, "the reopen round stands and no original round follows it");
  assert.equal(records[6]?.reopen, 1);
});

test("appendRound stores no stop it cannot decide, on loop 0 as on a reopen (I3)", (t) => {
  const run = tempDir(t);
  const [one, two] = history("cn");
  refusedWritingNothing(run, { ...one!, stop: "two-quiet" }, 6, 2, /stop "two-quiet" is not what the original loop decides/, "a bogus two-quiet on round 1");
  refusedWritingNothing(run, { ...one!, stop: "cap" }, 6, 2, /stop "cap" is not what the original loop decides/, "a cap on round 1 under cap 6");
  appendRound(run, "E01", one!, 2);
  refusedWritingNothing(run, { ...two!, stop: "two-quiet" }, 2, 2, /stop "two-quiet" is not what the original loop decides/, "two-quiet where cap decides");
  refusedWritingNothing(run, { ...two!, stop: "cap" }, 6, 2, /stop "cap" is not what the original loop decides/, "cap before the cap is reached");
  appendRound(run, "E01", { ...two!, stop: "cap" }, 2);
  assert.equal(readRounds(run, "E01")[1]?.stop, "cap", "the stop the loop decides is stored as given");
});

test("appendRound: an omitted stop on loop 0 is accepted as before", (t) => {
  const run = tempDir(t);
  const [one, two] = history("cn");
  appendRound(run, "E01", one!, 2);
  appendRound(run, "E01", two!, 2);
  assert.deepEqual(readRounds(run, "E01"), [one, two]);
});
