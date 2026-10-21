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

/** A fake judge that always names the first card it is shown. */
const firstPosition: Transport = async () => JSON.stringify({ winner: 1, reason: "The first card looks stronger." });

/** A fake judge that reads the cards: it prefers whichever card is longer. */
const longerCard: Transport = async (prompt) => {
  const second = prompt.indexOf("## Puzzle 2");
  assert.ok(second > 0, "the prompt labels Puzzle 2");
  const winner = prompt.indexOf("LONG-CARD-MARKER") < second ? 1 : 2;
  return JSON.stringify({ winner, reason: "The longer card argues more." });
};

test("buildJudgePrompt carries both cards, both evidences and the criteria, but no ids or reviews", () => {
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
  assert.ok(prompt.includes(criteria.trim().slice(0, 200)), "the criteria file's text is quoted");

  assert.ok(!prompt.includes(SIDE_LONG.id), "the first id never reaches the judge");
  assert.ok(!prompt.includes(SIDE_SHORT.id), "the second id never reaches the judge");
  assert.ok(!/reviews/i.test(prompt), "no review text reaches the judge");

  assert.match(prompt, /do not reward/i);
  assert.match(prompt, /length/i);
  assert.match(prompt, /style/i);
  assert.match(prompt, /one JSON object/i);
  assert.match(prompt, /"winner"/);
  assert.match(prompt, /"reason"/);
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
