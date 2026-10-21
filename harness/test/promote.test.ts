// The gated `promote` tool and the two owner-tool refusals that keep promotion
// from being self-declared (design §9, §5.2).
//
// `promote` is the only way a puzzle leaves Phase 2. These tests pin every gate,
// one failing case each, in the order the tool checks them: a recorded STOP, the
// node being a submitted Phase 2 puzzle, a rank in the final round with at least
// six matches, a distinctness check that did not drop it, a merged review with no
// plausibility `fails` and no blocking flag, and a passing `check-puzzle`. A
// gate that is removed must let a test go red, so every case changes exactly one
// fact about a fixture that otherwise passes.
//
// The other half is the owner extension: `tree_create` refuses an evolution child
// after STOP (and fails closed on an unreadable record), and `tree_update` refuses
// a puzzle patched to `promoted` or out of its phase. The phase-1 owner's moves of
// pattern nodes are unaffected, and one test keeps that regression visible.
//
// The fixture is a real temp run: a phase-2 pattern in `input`, seven submitted
// puzzles with complete cards and real merged reviews, a recorded STOP, a final
// round file that ranks them, and a distinct.json that checked them all. The
// citation runner is injected so no test spawns `deepis`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import ownerExtension from "../owner-extension.ts";
import { createChild, findNode, initRun, updateNode } from "../tree.ts";
import { mergeReviews, parseReview } from "../tools/merge-reviews.ts";
import { appendRound, readStop } from "../tournament/stop.ts";
import { PROMOTE_CITATION_TIMEOUT_MS, promote, tournamentDir } from "../tournament/tools.ts";

/** The evidence sections `loadEntrant` reads from a pattern card. */
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

/** A complete puzzle card with a status-quo and an artifact reading, and no citations. */
function card(): string {
  return [
    "Lens: status quo — the theory nearest the violated expectation",
    "Round: 0",
    "",
    "## Pattern",
    "T01 measured 12 of 40 pages (30%), and the same ordering held at depth 2.",
    "",
    "## Violated expectation",
    "Smith (2001) expects etiquette rules to be stated; the pattern shows them carried by example.",
    "",
    "## A case of",
    "A case of translation: the rule is not stated but enacted.",
    "",
    "## Why it matters",
    "It speaks to the debate on how organisational rules travel.",
    "",
    "## Admissible explanations",
    "- The status-quo reading: existing theory already explains the share.",
    "- An artifact reading: the corpus's page form produced the count.",
    "",
    "## Limits",
    "This snapshot cannot show causality, and the worst fits are thin.",
    "",
    "## Literature log",
    "- deepis search 'etiquette rules'; 14 results; read 3 chunks.",
    "",
  ].join("\n");
}

/** A review in the fixed format the reviewers write (see merge-reviews.ts). */
function review(): string {
  return [
    "## Fit",
    "Rating: adequate",
    "It follows the card's numbers.",
    "",
    "## Plausibility",
    "Rating: adequate",
    "No rival account survives the search.",
    "",
    "## Relevance",
    "Rating: adequate",
    "It speaks to the etiquette debate.",
    "",
    "## Data-character check",
    "Result: ok",
    "No claim about behaviour is made.",
    "",
    "## Known-result check",
    "Result: not-applicable",
    "No Phase 0 caveat applies.",
    "",
    "## Findings",
    "None.",
    "",
    "## Phase 3 must check",
    "- whether the handbook's silence is a rule or an omission",
    "",
    "Status: DONE",
    "",
  ].join("\n");
}

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** The merged review a promotion needs clean: no plausibility `fails`, no flag set. */
const CLEAN_FLAGS = {
  breakdown: false,
  knownResultBlocking: false,
  dataCharacterViolated: false,
  reviewBlocked: false,
};

/** A card, two reviews and their real merge: a puzzle `check-puzzle --reviews` passes. */
function writePuzzleFiles(dir: string): void {
  write(path.join(dir, "workspace", "puzzle.md"), card());
  const a = review();
  const b = review();
  const reviews = path.join(dir, "workspace", "reviews");
  write(path.join(reviews, "a.md"), a);
  write(path.join(reviews, "b.md"), b);
  const parsedA = parseReview(a);
  const parsedB = parseReview(b);
  assert.ok(parsedA !== null && parsedB !== null, "the fixture reviews parse");
  write(path.join(reviews, "merged.json"), `${JSON.stringify(mergeReviews(parsedA, parsedB), null, 2)}\n`);
}

function writeMerged(nodeDir: string, merged: unknown): void {
  write(path.join(nodeDir, "workspace", "reviews", "merged.json"), `${JSON.stringify(merged, null, 2)}\n`);
}

/** Score `n` down from `count`, with a ±0.1 interval; every entrant played six matches. */
function writeRound(
  tournament: string,
  ids: string[],
  patch: { round?: number; scores?: Record<string, number>; played?: Record<string, number> } = {},
): void {
  const round = patch.round ?? 1;
  const scores = patch.scores ?? Object.fromEntries(ids.map((id, index) => [id, ids.length - index]));
  const interval = (offset: number): Record<string, number> =>
    Object.fromEntries(Object.entries(scores).map(([id, score]) => [id, score + offset]));
  const played = patch.played ?? Object.fromEntries(ids.map((id) => [id, 6]));
  write(
    path.join(tournament, `round-${round}.json`),
    `${JSON.stringify(
      { round, matches: [], fit: { scores, lower: interval(-0.1), upper: interval(0.1) }, top: ids, played },
      null,
      2,
    )}\n`,
  );
}

function writeDistinct(tournament: string, checked: string[], duplicates: { keep: string; drop: string }[] = []): void {
  write(path.join(tournament, "distinct.json"), `${JSON.stringify({ checked, duplicates }, null, 2)}\n`);
}

/** Record round 0 and a round 1 in which no child beat its parent: a STOP. */
function recordStop(tournament: string, ids: string[]): void {
  const file = path.join(tournament, "rounds.json");
  appendRound(file, { round: 0, top: ids, children: [] });
  appendRound(file, {
    round: 1,
    top: ids,
    children: [{ child: ids[1]!, parent: ids[0]!, beatParent: false }],
  });
}

/**
 * A hand-written round record for histories appendRound refuses once STOP is a
 * latch (it cannot record past round 1): the decisions are recomputed on read,
 * so round 1 still latches STOP and the later rounds are only round numbers.
 */
function writeRoundsRecord(tournament: string, rounds: number[]): void {
  const records = rounds.map((round) => ({
    summary: {
      round,
      top: ["P01", "P02", "P03"],
      children: round === 0 ? [] : [{ child: "P02", parent: "P01", beatParent: false }],
    },
    decision: { stop: false },
  }));
  write(path.join(tournament, "rounds.json"), `${JSON.stringify(records, null, 2)}\n`);
}

interface Fixture {
  run: string;
  /** The submitted puzzle ids, best score first. */
  ids: string[];
  tournament: string;
}

/**
 * A promotable run: a phase-2 pattern T01, seven submitted puzzles with complete
 * cards and merged reviews, a recorded STOP, a final round that ranks all seven
 * with six matches each, and a distinct.json that checked them.
 */
function promoteRun(t: TestContext, count = 7): Fixture {
  const run = mkdtempSync(path.join(tmpdir(), "ctc-promote-"));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  initRun(run, "data", "interest");
  createChild(run, "D01", "E03 Etiquette", "owner-p1");
  updateNode(run, "T01", { phase: 2, status: "input" }, "owner-p1");
  write(path.join(findNode(run, "T01").dir, "workspace", "pattern.md"), PATTERN);

  const ids: string[] = [];
  for (let index = 1; index <= count; index++) {
    const node = createChild(run, "T01", `Puzzle ${index}`, "owner-p2");
    writePuzzleFiles(node.dir);
    updateNode(run, node.id, { status: "submitted" }, "owner-p2");
    ids.push(node.id);
  }

  const tournament = tournamentDir(run);
  recordStop(tournament, ids);
  writeRound(tournament, ids);
  writeDistinct(tournament, ids);
  return { run, ids, tournament };
}

/** The injected citation runner: every fixture file passes. */
const NO_CITATIONS = { citations: (): string[] => [] };

function puzzleDir(run: string, id: string): string {
  return findNode(run, id).dir;
}

async function rejectMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("expected the call to be refused");
}

function commitCount(run: string): number {
  return Number(execFileSync("git", ["-C", run, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim());
}

// ---------------------------------------------------------------------------
// promote: one gate per test, in the order the tool checks them
// ---------------------------------------------------------------------------

test("promote succeeds when every gate holds and moves the puzzle to phase 3 ready", async (t) => {
  const fixture = promoteRun(t);
  const text = await promote(fixture.run, { nodeId: "P01", note: "the 0.4 gap at rank 1" }, NO_CITATIONS);

  assert.match(
    text,
    /^promoted P01 to phase 3 \(rank 1 of 7, score 7\.000, 80% interval \[6\.900, 7\.100\]\)/,
    text,
  );
  assert.match(text, /Ruling/, "the owner is reminded to record the promotion ruling");
  assert.match(text, /park/i, "and to park the puzzles it did not promote");

  const node = findNode(fixture.run, "P01");
  assert.equal(node.phase, 3);
  assert.equal(node.status, "ready");
  assert.equal(
    execFileSync("git", ["-C", fixture.run, "log", "-1", "--format=%an"], { encoding: "utf8" }).trim(),
    "owner-p2",
    "the promoting actor authors the commit",
  );
  assert.equal(
    execFileSync("git", ["-C", fixture.run, "log", "-1", "--format=%b"], { encoding: "utf8" }).trim(),
    "the 0.4 gap at rank 1",
    "the note is the commit body",
  );
});

test("promote refuses without a recorded STOP", async (t) => {
  const fixture = promoteRun(t);
  rmSync(path.join(fixture.tournament, "rounds.json"));
  assert.match(await rejectMessage(promote(fixture.run, { nodeId: "P01" }, NO_CITATIONS)), /^promote: no STOP recorded/);
  assert.equal(findNode(fixture.run, "P01").phase, 2, "nothing moved");
});

test("promote refuses a corrupt STOP record (fail closed)", async (t) => {
  const fixture = promoteRun(t);
  write(path.join(fixture.tournament, "rounds.json"), "{ not a record");
  assert.match(await rejectMessage(promote(fixture.run, { nodeId: "P01" }, NO_CITATIONS)), /^promote: STOP record unreadable: /);
});

test("promote refuses a node that is not a puzzle", async (t) => {
  const fixture = promoteRun(t);
  assert.match(await rejectMessage(promote(fixture.run, { nodeId: "T01" }, NO_CITATIONS)), /T01 is a pattern node, not a puzzle/);
  assert.match(await rejectMessage(promote(fixture.run, { nodeId: "P99" }, NO_CITATIONS)), /P99 is not a node in this run/);
});

test("promote refuses a puzzle that is not submitted", async (t) => {
  const fixture = promoteRun(t);
  updateNode(fixture.run, "P02", { status: "ready" }, "owner-p2");
  assert.match(await rejectMessage(promote(fixture.run, { nodeId: "P02" }, NO_CITATIONS)), /P02 is ready, not submitted/);
});

test("promote refuses a puzzle the final round does not rank", async (t) => {
  const fixture = promoteRun(t);
  writeRound(fixture.tournament, fixture.ids.slice(1), { round: 1 });
  assert.match(
    await rejectMessage(promote(fixture.run, { nodeId: "P01" }, NO_CITATIONS)),
    /P01 is not ranked in the final round \(round 1\)/,
  );
});

test("promote refuses when the highest round file is not recorded in rounds.json", async (t) => {
  const fixture = promoteRun(t);
  // The engine writes round-9.json before appendRound records it; a crash in
  // between leaves an orphan that is not a final round.
  writeRound(fixture.tournament, fixture.ids, { round: 9 });
  assert.match(
    await rejectMessage(promote(fixture.run, { nodeId: "P01" }, NO_CITATIONS)),
    /round 9 is on disk .* but not recorded in .*rounds\.json/,
  );
});

test("promote reads the highest RECORDED round numerically, so round 10 beats round 9", async (t) => {
  const fixture = promoteRun(t);
  writeRoundsRecord(fixture.tournament, [0, 1, 9, 10]);
  // Round 9 does not rank P01; round 10 does, with a distinctive score. A
  // lowest-file or lexicographic choice would not return round 10's score.
  writeRound(fixture.tournament, fixture.ids.slice(1), { round: 9 });
  const scores = Object.fromEntries(fixture.ids.map((id, index) => [id, index === 0 ? 9.5 : fixture.ids.length - index]));
  writeRound(fixture.tournament, fixture.ids, { round: 10, scores });

  const text = await promote(fixture.run, { nodeId: "P01" }, NO_CITATIONS);
  assert.match(text, /score 9\.500/, "round 10's fit is the one used");
  assert.match(text, /rank 1 of 7/);
});

test("promote refuses when the final round file is corrupt (fail closed)", async (t) => {
  const fixture = promoteRun(t);
  write(path.join(fixture.tournament, "round-1.json"), "{ not a round");
  assert.match(
    await rejectMessage(promote(fixture.run, { nodeId: "P01" }, NO_CITATIONS)),
    /promote: .*round-1\.json is not valid JSON/,
  );
});

test("promote refuses when there is no round file at all", async (t) => {
  const fixture = promoteRun(t);
  rmSync(path.join(fixture.tournament, "round-1.json"));
  assert.match(await rejectMessage(promote(fixture.run, { nodeId: "P01" }, NO_CITATIONS)), /no completed round/);
});

test("a plain puzzle created after STOP is never promotable: the final round does not rank it", async (t) => {
  const fixture = promoteRun(t);
  const plain = createChild(fixture.run, "T01", "plain puzzle", "owner-p2");
  writePuzzleFiles(plain.dir);
  updateNode(fixture.run, plain.id, { status: "submitted" }, "owner-p2");
  assert.match(
    await rejectMessage(promote(fixture.run, { nodeId: plain.id }, NO_CITATIONS)),
    new RegExp(`${plain.id} is not ranked in the final round \\(round 1\\)`),
  );
});

test("promote refuses a puzzle with fewer than six matches", async (t) => {
  const fixture = promoteRun(t);
  writeRound(fixture.tournament, fixture.ids, { played: { ...Object.fromEntries(fixture.ids.map((id) => [id, 6])), P01: 3 } });
  assert.match(
    await rejectMessage(promote(fixture.run, { nodeId: "P01" }, NO_CITATIONS)),
    /P01 played 3 matches in the final round, fewer than the 6/,
  );
});

test("promote refuses a puzzle with no distinctness record", async (t) => {
  const fixture = promoteRun(t);
  rmSync(path.join(fixture.tournament, "distinct.json"));
  assert.match(await rejectMessage(promote(fixture.run, { nodeId: "P01" }, NO_CITATIONS)), /P01 is not distinct-checked/);
});

test("promote refuses a corrupt distinctness record (fail closed)", async (t) => {
  const fixture = promoteRun(t);
  write(path.join(fixture.tournament, "distinct.json"), "{ not the record");
  assert.match(
    await rejectMessage(promote(fixture.run, { nodeId: "P01" }, NO_CITATIONS)),
    /promote: .*distinct\.json is not valid JSON/,
  );
});

test("promote refuses a puzzle the distinctness check did not list as checked", async (t) => {
  const fixture = promoteRun(t);
  writeDistinct(fixture.tournament, fixture.ids.filter((id) => id !== "P01"));
  assert.match(await rejectMessage(promote(fixture.run, { nodeId: "P01" }, NO_CITATIONS)), /P01 is not in .*checked list/);
});

test("promote refuses the drop of a confirmed duplicate", async (t) => {
  const fixture = promoteRun(t);
  writeDistinct(fixture.tournament, fixture.ids, [{ keep: "P02", drop: "P01" }]);
  assert.match(
    await rejectMessage(promote(fixture.run, { nodeId: "P01" }, NO_CITATIONS)),
    /P01 is the drop of a confirmed duplicate of P02/,
  );
});

test("promote refuses a merged review that rates plausibility fails", async (t) => {
  const fixture = promoteRun(t);
  writeMerged(puzzleDir(fixture.run, "P01"), {
    criteria: { plausibility: { rating: "fails", agreement: "agree" } },
    flags: CLEAN_FLAGS,
  });
  assert.match(
    await rejectMessage(promote(fixture.run, { nodeId: "P01" }, NO_CITATIONS)),
    /P01's merged review rates plausibility fails/,
  );
});

for (const flag of ["breakdown", "knownResultBlocking", "dataCharacterViolated", "reviewBlocked"]) {
  test(`promote refuses a merged review with ${flag} set`, async (t) => {
    const fixture = promoteRun(t);
    writeMerged(puzzleDir(fixture.run, "P01"), {
      criteria: { plausibility: { rating: "adequate", agreement: "agree" } },
      flags: { ...CLEAN_FLAGS, [flag]: true },
    });
    assert.match(
      await rejectMessage(promote(fixture.run, { nodeId: "P01" }, NO_CITATIONS)),
      new RegExp(`${flag}.*promotion needs it false|sets ${flag}`),
    );
  });
}

test("promote refuses a merged review with a missing flag (fail closed)", async (t) => {
  const fixture = promoteRun(t);
  const { reviewBlocked: _omitted, ...partial } = CLEAN_FLAGS;
  writeMerged(puzzleDir(fixture.run, "P01"), {
    criteria: { plausibility: { rating: "adequate", agreement: "agree" } },
    flags: partial,
  });
  assert.match(
    await rejectMessage(promote(fixture.run, { nodeId: "P01" }, NO_CITATIONS)),
    /no reviewBlocked flag \(fail closed\)/,
  );
});

test("promote refuses a puzzle that fails check-puzzle, naming the problem", async (t) => {
  const fixture = promoteRun(t);
  const citations = (file: string): string[] =>
    file.endsWith("puzzle.md") ? ["the quote '12 of 40' is not in the source"] : [];
  const message = await rejectMessage(promote(fixture.run, { nodeId: "P01" }, { citations }));
  assert.match(message, /P01 fails check-puzzle/);
  assert.match(message, /12 of 40/, "the check's own problem line is shown");
});

test("promote refuses a puzzle that is already in phase 3", async (t) => {
  const fixture = promoteRun(t);
  updateNode(fixture.run, "P01", { phase: 3, status: "ready" }, "owner-p2");
  assert.match(
    await rejectMessage(promote(fixture.run, { nodeId: "P01" }, NO_CITATIONS)),
    /P01 is already in phase 3/,
  );
});

test("promote's citation check has a 120 s per-file timeout, and the seam reaches it", async (t) => {
  const fixture = promoteRun(t);
  assert.equal(PROMOTE_CITATION_TIMEOUT_MS, 120_000, "the promotion path does not wait the default 15 minutes");
  // No fake citations: the real checker is spawned and cut off by the tiny seam
  // value, so a timed-out check is a refusal, not a fifteen-minute stall.
  const message = await rejectMessage(promote(fixture.run, { nodeId: "P01" }, { citationTimeoutMs: 10 }));
  assert.match(message, /fails check-puzzle/);
  assert.match(message, /timed out after 10 ms/);
  assert.equal(findNode(fixture.run, "P01").phase, 2, "a timed-out citation check refuses");
});

// ---------------------------------------------------------------------------
// tree_create: the evolution gate
// ---------------------------------------------------------------------------

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

/** Register the owner extension for a phase and return its tools. */
function captureTools(t: TestContext, runDir: string, phase: number): Map<string, CapturedTool> {
  const savedRun = process.env.CTC_RUN_DIR;
  const savedPhase = process.env.CTC_PHASE;
  process.env.CTC_RUN_DIR = runDir;
  process.env.CTC_PHASE = String(phase);
  t.after(() => {
    if (savedRun === undefined) delete process.env.CTC_RUN_DIR;
    else process.env.CTC_RUN_DIR = savedRun;
    if (savedPhase === undefined) delete process.env.CTC_PHASE;
    else process.env.CTC_PHASE = savedPhase;
  });
  const { pi, tools } = fakePi();
  ownerExtension(pi);
  return tools;
}

test("tree_create refuses an evolved puzzle after STOP with the exact message", async (t) => {
  const fixture = promoteRun(t);
  assert.deepEqual(readStop(path.join(fixture.tournament, "rounds.json")), {
    stop: true,
    reason: "no-child-beat-parent",
  });

  const create = captureTools(t, fixture.run, 2).get("tree_create");
  assert.ok(create);
  const before = commitCount(fixture.run);
  assert.equal(
    await rejectMessage(
      create.execute("call-1", { parentId: "T01", title: "grounding: crowd", derivedFrom: ["P01"] }),
    ),
    "STOP recorded (no-child-beat-parent): no more evolution",
    "the refusal is the exact design wording, with the reason",
  );
  assert.equal(commitCount(fixture.run), before, "a refused create makes no commit");

  const plain = await create.execute("call-2", { parentId: "T01", title: "plain puzzle" });
  assert.equal(plain.content[0]?.text, "created P08 puzzle 2 ready plain-puzzle");

  const phase1 = captureTools(t, fixture.run, 1).get("tree_create");
  assert.ok(phase1);
  const pattern = await phase1.execute("call-3", { parentId: "D01", title: "Another pattern" });
  assert.equal(pattern.content[0]?.text, "created T02 pattern 1 ready another-pattern");
});

test("tree_create is unaffected without a recorded STOP", async (t) => {
  const fixture = promoteRun(t);
  rmSync(path.join(fixture.tournament, "rounds.json"));

  const create = captureTools(t, fixture.run, 2).get("tree_create");
  assert.ok(create);
  const evolved = await create.execute("call-1", {
    parentId: "T01",
    title: "grounding: crowd",
    derivedFrom: ["P01"],
  });
  assert.equal(evolved.content[0]?.text, "created P08 puzzle 2 ready grounding-crowd");
  assert.deepEqual(findNode(fixture.run, "P08").derivedFrom, ["P01"]);
});

test("tree_create fails closed on an unreadable STOP record, for evolved puzzles only", async (t) => {
  const fixture = promoteRun(t);
  write(path.join(fixture.tournament, "rounds.json"), "{ not a record");

  const create = captureTools(t, fixture.run, 2).get("tree_create");
  assert.ok(create);
  assert.match(
    await rejectMessage(create.execute("call-1", { parentId: "T01", title: "grounding: again", derivedFrom: ["P01"] })),
    /^STOP record unreadable: /,
  );
  const plain = await create.execute("call-2", { parentId: "T01", title: "plain puzzle" });
  assert.equal(plain.content[0]?.text, "created P08 puzzle 2 ready plain-puzzle");
});

// ---------------------------------------------------------------------------
// tree_update: promotion is never self-declared
// ---------------------------------------------------------------------------

test("tree_update refuses a puzzle promoted by hand", async (t) => {
  const fixture = promoteRun(t);
  const update = captureTools(t, fixture.run, 2).get("tree_update");
  assert.ok(update);
  const before = commitCount(fixture.run);

  assert.equal(
    await rejectMessage(update.execute("call-1", { nodeId: "P01", status: "promoted", note: "shortcut" })),
    "use promote: puzzles reach Phase 3 only through the gated promote tool",
  );
  assert.match(
    await rejectMessage(update.execute("call-2", { nodeId: "P01", phase: 3, status: "ready" })),
    /^use promote: /,
  );
  assert.equal(commitCount(fixture.run), before, "a refused update makes no commit");
  assert.equal(findNode(fixture.run, "P01").phase, 2);
  assert.equal(findNode(fixture.run, "P01").status, "submitted");
});

test("tree_update still moves a puzzle through active, submitted and parked", async (t) => {
  const fixture = promoteRun(t);
  const update = captureTools(t, fixture.run, 2).get("tree_update");
  assert.ok(update);
  for (const status of ["active", "submitted", "parked"]) {
    const updated = await update.execute(`call-${status}`, { nodeId: "P02", status });
    assert.equal(updated.content[0]?.text, `updated P02 puzzle 2 ${status} puzzle-2`);
  }
});

test("a same-phase no-op patch on a puzzle is still allowed", async (t) => {
  const fixture = promoteRun(t);
  const update = captureTools(t, fixture.run, 2).get("tree_update");
  assert.ok(update);
  const same = await update.execute("call-1", { nodeId: "P02", phase: 2, status: "submitted" });
  assert.equal(same.content[0]?.text, "updated P02 puzzle 2 submitted puzzle-2");
  assert.equal(findNode(fixture.run, "P02").phase, 2);
});

test("the phase-1 owner still routes a pattern node into phase 2", async (t) => {
  const fixture = promoteRun(t);
  createChild(fixture.run, "D01", "E04 Remote", "owner-p1");
  const update = captureTools(t, fixture.run, 1).get("tree_update");
  assert.ok(update);
  const routed = await update.execute("call-1", { nodeId: "T02", phase: 2, status: "input", note: "route" });
  assert.equal(routed.content[0]?.text, "updated T02 pattern 2 input e04-remote");
  assert.equal(findNode(fixture.run, "T02").phase, 2);
});

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

test("promote is registered and enforces phase 2", async (t) => {
  const fixture = promoteRun(t);
  const tools = captureTools(t, fixture.run, 1);
  const promoteTool = tools.get("promote");
  assert.ok(promoteTool, "promote is registered");
  await assert.rejects(
    () => promoteTool.execute("call-1", { nodeId: "P01" }),
    /promote is a phase-2 tool and you own P1/,
  );

  process.env.CTC_PHASE = "2";
  // The phase gate passed and the module was reached: an unknown id is its refusal.
  await assert.rejects(() => promoteTool.execute("call-2", { nodeId: "P99" }), /P99 is not a node in this run/);
});
