// The Phase 3 loop's records: the stop decision, the plan format, the round file.
//
// `decideStop` is a table over `changed` histories; `stopOf` is the latch over it.
// `parsePlan` is the one reading of `plan.md`. `readRounds`/`appendRound` own
// `rounds.json`, which must be contiguous, atomic and unreadable-means-error.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
