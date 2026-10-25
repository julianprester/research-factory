// reopen.ts: the reopen records and the per-loop stop. A reopen is its own bounded loop after the
// original stop, which it never lifts. `currentLoop` reads the loop that is current; `appendReopen`
// records the next reopen only once the loop before it has stopped; `readReopens` reads the file
// the way `readRounds` reads its own.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { appendReopen, currentLoop, readReopens, type ReopenRecord } from "../explain/reopen.ts";
import { loopDir, writeAtomic, type RoundRecord } from "../explain/rounds.ts";

const SHA = "a".repeat(64);

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ctc-reopen-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Rounds `first`.. from a string of `c` (changed) and `n` (none); `reopen` tags them when given. */
function rounds(pattern: string, first = 1, reopen?: number): RoundRecord[] {
  return [...pattern].map((flag, index) => ({
    round: first + index,
    changed: flag === "c",
    argumentSha: `sha${first + index}`,
    summary: `round ${first + index}`,
    letters: [String.fromCharCode(65 + index)],
    ...(reopen === undefined ? {} : { reopen }),
  }));
}

/** The same rounds with the last one storing its stop reason. */
function stoppedAt(records: RoundRecord[], stop: "two-quiet" | "cap"): RoundRecord[] {
  return records.map((record, index) => (index === records.length - 1 ? { ...record, stop } : record));
}

function entry(n: number, afterRound: number): ReopenRecord {
  return { n, requestSha: SHA, afterRound };
}

/** The loop's files on disk, as the tools leave them: rounds.json, and reopens.json when there are reopens. */
function write(run: string, records: RoundRecord[], reopens: ReopenRecord[] = []): void {
  writeAtomic(path.join(loopDir(run, "E01"), "rounds.json"), `${JSON.stringify(records, null, 2)}\n`);
  if (reopens.length > 0) writeAtomic(path.join(loopDir(run, "E01"), "reopens.json"), `${JSON.stringify(reopens, null, 2)}\n`);
}

test("currentLoop: six changed rounds and no reopen is the original cap stop", () => {
  assert.deepEqual(currentLoop(rounds("cccccc"), [], 6, 2), { reopen: 0, decision: { stop: true, reason: "cap" } });
});

test("currentLoop: a reopen with no records yet is open", () => {
  assert.deepEqual(currentLoop(rounds("cccccc"), [entry(1, 6)], 6, 2), { reopen: 1, decision: { stop: false } });
});

test("currentLoop: one changed reopen round continues, and two stop at the reopen's cap", () => {
  const original = rounds("cccccc");
  assert.deepEqual(currentLoop([...original, ...rounds("c", 7, 1)], [entry(1, 6)], 6, 2), {
    reopen: 1,
    decision: { stop: false },
  });
  assert.deepEqual(currentLoop([...original, ...rounds("cc", 7, 1)], [entry(1, 6)], 6, 2), {
    reopen: 1,
    decision: { stop: true, reason: "cap" },
  });
});

test("currentLoop: two quiet reopen rounds stop two-quiet; one quiet round does not", () => {
  const original = rounds("cccccc");
  assert.deepEqual(currentLoop([...original, ...rounds("nn", 7, 1)], [entry(1, 6)], 6, 2), {
    reopen: 1,
    decision: { stop: true, reason: "two-quiet" },
  });
  assert.deepEqual(currentLoop([...original, ...rounds("nc", 7, 1)], [entry(1, 6)], 6, 3).decision, { stop: false });
});

test("currentLoop: a recorded original stop holds when roundCap is raised later", () => {
  const original = stoppedAt(rounds("cccccc"), "cap");
  assert.deepEqual(currentLoop(original, [], 99, 2), { reopen: 0, decision: { stop: true, reason: "cap" } });
});

test("currentLoop: a recorded stop in a reopen stands whatever reopenRounds is now", () => {
  const reopened = stoppedAt(rounds("cc", 7, 1), "cap");
  assert.deepEqual(currentLoop([...rounds("cccccc"), ...reopened], [entry(1, 6)], 6, 9), {
    reopen: 1,
    decision: { stop: true, reason: "cap" },
  });
});

test("currentLoop: reopen 2 opens once reopen 1 has stopped, and reopen 1's stop stands", () => {
  const history = [...rounds("cccccc"), ...rounds("nn", 7, 1)];
  assert.deepEqual(currentLoop(history, [entry(1, 6), entry(2, 8)], 6, 2), { reopen: 2, decision: { stop: false } });
  assert.deepEqual(currentLoop(history, [entry(1, 6)], 6, 2), {
    reopen: 1,
    decision: { stop: true, reason: "two-quiet" },
  });
});

test("currentLoop throws on inconsistent input", () => {
  const original = rounds("cccccc");
  assert.throws(() => currentLoop(rounds("ccc"), [entry(1, 3)], 6, 2), /loop 0 has not stopped/, "a reopen while loop 0 runs");
  assert.throws(
    () => currentLoop([...original, ...rounds("c", 7, 1)], [], 6, 2),
    /in reopen 1, which has no entry/,
    "a reopen round with no entry",
  );
  assert.throws(
    () => currentLoop([...original, ...rounds("c", 7, 1)], [entry(1, 6), entry(2, 7)], 6, 2),
    /reopen 1 has not stopped/,
    "reopen 2 while reopen 1 runs",
  );
  assert.throws(
    () => currentLoop([...original, ...rounds("nn", 7, 1), ...rounds("c", 9)], [entry(1, 6)], 6, 2),
    /follows a reopen round/,
    "an original round after a reopen round",
  );
});

test("readReopens: absent is empty, and appended entries read back", (t) => {
  const run = tempDir(t);
  assert.deepEqual(readReopens(run, "E01"), []);
  write(run, rounds("cccccc"));
  appendReopen(run, "E01", entry(1, 6), 2);
  assert.deepEqual(readReopens(run, "E01"), [entry(1, 6)]);
  assert.deepEqual(readdirSync(loopDir(run, "E01")).sort(), ["reopens.json", "rounds.json"], "no temp file is left behind");
});

test("readReopens refuses a link and a damaged file, never reading them as none", (t) => {
  const run = tempDir(t);
  mkdirSync(loopDir(run, "E01"), { recursive: true });
  const file = path.join(loopDir(run, "E01"), "reopens.json");
  const elsewhere = path.join(run, "elsewhere.json");
  writeFileSync(elsewhere, JSON.stringify([entry(1, 6)]));
  symlinkSync(elsewhere, file);
  assert.throws(() => readReopens(run, "E01"), /link/);
  rmSync(file);
  const bad = [
    "{ not json",
    "{}",
    JSON.stringify([entry(2, 6)]),
    JSON.stringify([{ n: 1, requestSha: "nope", afterRound: 6 }]),
    JSON.stringify([{ n: 1, requestSha: SHA }]),
    JSON.stringify([{ n: 1, requestSha: SHA, afterRound: 0 }]),
  ];
  for (const text of bad) {
    writeFileSync(file, text);
    assert.throws(() => readReopens(run, "E01"), /reopens:/, text);
  }
});

test("appendReopen records the next reopen once the loop before it has stopped", (t) => {
  const run = tempDir(t);
  write(run, rounds("cccccc"));
  appendReopen(run, "E01", entry(1, 6), 2);
  assert.deepEqual(readReopens(run, "E01"), [entry(1, 6)]);
});

test("appendReopen refuses a reopen while loop 0 has not stopped", (t) => {
  const run = tempDir(t);
  write(run, rounds("ccc"));
  assert.throws(() => appendReopen(run, "E01", entry(1, 3), 2), /loop 0 has not stopped/);
  assert.deepEqual(readReopens(run, "E01"), []);
});

test("appendReopen refuses a reopen while the current reopen is still running", (t) => {
  const run = tempDir(t);
  write(run, [...rounds("cccccc"), ...rounds("c", 7, 1)], [entry(1, 6)]);
  assert.throws(() => appendReopen(run, "E01", entry(2, 7), 2), /loop 1 has not stopped/);
  assert.deepEqual(readReopens(run, "E01"), [entry(1, 6)]);
});

test("appendReopen refuses a third reopen at maxReopens 2", (t) => {
  const run = tempDir(t);
  write(run, [...rounds("cccccc"), ...rounds("nn", 7, 1), ...rounds("nn", 9, 2)], [entry(1, 6), entry(2, 8)]);
  assert.throws(() => appendReopen(run, "E01", entry(3, 10), 2), /maxReopens/);
  assert.equal(readReopens(run, "E01").length, 2);
});

test("appendReopen refuses a skipped reopen number", (t) => {
  const run = tempDir(t);
  write(run, rounds("cccccc"));
  assert.throws(() => appendReopen(run, "E01", entry(2, 6), 2), /next reopen is 1/);
});

test("appendReopen refuses an afterRound that is not the last recorded round", (t) => {
  const run = tempDir(t);
  write(run, rounds("cccccc"));
  assert.throws(() => appendReopen(run, "E01", entry(1, 5), 2), /afterRound/);
  assert.deepEqual(readReopens(run, "E01"), []);
});
