// The round runner pairs entrants, judges the pairs, and can be restarted.
//
// Two properties carry the weight here. Resumability (Review Focus 2): a crash
// mid-round must not double-count a match, lose one, or change the pairs a
// later batch would have played - so the log is replayed, batch k's pairs are
// re-derived from the state before batch k, and the replay is canonicalised so
// the order matches happened to finish in cannot matter. Isolation (Review
// Focus 3): the entrant loader reads the puzzle card and four pattern sections
// and nothing else, so no review text can reach the judge.
//
// The fake judge reads a hidden strength out of each card's text and names the
// stronger card, which makes the ranking recoverable and every run bit-for-bit
// reproducible.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createChild, initRun } from "../tree.ts";
import {
  acquireRoundLock,
  loadEntrant,
  pairKey,
  promotionCandidates,
  RoundStuckError,
  runRound,
  schedulePairs,
  type RoundOptions,
} from "../tournament/engine.ts";
import type { Side, Transport } from "../tournament/judge.ts";
import { fitBradleyTerry, type Fit, type Outcome } from "../tournament/rating.ts";

/** `SIDE <id> strength <number>`: content the fake judge reads, not an id it is told. */
const MARKER = /SIDE (\S+) strength (-?[0-9.]+)/g;

function tempDir(t: TestContext, label = "ctc-engine-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), label));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Hidden strengths, evenly spread; card text carries the marker. */
function strengthsOf(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index * 0.5);
}

function makeSides(count: number): Side[] {
  return strengthsOf(count).map((strength, index) => {
    const id = `p${String(index + 1).padStart(2, "0")}`;
    return { id, card: `## Pattern\nSIDE ${id} strength ${strength.toFixed(2)}`, evidence: `Result: evidence for ${id}.` };
  });
}

/** A judge that names the stronger card: no noise, no position bias, no model. */
function fakeJudge(): Transport {
  return async (prompt: string) => {
    const found = [...prompt.matchAll(MARKER)];
    const first = Number(found[0]?.[2] ?? "0");
    const second = Number(found[1]?.[2] ?? "0");
    const winner = first > second + 0.05 ? 1 : second > first + 0.05 ? 2 : 0;
    return JSON.stringify({ winner, reason: `strength ${first} vs ${second}` });
  };
}

interface LogLine {
  batch: number;
  pair: [string, string];
  match: { a: string; b: string; result: string };
}

function readLog(dir: string, round: number): LogLine[] {
  const file = path.join(dir, `round-${round}.matches.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LogLine & { header?: unknown })
    .filter((line) => line.header === undefined);
}

/** The log's raw header line: the schedule fingerprint a resumed call checks. */
function headerLine(dir: string, round: number): string {
  return readFileSync(path.join(dir, `round-${round}.matches.jsonl`), "utf8").split("\n")[0]!;
}

function options(overrides: Partial<RoundOptions> & { dir: string }): RoundOptions {
  return {
    round: 0,
    sides: [],
    forced: [],
    prior: [],
    transport: fakeJudge(),
    seed: 7,
    bootstrap: 20,
    ...overrides,
  };
}

test("a round on ten sides completes and writes the log and the round file", async (t) => {
  const dir = tempDir(t);
  const sides = makeSides(10);
  const result = await runRound(options({ dir, sides }));

  assert.equal(result.complete, true);
  for (const side of sides) {
    const matches = result.played[side.id] ?? 0;
    assert.ok(matches >= 6, `${side.id} played ${matches}, expected at least 6`);
  }

  const logged = readLog(dir, 0);
  assert.equal(logged.length, result.matches.length, "every finished match is in the log");
  const keys = logged.map((line) => pairKey(line.pair[0], line.pair[1]));
  assert.equal(new Set(keys).size, keys.length, "no pair is judged twice in one round");

  const written = JSON.parse(readFileSync(path.join(dir, "round-0.json"), "utf8"));
  assert.equal(written.round, 0);
  assert.deepEqual(written.sides, sides.map((side) => side.id).sort(), "the round file records its participants, sorted");
  assert.deepEqual(written.fit, result.fit, "the round file carries the fit the caller got");
  assert.deepEqual(written.top, result.top);
  assert.deepEqual(written.played, result.played);
  assert.equal(written.matches.length, result.matches.length);
  assert.deepEqual(result.sides, written.sides, "the caller gets the same participant list");

  assert.equal(result.top.length, sides.length, "every entrant is ranked");
  assert.ok(
    result.top.indexOf("p10") < result.top.indexOf("p01"),
    `the strongest entrant should outrank the weakest: ${result.top.join(",")}`,
  );
});

test("a crashed round resumes: no pair twice, the same matches and the same ranking", async (t) => {
  const interruptedDir = tempDir(t);
  const cleanDir = tempDir(t);
  const sides = makeSides(10);
  const clean = await runRound(options({ dir: cleanDir, sides }));

  // Two judge calls per match, so call 11 lands inside the sixth match of batch 0.
  let calls = 0;
  const judge = fakeJudge();
  const dying: Transport = async (prompt) => {
    calls++;
    if (calls === 11) throw new Error("judge died mid-round");
    return judge(prompt);
  };
  await assert.rejects(runRound(options({ dir: interruptedDir, sides, transport: dying })), /judge died/);

  const firstAttempt = readLog(interruptedDir, 0);
  assert.ok(firstAttempt.length >= 1 && firstAttempt.length <= 8, `killed after ${firstAttempt.length} matches`);
  assert.ok(!existsSync(path.join(interruptedDir, "round-0.json")), "a round that did not finish writes no round file");

  const resumed = await runRound(options({ dir: interruptedDir, sides }));
  assert.equal(resumed.complete, true);

  const wholeLog = readLog(interruptedDir, 0);
  const keys = wholeLog.map((line) => pairKey(line.pair[0], line.pair[1]));
  assert.equal(new Set(keys).size, keys.length, "no pair was played twice across the crash");
  assert.ok(
    keys.length > firstAttempt.length,
    `the resumed run played the remaining matches: ${firstAttempt.length} then ${keys.length}`,
  );
  assert.equal(resumed.matches.length, clean.matches.length, "a resumed round plays the same number of matches");
  assert.deepEqual(
    keys.slice().sort(),
    readLog(cleanDir, 0)
      .map((line) => pairKey(line.pair[0], line.pair[1]))
      .sort(),
    "the resumed round plays exactly the uninterrupted run's pairs",
  );
  assert.deepEqual(resumed.top, clean.top, "the ranking is identical to an uninterrupted run");
  assert.deepEqual(resumed.fit, clean.fit);
  assert.deepEqual(resumed.played, clean.played);
});

test("a log written in a different order plays the same later batches", async (t) => {
  const cleanDir = tempDir(t);
  const sides = makeSides(8);
  const opts = { sides, batchSize: 4, minMatches: 3 };
  const clean = await runRound(options({ ...opts, dir: cleanDir }));

  // Same first batch's matches on disk, written in the reverse (completion)
  // order, and nothing else: the resumed round must derive the same batches 1+
  // as the uninterrupted run did, so its whole match set is identical.
  const firstBatch = readLog(cleanDir, 0)
    .filter((line) => line.batch === 0)
    .reverse();
  assert.ok(firstBatch.length > 0);
  const otherDir = tempDir(t);
  writeFileSync(
    path.join(otherDir, "round-0.matches.jsonl"),
    [headerLine(cleanDir, 0), ...firstBatch.map((line) => JSON.stringify(line))].join("\n") + "\n",
  );
  const replayed = await runRound(options({ ...opts, dir: otherDir }));

  const keysOf = (dir: string): string[] =>
    readLog(dir, 0)
      .map((line) => pairKey(line.pair[0], line.pair[1]))
      .sort();
  assert.deepEqual(keysOf(otherDir), keysOf(cleanDir), "the log's order cannot change which pairs are played");
  assert.equal(replayed.complete, true);
  assert.deepEqual(replayed.top, clean.top);
  assert.deepEqual(replayed.played, clean.played);
  assert.deepEqual(replayed.fit, clean.fit);
});

test("a torn last line from a crash is dropped, not counted, and never swallows the next match", async (t) => {
  const dir = tempDir(t);
  const sides = makeSides(8);
  const opts = { dir, sides, batchSize: 4, minMatches: 3 };
  await runRound(options(opts));

  // A crash mid-append leaves a half-written line. Only the last line can tear:
  // appends are sequential, so the cut is at the end of the file.
  const file = path.join(dir, "round-0.matches.jsonl");
  const text = readFileSync(file, "utf8");
  writeFileSync(file, text.slice(0, text.length - 20));
  rmSync(path.join(dir, "round-0.json"));

  const resumed = await runRound(options(opts));
  assert.equal(resumed.complete, true);
  const lines = readLog(dir, 0);
  const keys = lines.map((line) => pairKey(line.pair[0], line.pair[1]));
  assert.equal(new Set(keys).size, keys.length, "the torn match is not doubled by the next append");
  const written = JSON.parse(readFileSync(path.join(dir, "round-0.json"), "utf8"));
  assert.equal(written.matches.length, lines.length, "every logged line parses as one match");
});

test("a pool too small for minMatches throws instead of reporting a partial round", async (t) => {
  const dir = tempDir(t);
  const sides = makeSides(6);
  // Six identities can give each entrant at most five opponents, so six matches
  // each is unreachable: the round must say so rather than return a partial
  // result a caller would retry forever.
  await assert.rejects(runRound(options({ dir, sides })), (error: unknown) => {
    assert.ok(error instanceof RoundStuckError, `expected RoundStuckError, got ${String(error)}`);
    assert.match(error.message, /too small/);
    assert.match(error.message, /minMatches 6/);
    for (const side of sides) assert.ok(error.message.includes(side.id), `the message names ${side.id}`);
    assert.deepEqual(error.short.slice().sort(), sides.map((side) => side.id), "every side is short");
    return true;
  });
  assert.ok(!existsSync(path.join(dir, "round-0.json")), "a stuck round writes no round file");
  assert.equal(readLog(dir, 0).length, 15, "the whole complete graph was played before giving up");
  // The lock is released even on the error path, so the caller can fix the pool.
  assert.ok(!existsSync(path.join(dir, "round-0.lock")));
});

test("seven identities are just enough for six matches each", async (t) => {
  const dir = tempDir(t);
  const sides = makeSides(7);
  const result = await runRound(options({ dir, sides }));

  assert.equal(result.complete, true);
  for (const side of sides) assert.equal(result.played[side.id], 6);
  assert.equal(result.matches.length, 21, "21 pairs is the complete graph on 7 identities");
});

/** Where a round's lock lives, so a test can plant one. */
function lockDir(dir: string, round = 0): string {
  return path.join(dir, `round-${round}.lock`);
}

/** A real pid that is no longer alive (an already-exited child). */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

/** Plant the tree-style lock: a directory holding the holder's pid file. */
function plantLock(dir: string, pid: number, round = 0): string {
  const lock = lockDir(dir, round);
  mkdirSync(lock, { recursive: true });
  writeFileSync(path.join(lock, "pid"), String(pid));
  return lock;
}

test("a lock whose holder is gone is broken, and the round runs", async (t) => {
  const dir = tempDir(t);
  const sides = makeSides(8);
  // A real, already-exited process: its pid is dead, so the lock is stale and
  // isStaleLock/breakStaleLock from the tree module break it.
  plantLock(dir, deadPid());

  const result = await runRound(options({ dir, sides, batchSize: 4, minMatches: 3 }));
  assert.equal(result.complete, true, "a dead holder's lock is broken and the round runs");
  assert.ok(!existsSync(lockDir(dir)), "and the broken lock is gone afterwards");
});

test("a young lock held by a live pid fails fast with an error naming the lock directory", async (t) => {
  const dir = tempDir(t);
  const sides = makeSides(8);
  const lock = plantLock(dir, process.pid);

  await assert.rejects(
    runRound(options({ dir, sides, batchSize: 4, minMatches: 3 })),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /another round is already running/);
      assert.ok(message.includes(lock), `the error names the lock directory: ${message}`);
      assert.match(message, /If no judge round is running, remove the lock directory/);
      return true;
    },
  );
  assert.equal(readFileSync(path.join(lock, "pid"), "utf8"), String(process.pid), "a live lock is left alone");
  assert.equal(readLog(dir, 0).length, 0, "and no match was judged");
});

test("a thrown round releases the lock so a retry can run", async (t) => {
  const dir = tempDir(t);
  const sides = makeSides(8);
  const opts = { dir, sides, batchSize: 4, minMatches: 3 };
  const dying: Transport = async () => {
    throw new Error("judge died on the first call");
  };

  await assert.rejects(runRound(options({ ...opts, transport: dying })), /judge died/);
  assert.ok(!existsSync(lockDir(dir)), "the transport-error path released the lock");

  const retried = await runRound(options(opts));
  assert.equal(retried.complete, true, "the retry is not blocked by a stranded lock");
  assert.ok(!existsSync(lockDir(dir)));
});

test("concurrent processes breaking one dead lock: exactly one holds it", async (t) => {
  const dir = tempDir(t);
  plantLock(dir, deadPid());
  // Three-plus callers hit the same stale lock at the same instant, all in real
  // processes: breakStaleLock's breaker directory must let exactly one of them
  // win, and the rest must fail fast against the winner's fresh lock - never
  // both run. This is the four-round bug (a breaker restoring a fresh lock into
  // an aside file) as a test.
  const engineUrl = new URL("../tournament/engine.ts", import.meta.url).href;
  const script = `
    const { acquireRoundLock } = await import(${JSON.stringify(engineUrl)});
    const fs = await import("node:fs");
    const [lock, ready, go] = process.argv.slice(1);
    fs.writeFileSync(ready, "ready");
    while (!fs.existsSync(go)) await new Promise((resolve) => setTimeout(resolve, 2));
    try {
      const release = acquireRoundLock(lock);
      console.log(JSON.stringify({ won: true }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      release();
    } catch (error) {
      console.log(JSON.stringify({ won: false, message: String(error?.message ?? error) }));
    }
  `;
  const count = 4;
  const children = Array.from({ length: count }, (_, index) =>
    spawn(process.execPath, ["--input-type=module", "-e", script, lockDir(dir), path.join(dir, `ready-${index}`), path.join(dir, "go")]),
  );
  const exits = children.map(
    (child) =>
      new Promise<string>((resolve, reject) => {
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
        child.on("error", reject);
        child.on("close", () => resolve(out));
      }),
  );

  // Wait until every process is parked on the go file, then release them together.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !Array.from({ length: count }, (_, i) => path.join(dir, `ready-${i}`)).every((file) => existsSync(file))) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  writeFileSync(path.join(dir, "go"), "go");

  const reports = (await Promise.all(exits)).flatMap((out) => out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { won: boolean; message?: string }));
  const winners = reports.filter((report) => report.won);
  assert.equal(winners.length, 1, `exactly one process holds the lock, got ${winners.length}: ${JSON.stringify(reports)}`);
  for (const loser of reports.filter((report) => !report.won)) {
    assert.match(loser.message ?? "", /another round is already running/, `a loser fails fast: ${loser.message}`);
  }
  assert.ok(!existsSync(lockDir(dir)), "the winner released the lock");
});

test("a second overlapping call on the same round fails fast instead of double counting", async (t) => {
  const dir = tempDir(t);
  const sides = makeSides(10);
  // budgetMs 0 keeps the first call in flight for one batch while the second runs.
  const first = runRound(options({ dir, sides, budgetMs: 0, batchSize: 4 }));
  await assert.rejects(runRound(options({ dir, sides, budgetMs: 0, batchSize: 4 })), /another round is already running/);
  const result = await first;

  assert.equal(result.complete, false);
  const keys = readLog(dir, 0).map((line) => pairKey(line.pair[0], line.pair[1]));
  assert.equal(new Set(keys).size, keys.length, "the log holds each pair once");
  assert.equal(keys.length, 4, "only the first call's batch was played");
  // The lock is gone once the run is over: the next call is not blocked.
  assert.ok(!existsSync(path.join(dir, "round-0.lock")));
});

test("a log with a repeated line is replayed once per pair", async (t) => {
  const cleanDir = tempDir(t);
  const doubledDir = tempDir(t);
  const sides = makeSides(8);
  const opts = { sides, batchSize: 4, minMatches: 3 };
  const clean = await runRound(options({ ...opts, dir: cleanDir }));

  // Simulate a log two overlapping calls both appended to: every line twice.
  const file = path.join(cleanDir, "round-0.matches.jsonl");
  const [header, ...lines] = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
  writeFileSync(path.join(doubledDir, "round-0.matches.jsonl"), [header, ...lines, ...lines].join("\n") + "\n");

  const resumed = await runRound(options({ ...opts, dir: doubledDir }));
  assert.equal(resumed.complete, true);
  assert.deepEqual(resumed.played, clean.played, "a repeated line is not counted twice");
  assert.deepEqual(resumed.top, clean.top);
  assert.deepEqual(resumed.fit, clean.fit, "the fit sees each match once");
  const keys = resumed.matches.map((match) => pairKey(match.a, match.b));
  assert.equal(new Set(keys).size, keys.length, "the round result holds each pair once");
});

test("the log is fingerprinted: another seed or entrant set is refused", async (t) => {
  const dir = tempDir(t);
  const sides = makeSides(8);
  const opts = { dir, sides, batchSize: 4, minMatches: 3 };
  await runRound(options(opts));
  assert.match(headerLine(dir, 0), /"seed":7/);

  await assert.rejects(runRound(options({ ...opts, seed: 11 })), /seed 7, this call uses 11/);
  await assert.rejects(runRound(options({ ...opts, sides: sides.slice(0, 6) })), /different entrant set/);

  // The same configuration still resumes, and the header is not rewritten.
  const header = headerLine(dir, 0);
  const again = await runRound(options(opts));
  assert.equal(again.complete, true);
  assert.equal(headerLine(dir, 0), header);
  assert.equal(readFileSync(path.join(dir, "round-0.matches.jsonl"), "utf8").split("\n").filter((line) => line.startsWith("{\"header\"")).length, 1);
});

test("a headerless log is refused, not silently truncated", async (t) => {
  const dir = tempDir(t);
  const sides = makeSides(8);
  // An old-format (or damaged) log: one match, no header, and the last line has
  // no trailing newline. Cutting its tail would leave an empty file, which the
  // header writer would then happily re-fingerprint - a silent replay.
  const legacy = JSON.stringify({
    batch: 0,
    pair: ["p01", "p02"],
    match: {
      a: "p01",
      b: "p02",
      order1: { winner: null, reason: "" },
      order2: { winner: null, reason: "" },
      result: "draw",
    },
  });
  const file = path.join(dir, "round-0.matches.jsonl");
  writeFileSync(file, legacy);

  await assert.rejects(
    runRound(options({ dir, sides, batchSize: 4, minMatches: 3 })),
    /old-format or damaged log/,
  );
  assert.equal(readFileSync(file, "utf8"), legacy, "the log is left exactly as it was");
  assert.ok(!existsSync(path.join(dir, "round-0.json")), "and no round file was written");
});

test("a damaged line is an error unless it is the log's last line", async (t) => {
  const cleanDir = tempDir(t);
  const middleDir = tempDir(t);
  const tailDir = tempDir(t);
  const sides = makeSides(8);
  const opts = { sides, batchSize: 4, minMatches: 3 };
  const clean = await runRound(options({ ...opts, dir: cleanDir }));
  const text = readFileSync(path.join(cleanDir, "round-0.matches.jsonl"), "utf8");
  const [header, ...lines] = text.split("\n").filter((line) => line.trim() !== "");

  // A damaged line in the middle would silently lose a judged match, so it stops
  // the round and names the line instead.
  const damaged = [header, lines[0], "{ not a match record", ...lines.slice(1)];
  writeFileSync(path.join(middleDir, "round-0.matches.jsonl"), damaged.join("\n") + "\n");
  await assert.rejects(runRound(options({ ...opts, dir: middleDir })), /line 3 is not a match record/);

  // A damaged tail is where a crash writes, so it is cut rather than refused:
  // leaving it would glue the next record onto the fragment.
  const tailFile = path.join(tailDir, "round-0.matches.jsonl");
  writeFileSync(tailFile, `${text}torn tail\n`);
  const resumed = await runRound(options({ ...opts, dir: tailDir }));
  assert.equal(resumed.complete, true);
  assert.deepEqual(resumed.played, clean.played);
  assert.ok(!readFileSync(tailFile, "utf8").includes("torn tail"), "the damaged tail is removed, not just skipped");
});

test("forced pairs are played first, as batch -1, and recorded", async (t) => {
  const dir = tempDir(t);
  const sides = makeSides(6);
  const child = sides[0]!;
  const parent = sides[1]!;
  const result = await runRound(
    options({
      dir,
      round: 1,
      sides,
      // The same pair twice: a caller mapping child to parent can duplicate it.
      forced: [
        [child.id, parent.id],
        [child.id, parent.id],
      ],
      batchSize: 3,
      minMatches: 3,
    }),
  );

  const logged = readLog(dir, 1);
  assert.equal(logged[0]?.batch, -1, "forced matches come first");
  assert.deepEqual(logged[0]?.pair, [child.id, parent.id], "orientation is child then parent");
  assert.equal(logged[0]?.match.a, child.id);
  assert.equal(logged[0]?.match.b, parent.id);
  assert.equal(
    result.matches.filter((match) => pairKey(match.a, match.b) === pairKey(child.id, parent.id)).length,
    1,
    "a duplicated forced pair is judged once",
  );
  const written = JSON.parse(readFileSync(path.join(dir, "round-1.json"), "utf8"));
  assert.ok(written.matches.some((match: { a: string; b: string }) => match.a === child.id && match.b === parent.id));
  assert.equal(result.complete, true);
});

test("a zero budget stops after one batch and says the round is incomplete", async (t) => {
  const dir = tempDir(t);
  const sides = makeSides(10);
  const result = await runRound(options({ dir, sides, budgetMs: 0, batchSize: 4 }));

  assert.equal(result.complete, false);
  const logged = readLog(dir, 0);
  assert.ok(logged.length > 0, "one batch is still played");
  assert.ok(logged.length <= 4, `at most one batch of 4: ${logged.length}`);
  assert.equal(logged.every((line) => line.batch === 0), true, "no later batch was started");
  assert.ok(!existsSync(path.join(dir, "round-0.json")), "an incomplete round writes no round file");
});

test("loadEntrant reads the card and four pattern sections, never a review", (t) => {
  const run = tempDir(t);
  initRun(run, "data", "interest");
  const pattern = createChild(run, "D01", "Pattern One", "t");
  const puzzle = createChild(run, pattern.id, "Puzzle One", "t");

  mkdirSync(path.join(pattern.dir, "workspace"), { recursive: true });
  writeFileSync(
    path.join(pattern.dir, "workspace", "pattern.md"),
    [
      "# T01 — Pattern One",
      "",
      "## Measure",
      "E03: the share of pages that mention etiquette.",
      "",
      "## Result",
      "12 of 40 pages (30%).",
      "",
      "## Verdict",
      "held",
      "The predicted direction held in every slice.",
      "",
      "## Robustness",
      "ROBUSTNESS-MARKER: the same ordering holds at depth 2.",
      "",
      "## Worst fits",
      "- teamops/people-group.md",
      "",
      "## Deviations",
      "DEVIATIONS-MARKER: none",
      "",
    ].join("\n"),
  );
  mkdirSync(path.join(puzzle.dir, "workspace"), { recursive: true });
  writeFileSync(path.join(puzzle.dir, "workspace", "puzzle.md"), "## Pattern\nA card about etiquette.\n");
  mkdirSync(path.join(puzzle.dir, "workspace", "reviews"), { recursive: true });
  writeFileSync(
    path.join(puzzle.dir, "workspace", "reviews", "a.md"),
    "## Fit\nREVIEW-LEAK-MARKER: this review must never reach the judge.\n",
  );
  // The live run's merge carries both reviews' text in one file; a loader that
  // read the reviews folder would most likely read this one.
  writeFileSync(
    path.join(puzzle.dir, "workspace", "reviews", "merged.json"),
    JSON.stringify({ findings: [{ text: "MERGED-LEAK-MARKER: merged review text." }] }),
  );

  const side = loadEntrant(run, puzzle.id);
  assert.equal(side.id, puzzle.id);
  assert.match(side.card, /A card about etiquette/);
  for (const heading of ["## Measure", "## Result", "## Verdict", "## Worst fits"]) {
    assert.ok(side.evidence.includes(heading), `evidence carries ${heading}`);
  }
  assert.match(side.evidence, /12 of 40 pages/);
  assert.match(side.evidence, /teamops\/people-group\.md/);
  assert.ok(!side.evidence.includes("ROBUSTNESS-MARKER"), "only the four named sections are evidence");
  assert.ok(!side.evidence.includes("DEVIATIONS-MARKER"));
  const whole = JSON.stringify(side);
  assert.ok(!whole.includes("REVIEW-LEAK-MARKER"), "review text never reaches a Side");
  assert.ok(!whole.includes("MERGED-LEAK-MARKER"), "the merged review never reaches a Side either");
});

test("loadEntrant refuses a node that is not a puzzle and a puzzle with no card", (t) => {
  const run = tempDir(t);
  initRun(run, "data", "interest");
  const pattern = createChild(run, "D01", "Pattern One", "t");
  const puzzle = createChild(run, pattern.id, "Puzzle One", "t");

  mkdirSync(path.join(pattern.dir, "workspace"), { recursive: true });
  writeFileSync(path.join(pattern.dir, "workspace", "pattern.md"), "## Measure\nx\n");
  assert.throws(() => loadEntrant(run, pattern.id), /not a puzzle/);
  assert.throws(() => loadEntrant(run, puzzle.id), /puzzle\.md/);
});

test("loadEntrant refuses to judge on empty pattern evidence", (t) => {
  const run = tempDir(t);
  initRun(run, "data", "interest");
  const pattern = createChild(run, "D01", "Pattern One", "t");
  const puzzle = createChild(run, pattern.id, "Puzzle One", "t");
  mkdirSync(path.join(puzzle.dir, "workspace"), { recursive: true });
  writeFileSync(path.join(puzzle.dir, "workspace", "puzzle.md"), "## Pattern\nA card about etiquette.\n");

  // No pattern card at all: a wrong parent, not a puzzle with thin evidence.
  assert.throws(() => loadEntrant(run, puzzle.id), /has no workspace\/pattern\.md/);

  // A pattern card with none of the four sections the judge may see.
  mkdirSync(path.join(pattern.dir, "workspace"), { recursive: true });
  writeFileSync(
    path.join(pattern.dir, "workspace", "pattern.md"),
    "# T01 - Pattern One\n\n## Something else\nNothing the judge may read.\n",
  );
  assert.throws(() => loadEntrant(run, puzzle.id), /none of the sections/);
});

test("schedulePairs is deterministic and never repeats a seen pair", () => {
  const ids = Array.from({ length: 8 }, (_, index) => `p${index}`);
  const ratings: Record<string, number> = Object.fromEntries(ids.map((id, index) => [id, 1200 + index * 30]));
  const played: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  const seen = new Set<string>([pairKey("p0", "p1"), pairKey("p2", "p3")]);

  const first = schedulePairs({ ids, ratings, played, seen }, 0, 42, 6);
  const second = schedulePairs({ ids, ratings, played, seen }, 0, 42, 6);
  assert.deepEqual(first, second, "same state, batch and seed give the same pairs");
  assert.ok(first.length <= 6);
  assert.ok(first.length > 0);

  const keys = first.map(([a, b]) => pairKey(a, b));
  assert.equal(new Set(keys).size, keys.length, "no pair twice in one batch");
  for (const [a, b] of first) {
    assert.notEqual(a, b, "no entrant plays itself");
    assert.ok(!seen.has(pairKey(a, b)), `${a}/${b} was already seen`);
  }

  // A different batch draws a different set (the batch is part of the seed).
  const other = schedulePairs({ ids, ratings, played, seen }, 1, 42, 6);
  assert.notDeepEqual(other, first);

  // An exhausted pool yields nothing rather than repeating a pair.
  const all = new Set<string>();
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) all.add(pairKey(`q${i}`, `q${j}`));
  const qids = ["q0", "q1", "q2", "q3"];
  const empty = schedulePairs(
    {
      ids: qids,
      ratings: Object.fromEntries(qids.map((id) => [id, 1200])),
      played: Object.fromEntries(qids.map((id) => [id, 6])),
      seen: all,
    },
    0,
    1,
    8,
  );
  assert.deepEqual(empty, []);
});

test("schedulePairs sends the least-played entrant to its nearest rating first", () => {
  const ids = ["new", "near", "far", "x"];
  const ratings = { new: 1200, near: 1210, far: 1900, x: 900 };
  const played = { new: 0, near: 6, far: 6, x: 6 };
  const [firstPair] = schedulePairs({ ids, ratings, played, seen: new Set<string>() }, 0, 3, 4);
  assert.ok(firstPair, "a pair is scheduled");
  assert.ok(firstPair.includes("new"), `the newcomer is scheduled first: ${firstPair.join("/")}`);
  assert.ok(firstPair.includes("near"), `against its nearest rating, not the far one: ${firstPair.join("/")}`);
});

test("promotionCandidates finds the break between two separated groups", () => {
  const groups = { top: ["a1", "a2", "a3"], bottom: ["b1", "b2", "b3"] };
  const outcomes: Outcome[] = [];
  for (const a of groups.top) for (const b of groups.bottom) for (let i = 0; i < 3; i++) outcomes.push({ a, b, result: "a" });
  const fit = fitBradleyTerry(outcomes, { seed: 4, bootstrap: 100 });
  const played = Object.fromEntries([...groups.top, ...groups.bottom].map((id) => [id, 9]));

  const candidates = promotionCandidates(fit, played, 6);
  assert.equal(candidates.ranked.length, 6);
  assert.deepEqual(
    candidates.ranked.map((candidate) => candidate.id),
    [...groups.top, ...groups.bottom],
    "the ranking is the separated order",
  );
  assert.deepEqual(candidates.breaks, [3], "the gap sits after the third entrant");
  assert.deepEqual(candidates.underplayed, []);
  for (const candidate of candidates.ranked) {
    assert.equal(candidate.matches, 9);
    assert.ok(candidate.lower <= candidate.score && candidate.score <= candidate.upper);
  }
});

test("promotionCandidates finds no break in a uniform pool and lists underplayed ids", () => {
  const ids = ["u1", "u2", "u3", "u4", "u5", "u6"];
  const outcomes: Outcome[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      outcomes.push({ a: ids[i]!, b: ids[j]!, result: "a" });
      outcomes.push({ a: ids[i]!, b: ids[j]!, result: "b" });
    }
  }
  const fit: Fit = fitBradleyTerry(outcomes, { seed: 4, bootstrap: 100 });
  const played = { u1: 10, u2: 10, u3: 10, u4: 3, u5: 2, u6: 10 };

  const candidates = promotionCandidates(fit, played, 6);
  assert.deepEqual(candidates.breaks, [], "a pool of equals has no natural break");
  assert.deepEqual([...candidates.underplayed].sort(), ["u4", "u5"]);
  for (const candidate of candidates.ranked) assert.equal(candidate.matches, played[candidate.id as keyof typeof played]);
});
