// The judge is a plain model call with no tools, so everything it can know is
// in the prompt the engine builds: two anonymised cards, the Phase 1 evidence
// behind each, and the rubric. These tests pin the prompt's content (no ids, no
// reviews), the parser's tolerance of prose, and - the part that makes the
// ranking trustworthy - that the same match is judged in both orders. A judge
// that always names the first card must produce only draws, and a judge that
// follows the cards' content must name the same entrant whichever order it sees.
import assert from "node:assert/strict";
import test from "node:test";

import { loadCriteria } from "../tournament/criteria.ts";
import {
  buildJudgePrompt,
  judgeMatch,
  judgeSame,
  makeExecRunner,
  parseVerdict,
  piTransport,
  type Side,
  type Transport,
} from "../tournament/judge.ts";

const LONG_CARD = [
  "## Pattern",
  "Puzzles labelled with a recent timestamp are read as newer than puzzles labelled with an old one, in T13's counts.",
  "## Violated expectation",
  "The expectation (E07) says that labels carry no temporal signal; the pattern denies it.",
  "## A case of",
  "A case of indexical order being mistaken for semantic order.",
  "## Why it matters",
  "It changes what a label can warrant in a queueing debate.",
  "## Admissible explanations",
  "Status quo: existing queueing theory already explains it. Artifact: the corpus's timestamps were generated in lexicographic order.",
  "## Limits",
  "The snapshot cannot show whether readers noticed the order.",
  "## Literature log",
  "deepis \"label order\" - 4 chunks, 2 read with context.",
].join("\n\n");

const SHORT_CARD = "## Pattern\nA short card that says little.";

const SIDE_LONG: Side = {
  id: "pz-alpha-9371",
  card: `LONG-CARD-MARKER\n\n${LONG_CARD}`,
  evidence: "Result: labels with recent timestamps rank higher. Verdict: robust. Worst fits: two small cells.",
};

const SIDE_SHORT: Side = {
  id: "pz-beta-4022",
  card: SHORT_CARD,
  evidence: "Result: a thin regularity. Verdict: fragile. Worst fits: most cells.",
};

/** A card may legitimately mention another node's id; only `Side.id` is hidden. */
const SIDE_WITH_ID_IN_CARD: Side = {
  id: "pz-delta-0001",
  card: "## Pattern\nAn evolution child, derived from pz-gamma-9999, which stays in the card verbatim.",
  evidence: "Result: inherited from pz-gamma-9999.",
};

/** A fake judge that always names the first card it is shown. */
const firstPosition: Transport = async () => JSON.stringify({ winner: 1, reason: "The first card looks stronger." });

/** A fake judge that reads the cards: it prefers whichever card is longer. */
const longerCard: Transport = async (prompt) => {
  const second = prompt.indexOf("## Puzzle 2");
  assert.ok(second > 0, "the prompt labels Puzzle 2");
  const winner = prompt.indexOf("LONG-CARD-MARKER") < second ? 1 : 2;
  return JSON.stringify({ winner, reason: "The longer card argues more." });
};

test("buildJudgePrompt carries both cards, both evidences and the criteria, but no ids", () => {
  const prompt = buildJudgePrompt(SIDE_LONG, SIDE_SHORT);

  assert.match(prompt, /Puzzle 1/);
  assert.match(prompt, /Puzzle 2/);
  assert.ok(prompt.includes(SIDE_LONG.card), "first card is present");
  assert.ok(prompt.includes(SIDE_SHORT.card), "second card is present");
  assert.ok(prompt.includes(SIDE_LONG.evidence), "first evidence is present");
  assert.ok(prompt.includes(SIDE_SHORT.evidence), "second evidence is present");

  const criteria = loadCriteria();
  for (const heading of ["## Fit", "## Plausibility", "## Relevance"]) {
    assert.ok(prompt.includes(heading), `criteria heading ${heading} is quoted`);
  }
  assert.ok(prompt.includes(criteria), "the criteria file's whole text is quoted");

  assert.ok(!prompt.includes(SIDE_LONG.id), "the first id never reaches the judge");
  assert.ok(!prompt.includes(SIDE_SHORT.id), "the second id never reaches the judge");

  // Review text cannot leak structurally: buildJudgePrompt takes no review
  // argument, so there is no review marker to assert against here.

  assert.ok(prompt.includes("Do not reward length, verbosity or style"), "the no-length/style instruction is present");
  assert.match(prompt, /one JSON object/i);
  assert.match(prompt, /"winner"/);
  assert.match(prompt, /"reason"/);
});

test("buildJudgePrompt interpolates cards verbatim and never the Side.id field", () => {
  const prompt = buildJudgePrompt(SIDE_WITH_ID_IN_CARD, SIDE_SHORT);

  // The id *field* is never read by the builder. A card that mentions a node id
  // is content: stripping it would mangle the puzzle, so it passes through.
  assert.ok(!prompt.includes("pz-delta-0001"), "the Side.id field is never interpolated");
  assert.ok(prompt.includes("pz-gamma-9999"), "an id-looking string inside a card survives verbatim");
  assert.ok(prompt.includes(SIDE_WITH_ID_IN_CARD.card), "the card itself is unmodified");
});

test("parseVerdict reads the first JSON object in free text", () => {
  assert.deepEqual(parseVerdict('Here is my call: {"winner": 2, "reason": "Stronger fit."} - hope that helps.'), {
    winner: 2,
    reason: "Stronger fit.",
  });

  assert.deepEqual(parseVerdict('The criteria {fit, plausibility} are close, but {"winner": 1, "reason": "Plausible."} wins.'), {
    winner: 1,
    reason: "Plausible.",
  });

  assert.deepEqual(parseVerdict('```json\n{"winner": 0, "reason": "Neither is stronger."}\n```'), {
    winner: 0,
    reason: "Neither is stronger.",
  });
});

test("parseVerdict returns null for prose with no object and for malformed verdicts", () => {
  assert.equal(parseVerdict("I cannot decide between these two."), null);
  assert.equal(parseVerdict('{"winner": 3, "reason": "out of range"}'), null);
  assert.equal(parseVerdict('{"verdict": 1, "reason": "wrong key"}'), null);
  assert.equal(parseVerdict('{"winner": "1", "reason": "wrong type"}'), null);
  assert.equal(parseVerdict("{not json at all}"), null);
});

test("a judge that always names the first card yields a draw for every match", async () => {
  for (const [a, b] of [
    [SIDE_LONG, SIDE_SHORT],
    [SIDE_SHORT, SIDE_LONG],
    [SIDE_LONG, SIDE_LONG],
  ] as const) {
    const record = await judgeMatch(a, b, firstPosition);
    assert.equal(record.result, "draw", `always-first is a split, not a win: ${a.id} vs ${b.id}`);
    assert.notEqual(record.order1.winner, null);
    assert.notEqual(record.order2.winner, null);
  }
});

test("a judge that always names no winner yields null in both orders and a draw", async () => {
  const noWinner: Transport = async () => JSON.stringify({ winner: 0, reason: "Neither." });
  const record = await judgeMatch(SIDE_LONG, SIDE_SHORT, noWinner);
  assert.equal(record.order1.winner, null, "winner 0 is no winner in order 1");
  assert.equal(record.order2.winner, null, "winner 0 is no winner in order 2");
  assert.equal(record.order1.reason, "Neither.");
  assert.equal(record.order2.reason, "Neither.");
  assert.equal(record.result, "draw");
});

test("a split between a named winner and no winner is a draw", async () => {
  const answers = ['{"winner": 1, "reason": "Puzzle 1 fits."}', '{"winner": 0, "reason": "But not under the swap."}'];
  let calls = 0;
  const split: Transport = async () => answers[calls++] ?? '{"winner": 0, "reason": "Neither."}';

  const record = await judgeMatch(SIDE_LONG, SIDE_SHORT, split);
  assert.equal(calls, 2);
  assert.equal(record.order1.winner, "a");
  assert.equal(record.order2.winner, null);
  assert.equal(record.result, "draw", "a named winner plus a no-winner is not a win");
});

test("a content-following judge picks the same entrant in both orders", async () => {
  const aFirst = await judgeMatch(SIDE_LONG, SIDE_SHORT, longerCard);
  assert.equal(aFirst.a, SIDE_LONG.id);
  assert.equal(aFirst.b, SIDE_SHORT.id);
  assert.equal(aFirst.order1.winner, "a");
  assert.equal(aFirst.order2.winner, "a");
  assert.equal(aFirst.result, "a");

  const bFirst = await judgeMatch(SIDE_SHORT, SIDE_LONG, longerCard);
  assert.equal(bFirst.order1.winner, "b");
  assert.equal(bFirst.order2.winner, "b");
  assert.equal(bFirst.result, "b");
});

test("an unparseable answer is retried once per order, then counts as no winner", async () => {
  let calls = 0;
  const garbage: Transport = async () => {
    calls++;
    return "No JSON for you.";
  };

  const record = await judgeMatch(SIDE_LONG, SIDE_SHORT, garbage);
  assert.equal(calls, 4, "two orders, each tried twice");
  assert.equal(record.order1.winner, null);
  assert.equal(record.order2.winner, null);
  assert.equal(record.result, "draw");
  assert.match(record.order1.reason, /unparseable/i);
});

test("a retry that parses is used", async () => {
  const answers = ["Nope.", '{"winner": 1, "reason": "Retried fit."}', "Nope.", '{"winner": 2, "reason": "Retried plausibility."}'];
  let calls = 0;
  const flaky: Transport = async () => answers[calls++] ?? "Nope.";

  const record = await judgeMatch(SIDE_LONG, SIDE_SHORT, flaky);
  assert.equal(calls, 4);
  assert.equal(record.order1.winner, "a");
  assert.equal(record.order1.reason, "Retried fit.");
  assert.equal(record.order2.winner, "a", "order 2 names Puzzle 2, which is entrant a");
  assert.equal(record.result, "a");
});

test("judgeSame is true only when both orders call the cards the same puzzle", async () => {
  const alwaysSame: Transport = async () => JSON.stringify({ same: true, reason: "Same reading." });
  const agreed = await judgeSame(SIDE_LONG, SIDE_SHORT, alwaysSame);
  assert.equal(agreed.same, true);
  assert.deepEqual(agreed.reasons, ["Same reading.", "Same reading."]);

  // Says yes when the marked card is Puzzle 1, no when it is Puzzle 2.
  const split: Transport = async (prompt) => {
    const marker = prompt.indexOf("LONG-CARD-MARKER");
    const second = prompt.indexOf("## Puzzle 2");
    return JSON.stringify({ same: marker < second, reason: "Only one order agrees." });
  };
  const divided = await judgeSame(SIDE_LONG, SIDE_SHORT, split);
  assert.equal(divided.same, false);
  assert.equal(divided.reasons.length, 2);

  const alwaysDifferent: Transport = async () => JSON.stringify({ same: false, reason: "Different readings." });
  assert.equal((await judgeSame(SIDE_LONG, SIDE_SHORT, alwaysDifferent)).same, false);
});

test("piTransport runs pi with the fixed no-tools flags and the prompt", async () => {
  let seen: string[] | undefined;
  const transport = piTransport("test/judge-model", async (args) => {
    seen = args;
    return '{"winner": 1, "reason": "ok"}';
  });

  const output = await transport("THE PROMPT");
  assert.deepEqual(seen, [
    "-p",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--model",
    "test/judge-model",
    "THE PROMPT",
  ]);
  assert.equal(output, '{"winner": 1, "reason": "ok"}');
});

test("makeExecRunner closes the child's stdin so a stdin-reading command cannot hang", { timeout: 5000 }, async () => {
  const run = makeExecRunner("/bin/sh", { timeoutMs: 3000 });
  const started = Date.now();

  // `cat` reads until EOF. With stdin left open this would wait for the child's
  // three-second timeout, so the test fails within ~3 s and the file exits
  // quickly instead of hanging until the production five-minute timeout.
  const output = await run(["-c", "cat >/dev/null; echo ok"]);

  assert.equal(output.trim(), "ok");
  assert.ok(Date.now() - started < 1000, "the call returned within a second");
});

test("makeExecRunner survives an early-exiting child when stdin is fed", async () => {
  const run = makeExecRunner("/bin/sh");

  // `exit 0` never drains the pipe. Writing `abc` can emit EPIPE on stdin; the
  // runner must settle (resolve or reject), not crash the process with an
  // uncaught 'error' event.
  const outcome = await run(["-c", "exit 0"], "abc").then(
    (value) => ({ settled: true, value }),
    (error: Error) => ({ settled: true, value: error }),
  );
  assert.ok(outcome.settled, "the call settled without an uncaught stdin error");
});

test("makeExecRunner rejects with the stderr text on a non-zero exit", async () => {
  const run = makeExecRunner("/bin/sh");

  await assert.rejects(run(["-c", "echo 'judge exploded' >&2; exit 3"]), (error: Error) => {
    assert.match(error.message, /judge exploded/);
    return true;
  });
});
