// The two reviewers write free-form prose in a fixed shell, and the merge is
// mechanical: the owner reads only `merged.md`, so the rating arithmetic, the
// flags and the reviewer tags have to be right without a human in the middle.
// These tests pin the review format (strict: a review that does not parse is
// named, with the offending line), the severity ordering, the flags, the
// finding match that decides "high confidence", and the CLI's contract
// (`ok` exit 0; one problem per line exit 1; usage exit 2).
//
// The matching rule: two findings are the same when they carry the same
// criterion and the same severity and their normalised word sets overlap
// (Jaccard >= 0.5, stop words removed). It is deliberately conservative — an
// unmatched pair stays two single-reviewer findings, which understates
// agreement rather than inventing it.
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { mergeReviews, parseReview, reviewProblems, type Review } from "../tools/merge-reviews.ts";

const MERGE_REVIEWS = fileURLToPath(new URL("../tools/merge-reviews.ts", import.meta.url));

interface ReviewOptions {
  fit?: string;
  plausibility?: string;
  relevance?: string;
  dataCharacter?: string;
  knownResult?: string;
  /** Whole finding lines, e.g. `- [major] fit: the card's worst fits go unanswered`. */
  findings?: string[];
  phase3?: string[];
  status?: string;
}

/** A review in the fixed format; every field has a valid default. */
function review(opts: ReviewOptions = {}): string {
  return [
    "## Fit",
    `Rating: ${opts.fit ?? "adequate"}`,
    "It follows the card's numbers and answers the worst fits.",
    "",
    "## Plausibility",
    `Rating: ${opts.plausibility ?? "adequate"}`,
    "No rival account survives the literature search.",
    "",
    "## Relevance",
    `Rating: ${opts.relevance ?? "adequate"}`,
    "It speaks to the etiquette debate.",
    "",
    "## Data-character check",
    `Result: ${opts.dataCharacter ?? "ok"}`,
    "No claim about behaviour is made.",
    "",
    "## Known-result check",
    `Result: ${opts.knownResult ?? "not-applicable"}`,
    "No Phase 0 caveat applies.",
    "",
    "## Findings",
    ...(opts.findings ?? []),
    "",
    "## Phase 3 must check",
    ...(opts.phase3 ?? ["- whether the handbook's silence is a rule or an omission"]),
    "",
    `Status: ${opts.status ?? "DONE"}`,
    "",
  ].join("\n");
}

function mustParse(markdown: string): Review {
  const parsed = parseReview(markdown);
  assert.notEqual(parsed, null, `the review parses: ${reviewProblems(markdown).join("; ")}`);
  return parsed as Review;
}

/** A puzzle node folder with `workspace/reviews/` and the two reviews. */
function puzzleNode(t: import("node:test").TestContext, a: string | undefined, b: string | undefined): string {
  const nodeDir = mkdtempSync(path.join(tmpdir(), "ctc-merge-reviews-"));
  t.after(() => rmSync(nodeDir, { recursive: true, force: true }));
  mkdirSync(path.join(nodeDir, "workspace", "reviews"), { recursive: true });
  if (a !== undefined) writeFileSync(path.join(nodeDir, "workspace", "reviews", "a.md"), a);
  if (b !== undefined) writeFileSync(path.join(nodeDir, "workspace", "reviews", "b.md"), b);
  return nodeDir;
}

test("equal ratings on every criterion agree", () => {
  const merged = mergeReviews(
    mustParse(review({ fit: "adequate", plausibility: "weak", relevance: "strong" })),
    mustParse(review({ fit: "adequate", plausibility: "weak", relevance: "strong" })),
  );
  assert.deepEqual(merged.criteria, {
    fit: { rating: "adequate", agreement: "agree" },
    plausibility: { rating: "weak", agreement: "agree" },
    relevance: { rating: "strong", agreement: "agree" },
  });
  assert.deepEqual(merged.flags, {
    breakdown: false,
    knownResultBlocking: false,
    dataCharacterViolated: false,
    reviewBlocked: false,
  });
  assert.deepEqual(merged.status, { a: "DONE", b: "DONE" });
  assert.deepEqual(merged.phase3, ["whether the handbook's silence is a rule or an omission"]);
});

test("the more severe rating wins, and disagreement is split", () => {
  const both = [
    ["strong", "adequate", "adequate"],
    ["strong", "weak", "weak"],
    ["strong", "fails", "fails"],
    ["weak", "adequate", "weak"],
  ] as const;
  for (const [one, other, expected] of both) {
    for (const [x, y] of [
      [one, other],
      [other, one],
    ] as const) {
      const merged = mergeReviews(mustParse(review({ fit: x })), mustParse(review({ fit: y })));
      assert.deepEqual(merged.criteria.fit, { rating: expected, agreement: "split" }, `${x} vs ${y}`);
    }
  }

  const weakStrong = mergeReviews(mustParse(review({ fit: "weak" })), mustParse(review({ fit: "strong" })));
  assert.equal(weakStrong.criteria.fit.rating, "weak");
  assert.equal(weakStrong.criteria.fit.agreement, "split");
});

test("a plausibility fails in either review is a breakdown", () => {
  for (const [a, b] of [
    [{ plausibility: "fails" }, {}],
    [{}, { plausibility: "fails" }],
  ] as const) {
    const merged = mergeReviews(mustParse(review(a)), mustParse(review(b)));
    assert.equal(merged.flags.breakdown, true, JSON.stringify(a));
    assert.equal(merged.criteria.plausibility.rating, "fails");
  }
  assert.equal(mergeReviews(mustParse(review()), mustParse(review({ plausibility: "weak" }))).flags.breakdown, false);
});

test("a blocking known-result check in either review blocks", () => {
  assert.equal(
    mergeReviews(mustParse(review({ knownResult: "blocking" })), mustParse(review())).flags.knownResultBlocking,
    true,
  );
  assert.equal(
    mergeReviews(mustParse(review()), mustParse(review({ knownResult: "blocking" }))).flags.knownResultBlocking,
    true,
  );
  assert.equal(mergeReviews(mustParse(review()), mustParse(review())).flags.knownResultBlocking, false);
});

test("a data-character violation in either review is flagged", () => {
  assert.equal(
    mergeReviews(mustParse(review({ dataCharacter: "violated" })), mustParse(review())).flags.dataCharacterViolated,
    true,
  );
  assert.equal(
    mergeReviews(mustParse(review()), mustParse(review({ dataCharacter: "violated" }))).flags.dataCharacterViolated,
    true,
  );
  assert.equal(mergeReviews(mustParse(review()), mustParse(review())).flags.dataCharacterViolated, false);
});

test("a finding only one reviewer raises keeps its reviewer tag", () => {
  const onlyA = "- [major] fit: the card's worst fits go unanswered";
  const onlyB = "- [minor] relevance: the debate it enters is not named";
  const merged = mergeReviews(
    mustParse(review({ findings: [onlyA] })),
    mustParse(review({ findings: [onlyB] })),
  );
  assert.equal(merged.findings.length, 2, JSON.stringify(merged.findings));
  const byText = new Map(merged.findings.map((finding) => [finding.text, finding]));
  assert.deepEqual(byText.get("the card's worst fits go unanswered"), {
    reviewer: "a",
    severity: "major",
    criterion: "fit",
    text: "the card's worst fits go unanswered",
    confidence: "single-reviewer",
  });
  assert.deepEqual(byText.get("the debate it enters is not named"), {
    reviewer: "b",
    severity: "minor",
    criterion: "relevance",
    text: "the debate it enters is not named",
    confidence: "single-reviewer",
  });
});

test("a finding both reviewers raise appears once, at high confidence", () => {
  const a = "- [blocking] plausibility: existing theory already explains the pattern";
  const b = "- [blocking] plausibility: existing theory already explains the pattern, so it is a restatement";
  const merged = mergeReviews(mustParse(review({ findings: [a] })), mustParse(review({ findings: [b] })));
  assert.equal(merged.findings.length, 1, JSON.stringify(merged.findings));
  assert.deepEqual(merged.findings[0], {
    reviewer: "both",
    severity: "blocking",
    criterion: "plausibility",
    text: "existing theory already explains the pattern",
    confidence: "high",
  });
});

test("the same words under another criterion or severity stay two findings", () => {
  const text = "the card overstates what the handbook can show";
  for (const [x, y] of [
    [`- [major] fit: ${text}`, `- [major] relevance: ${text}`],
    [`- [major] fit: ${text}`, `- [minor] fit: ${text}`],
  ] as const) {
    const merged = mergeReviews(
      mustParse(review({ findings: [x] })),
      mustParse(review({ findings: [y] })),
    );
    assert.equal(merged.findings.length, 2, `${x} / ${y}`);
    assert.ok(merged.findings.every((finding) => finding.confidence === "single-reviewer"));
  }
});

test("unrelated texts under the same criterion and severity stay two findings", () => {
  const merged = mergeReviews(
    mustParse(review({ findings: ["- [major] fit: the worst fits are never discussed"] })),
    mustParse(review({ findings: ["- [major] fit: the citation to the rival is the wrong chunk"] })),
  );
  assert.equal(merged.findings.length, 2, JSON.stringify(merged.findings));
  assert.ok(merged.findings.every((finding) => finding.confidence === "single-reviewer"));
});

test("findings are listed most severe first, and a repeated one pairs once", () => {
  const shared = "- [major] fit: the negative case is not confronted";
  const merged = mergeReviews(
    mustParse(review({ findings: ["- [minor] relevance: the debate is unnamed", shared] })),
    mustParse(review({ findings: [shared, "- [blocking] data-character: the card claims what bots did"] })),
  );
  assert.deepEqual(
    merged.findings.map((finding) => `${finding.severity}:${finding.confidence}`),
    ["blocking:single-reviewer", "major:high", "minor:single-reviewer"],
  );
});

test("parseReview reads a well-formed review", () => {
  const parsed = mustParse(
    review({
      fit: "weak",
      plausibility: "fails",
      relevance: "adequate",
      dataCharacter: "violated",
      knownResult: "blocking",
      findings: ["- [blocking] known-result: presents the known failure as a discovery"],
      phase3: ["- whether the silence is prescriptive", "- whether one section accounts for the counts"],
      status: "DONE_WITH_CONCERNS",
    }),
  );
  assert.deepEqual(parsed.criteria, { fit: "weak", plausibility: "fails", relevance: "adequate" });
  assert.equal(parsed.dataCharacter, "violated");
  assert.equal(parsed.knownResult, "blocking");
  assert.deepEqual(parsed.findings, [
    {
      severity: "blocking",
      criterion: "known-result",
      text: "presents the known failure as a discovery",
    },
  ]);
  assert.deepEqual(parsed.phase3MustCheck, [
    "whether the silence is prescriptive",
    "whether one section accounts for the counts",
  ]);
  assert.equal(parsed.status, "DONE_WITH_CONCERNS");
});

test("a review with no findings and no phase-3 questions still parses", () => {
  const parsed = mustParse(review({ findings: [], phase3: [] }));
  assert.deepEqual(parsed.findings, []);
  assert.deepEqual(parsed.phase3MustCheck, []);
});

test("a missing heading makes the review malformed, and the heading is named", () => {
  for (const heading of [
    "## Fit",
    "## Plausibility",
    "## Relevance",
    "## Data-character check",
    "## Known-result check",
    "## Findings",
    "## Phase 3 must check",
  ]) {
    const broken = review().replace(`${heading}\n`, "");
    assert.equal(parseReview(broken), null, heading);
    const problems = reviewProblems(broken);
    assert.ok(
      problems.some((problem) => problem.includes(`lacks the heading "${heading}"`)),
      `${heading}: ${problems.join("; ")}`,
    );
  }
});

test("a last line that is not a Status makes the review malformed", () => {
  const missing = review().trimEnd().split("\n").slice(0, -1).join("\n");
  assert.equal(parseReview(missing), null);
  assert.ok(reviewProblems(missing).some((problem) => /last line is not a Status: line/.test(problem)));

  const invalid = review({ status: "MAYBE" });
  assert.equal(parseReview(invalid), null);
  assert.ok(reviewProblems(invalid).some((problem) => /invalid status "MAYBE"/.test(problem)));

  const notLast = review().replace("Status: DONE\n", "Status: DONE\n\nAnd a closing remark.\n");
  assert.equal(parseReview(notLast), null);
  assert.ok(reviewProblems(notLast).some((problem) => /last line is not a Status: line/.test(problem)));
});

test("an invalid rating or check value makes the review malformed", () => {
  const badRating = review({ fit: "brilliant" });
  assert.equal(parseReview(badRating), null);
  assert.ok(
    reviewProblems(badRating).some((problem) => /## Fit.*invalid rating "brilliant"/.test(problem)),
    reviewProblems(badRating).join("; "),
  );

  const badData = review({ dataCharacter: "fine" });
  assert.equal(parseReview(badData), null);
  assert.ok(reviewProblems(badData).some((problem) => /## Data-character check.*invalid result "fine"/.test(problem)));

  const badKnown = review({ knownResult: "violated" });
  assert.equal(parseReview(badKnown), null);
  assert.ok(
    reviewProblems(badKnown).some((problem) => /## Known-result check.*invalid result "violated"/.test(problem)),
  );
});

test("a section whose first line is not its Rating/Result line is malformed", () => {
  const bad = review().replace("Rating: adequate\nIt follows", "It follows");
  assert.equal(parseReview(bad), null);
  assert.ok(
    reviewProblems(bad).some((problem) => /## Fit line 2 is not a "Rating: <value>" line/.test(problem)),
    reviewProblems(bad).join("; "),
  );
});

test("a malformed finding line makes the review malformed, and the line is named", () => {
  for (const line of [
    "- the worst fits are never discussed",
    "- [serious] fit: the worst fits are never discussed",
    "- [major] style: the worst fits are never discussed",
    "- [major] fit",
  ]) {
    const broken = review({ findings: [line] });
    assert.equal(parseReview(broken), null, line);
    const problems = reviewProblems(broken);
    assert.ok(
      problems.some((problem) => problem.includes("## Findings") && problem.includes(JSON.stringify(line))),
      `${line}: ${problems.join("; ")}`,
    );
  }
});

test("a Phase 3 line that is not a list item is malformed", () => {
  const broken = review({ phase3: ["whether the silence is prescriptive"] });
  assert.equal(parseReview(broken), null);
  assert.ok(
    reviewProblems(broken).some(
      (problem) => problem.includes("## Phase 3 must check") && problem.includes("not a list item"),
    ),
    reviewProblems(broken).join("; "),
  );
});

test("the CLI writes merged.json and merged.md beside the reviews and prints ok", (t) => {
  const nodeDir = puzzleNode(
    t,
    review({ fit: "weak", findings: ["- [major] fit: the worst fits are never discussed"] }),
    review({
      fit: "strong",
      plausibility: "fails",
      knownResult: "blocking",
      findings: ["- [major] fit: the worst fits are never discussed"],
    }),
  );

  const result = spawnSync(process.execPath, [MERGE_REVIEWS, nodeDir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(result.stdout.trim().split("\n"), ["ok"]);

  const mergedFile = path.join(nodeDir, "workspace", "reviews", "merged.json");
  const mergedMarkdown = path.join(nodeDir, "workspace", "reviews", "merged.md");
  assert.ok(existsSync(mergedFile), "merged.json is written");
  assert.ok(existsSync(mergedMarkdown), "merged.md is written");

  const merged = JSON.parse(readFileSync(mergedFile, "utf8")) as ReturnType<typeof mergeReviews>;
  assert.deepEqual(
    merged,
    mergeReviews(
      mustParse(readFileSync(path.join(nodeDir, "workspace", "reviews", "a.md"), "utf8")),
      mustParse(readFileSync(path.join(nodeDir, "workspace", "reviews", "b.md"), "utf8")),
    ),
    "merged.json is exactly mergeReviews of the two reviews",
  );
  assert.deepEqual(merged.criteria.fit, { rating: "weak", agreement: "split" });
  assert.deepEqual(merged.flags, {
    breakdown: true,
    knownResultBlocking: true,
    dataCharacterViolated: false,
    reviewBlocked: false,
  });
  assert.equal(merged.findings.length, 1);
  assert.equal(merged.findings[0]?.confidence, "high");

  const markdown = readFileSync(mergedMarkdown, "utf8");
  assert.match(markdown, /fit/);
  assert.match(markdown, /weak/);
  assert.match(markdown, /split/);
  assert.match(markdown, /high confidence/);
  assert.match(markdown, /breakdown/);
});

test("the CLI names the file when a review is malformed and exits 1", (t) => {
  const nodeDir = puzzleNode(t, review({ fit: "brilliant" }), review());
  const result = spawnSync(process.execPath, [MERGE_REVIEWS, nodeDir], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, result.stdout);
  assert.match(lines[0] ?? "", /workspace\/reviews\/a\.md/);
  assert.match(lines[0] ?? "", /invalid rating "brilliant"/);
  assert.equal(existsSync(path.join(nodeDir, "workspace", "reviews", "merged.json")), false);
});

test("the CLI reports a missing review by name and exits 1", (t) => {
  const nodeDir = puzzleNode(t, review(), undefined);
  const result = spawnSync(process.execPath, [MERGE_REVIEWS, nodeDir], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout.trim(), "workspace/reviews/b.md is missing");
  assert.equal(existsSync(path.join(nodeDir, "workspace", "reviews", "merged.md")), false);
});


test("opposite polarity findings are not matched", () => {
  const merged = mergeReviews(
    mustParse(review({ findings: ["- [major] fit: the claim is supported"] })),
    mustParse(review({ findings: ["- [major] fit: the claim is not supported"] })),
  );
  assert.equal(merged.findings.length, 2, JSON.stringify(merged.findings));
  assert.ok(merged.findings.every((finding) => finding.confidence === "single-reviewer"));
});

test("emphasis and case around Rating/Result/Status values do not break the parse", () => {
  const variant = review()
    .replace("Rating: adequate", "**Rating:** _ADEQUATE_")
    .replace("Result: ok", "result: **OK**")
    .replace("Result: not-applicable", "RESULT: __not-applicable__")
    .replace("Status: DONE", "status: **done**");
  const parsed = mustParse(variant);
  assert.deepEqual(parsed.criteria, { fit: "adequate", plausibility: "adequate", relevance: "adequate" });
  assert.equal(parsed.dataCharacter, "ok");
  assert.equal(parsed.knownResult, "not-applicable");
  assert.equal(parsed.status, "DONE");
});

test("finding bullets, emphasis and case are accepted", () => {
  const parsed = mustParse(
    review({
      findings: [
        "- [major] fit: the worst fits go unanswered",
        "* [minor] relevance: the debate is unnamed",
        "+ [blocking] plausibility: existing theory already explains it",
        "1. [major] data-character: the card claims what bots did",
        "2) [minor] known-result: the caveat is ignored",
        "- **[major] fit:** the negative case is not confronted",
        "- __[MAJOR]__ __Fit__: the rival is not named",
      ],
    }),
  );
  assert.deepEqual(
    parsed.findings.map((finding) => `${finding.severity}|${finding.criterion}|${finding.text}`),
    [
      "major|fit|the worst fits go unanswered",
      "minor|relevance|the debate is unnamed",
      "blocking|plausibility|existing theory already explains it",
      "major|data-character|the card claims what bots did",
      "minor|known-result|the caveat is ignored",
      "major|fit|the negative case is not confronted",
      "major|fit|the rival is not named",
    ],
  );
});

test("indented sub-bullets and continuation lines extend the finding above", () => {
  const parsed = mustParse(
    review({
      findings: [
        "- [major] fit: the card's worst fits are not answered",
        "  - the two thin cells are never discussed",
        "    and the rival is not named",
        "* [minor] relevance: the debate is unnamed",
        "  1) the etiquette literature is not cited",
      ],
    }),
  );
  assert.deepEqual(
    parsed.findings.map((finding) => finding.text),
    [
      "the card's worst fits are not answered the two thin cells are never discussed and the rival is not named",
      "the debate is unnamed the etiquette literature is not cited",
    ],
  );
});

test("unknown sections are ignored wherever they sit", () => {
  const extraBefore = review().replace(
    "## Findings",
    "## Summary\nA paragraph the checker should ignore.\n- and a bullet it should ignore\n\n## Findings",
  );
  assert.deepEqual(mustParse(extraBefore).findings, []);

  // A `###` sub-heading is body text of the section it sits in, not a boundary.
  const extraSub = review().replace("## Plausibility", "### Detail\nA sub-heading's prose stays in Fit.\n\n## Plausibility");
  assert.deepEqual(mustParse(extraSub).criteria, { fit: "adequate", plausibility: "adequate", relevance: "adequate" });

  const extraLast = review().replace("Status: DONE", "## Notes\nFree prose at the end, before the status.\n\nStatus: DONE");
  assert.equal(mustParse(extraLast).status, "DONE");
});

test("a duplicated known heading is still a problem", () => {
  const duplicate = review().replace("## Plausibility", "## Fit\nA second Fit section.\n\n## Plausibility");
  assert.equal(parseReview(duplicate), null);
  assert.ok(
    reviewProblems(duplicate).some((problem) => problem.includes('has the heading "## Fit" twice')),
    reviewProblems(duplicate).join("; "),
  );
});

test("the merge carries both statuses, the phase-3 union and a reviewBlocked flag", () => {
  const merged = mergeReviews(
    mustParse(
      review({
        status: "DONE",
        phase3: ["- whether the silence is a rule", "- which section accounts for the counts"],
      }),
    ),
    mustParse(
      review({
        status: "BLOCKED",
        phase3: ["- Whether the silence is a rule!", "- does the glossary define it"],
      }),
    ),
  );
  assert.deepEqual(merged.status, { a: "DONE", b: "BLOCKED" });
  assert.equal(merged.flags.reviewBlocked, true);
  assert.deepEqual(merged.phase3, [
    "whether the silence is a rule",
    "which section accounts for the counts",
    "does the glossary define it",
  ]);

  const clean = mergeReviews(mustParse(review()), mustParse(review({ status: "DONE_WITH_CONCERNS" })));
  assert.equal(clean.flags.reviewBlocked, false);
  assert.deepEqual(clean.status, { a: "DONE", b: "DONE_WITH_CONCERNS" });
});

test("merged.md shows both statuses, warns on an unclean review, and lists the phase-3 union", (t) => {
  const nodeDir = puzzleNode(
    t,
    review({
      findings: [
        "- [blocking] plausibility: existing theory already explains the pattern",
        "- [minor] relevance: the debate it enters is not named",
      ],
      phase3: ["- whether the silence is a rule"],
    }),
    review({
      status: "BLOCKED",
      findings: [
        "- [major] fit: the worst fits are unanswered",
        "- [minor] relevance: the debate it enters is not named",
      ],
      phase3: ["- whether the silence is a rule", "- whether one section accounts for the counts"],
    }),
  );
  const result = spawnSync(process.execPath, [MERGE_REVIEWS, nodeDir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const markdown = readFileSync(path.join(nodeDir, "workspace", "reviews", "merged.md"), "utf8");
  assert.match(markdown, /a: DONE/, markdown);
  assert.match(markdown, /b: BLOCKED/, markdown);
  assert.match(markdown, /review b is BLOCKED.*do not rank/i, markdown);
  assert.match(markdown, /review blocked: yes/, markdown);
  assert.match(markdown, /single reviewer, a/, markdown);
  assert.match(markdown, /single reviewer, b/, markdown);
  assert.match(markdown, /high confidence/, markdown);
  for (const question of ["whether the silence is a rule", "whether one section accounts for the counts"]) {
    assert.ok(markdown.includes(question), `${question} is in merged.md: ${markdown}`);
  }
  assert.equal(markdown.match(/whether the silence is a rule/g)?.length, 1, "the shared question is listed once");
});

test("merged.md notes DONE_WITH_CONCERNS and says None. when there are no findings", (t) => {
  const nodeDir = puzzleNode(t, review({ status: "DONE_WITH_CONCERNS", phase3: [] }), review({ phase3: [] }));
  const result = spawnSync(process.execPath, [MERGE_REVIEWS, nodeDir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const markdown = readFileSync(path.join(nodeDir, "workspace", "reviews", "merged.md"), "utf8");
  assert.match(markdown, /Review a is DONE_WITH_CONCERNS/, markdown);
  assert.match(markdown, /read its findings/i, markdown);
  assert.match(markdown, /None\./, markdown);
});


test("### sub-headings inside ## Findings are skipped and the bullets beneath them count", () => {
  const parsed = mustParse(
    review({
      findings: [
        "### Finding 1",
        "- [blocking] plausibility: existing theory already explains the pattern",
        "### Finding 2",
        "- [minor] fit: the worst fits are unanswered",
      ],
    }),
  );
  assert.deepEqual(
    parsed.findings.map((finding) => `${finding.severity}|${finding.criterion}|${finding.text}`),
    ["blocking|plausibility|existing theory already explains the pattern", "minor|fit|the worst fits are unanswered"],
  );
});

test("a finding under a ### sub-heading still drives the merged flags and ordering", () => {
  const a = mustParse(
    review({
      plausibility: "fails",
      findings: [
        "### Finding 1",
        "- [blocking] plausibility: existing theory already explains the pattern",
        "- [minor] fit: the worst fits are unanswered",
      ],
    }),
  );
  const b = mustParse(
    review({ plausibility: "fails", findings: ["- [blocking] plausibility: existing theory already explains the pattern"] }),
  );
  const merged = mergeReviews(a, b);
  assert.equal(merged.flags.breakdown, true);
  assert.deepEqual(
    merged.findings.map((finding) => `${finding.severity}:${finding.confidence}`),
    ["blocking:high", "minor:single-reviewer"],
  );
});

test("a ### sub-heading does not end a criterion section", () => {
  const before = mustParse(
    review().replace("## Fit\nRating: adequate", "## Fit\n### Why this rating\nRating: adequate"),
  );
  assert.equal(before.criteria.fit, "adequate");

  const after = mustParse(
    review().replace(
      "Rating: adequate\nIt follows the card's numbers.",
      "Rating: adequate\n### Detail\nMore prose, still inside Fit.",
    ),
  );
  assert.equal(after.criteria.fit, "adequate");
  assert.deepEqual(after.findings, []);
});

test("a ### sub-heading inside Phase 3 must check is skipped, not an error", () => {
  const parsed = mustParse(review({ phase3: ["### Questions", "- whether the silence is a rule"] }));
  assert.deepEqual(parsed.phase3MustCheck, ["whether the silence is a rule"]);
});

test("None., None, n/a and - mean an empty Findings or Phase 3 section", () => {
  for (const marker of ["None.", "None", "n/a", "-"]) {
    const parsed = mustParse(review({ findings: [marker], phase3: [marker] }));
    assert.deepEqual(parsed.findings, [], marker);
    assert.deepEqual(parsed.phase3MustCheck, [], marker);
  }

  const bulleted = mustParse(review({ findings: ["- None."], phase3: ["* n/a", "- None"] }));
  assert.deepEqual(bulleted.findings, []);
  assert.deepEqual(bulleted.phase3MustCheck, []);

  // A marker after a real finding adds nothing and is not a continuation of it.
  const mixed = mustParse(review({ findings: ["- [minor] fit: the worst fits are unanswered", "None."] }));
  assert.deepEqual(mixed.findings.map((finding) => finding.text), ["the worst fits are unanswered"]);
});

test("a Rating/Result/Status value is its first word; trailing text and punctuation are ignored", () => {
  const parsed = mustParse(
    review({
      fit: "Adequate — because the card's numbers line up",
      plausibility: "**Weak**: the rival is not named",
      relevance: "adequate.",
      dataCharacter: "ok — no behaviour claim",
      knownResult: "not-applicable; no caveat applies",
      status: "DONE — no blocking concerns",
    }),
  );
  assert.deepEqual(parsed.criteria, { fit: "adequate", plausibility: "weak", relevance: "adequate" });
  assert.equal(parsed.dataCharacter, "ok");
  assert.equal(parsed.knownResult, "not-applicable");
  assert.equal(parsed.status, "DONE");
});

test("Result: not applicable with a space is not-applicable", () => {
  assert.equal(mustParse(review({ knownResult: "not applicable" })).knownResult, "not-applicable");
  assert.equal(mustParse(review({ knownResult: "**not** applicable" })).knownResult, "not-applicable");
  assert.equal(mustParse(review({ knownResult: "Not Applicable." })).knownResult, "not-applicable");
});

test("a first word outside the allowed set is still refused, even with trailing text", () => {
  const cases: [string, RegExp][] = [
    [review({ fit: "excellent — the puzzle is marvellous" }), /invalid rating "excellent"/],
    [review({ dataCharacter: "mostly ok" }), /invalid result "mostly"/],
    [review({ knownResult: "violated; the caveat applies" }), /invalid result "violated"/],
    [review({ status: "DONEISH" }), /invalid status "DONEISH"/],
  ];
  for (const [markdown, pattern] of cases) {
    assert.equal(parseReview(markdown), null, markdown);
    assert.ok(
      reviewProblems(markdown).some((problem) => pattern.test(problem)),
      `${pattern}: ${reviewProblems(markdown).join("; ")}`,
    );
  }
});

test("the CLI accepts a review whose Findings and Phase 3 say None.", (t) => {
  const nodeDir = puzzleNode(t, review({ findings: ["None."], phase3: ["None."] }), review());
  const result = spawnSync(process.execPath, [MERGE_REVIEWS, nodeDir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});


const NEAR_MISS_FINDINGS_HEADINGS = [
  "## findings",
  "## FINDINGS",
  "## Findings:",
  "## Findings (continued)",
  "## Findings and Phase 3",
];

const BLOCKING_BULLET = "- [blocking] plausibility: existing theory already explains the pattern";

test("a near-miss Findings heading is normalised to the known heading, or refused — never silent", () => {
  for (const heading of NEAR_MISS_FINDINGS_HEADINGS) {
    // The near-miss heading is the only Findings section, with a blocking bullet beneath it.
    const markdown = review().replace("## Findings", `${heading}\n${BLOCKING_BULLET}`);
    const parsed = parseReview(markdown);
    if (parsed !== null) {
      assert.deepEqual(
        parsed.findings,
        [{ severity: "blocking", criterion: "plausibility", text: "existing theory already explains the pattern" }],
        `${heading}: a parsed review carries the blocking finding`,
      );
    } else {
      const problems = reviewProblems(markdown);
      assert.ok(
        problems.some(
          (problem) => /lacks the heading "## Findings"|finding-shaped line under unknown heading/.test(problem),
        ),
        `${heading}: ${problems.join("; ")}`,
      );
    }
  }
});

test("a near-miss heading after the real ## Findings is refused, never dropped", () => {
  for (const heading of ["## findings", "## FINDINGS", "## Findings:"]) {
    const markdown = review().replace(
      "## Phase 3 must check",
      `${heading}\n${BLOCKING_BULLET}\n\n## Phase 3 must check`,
    );
    assert.equal(parseReview(markdown), null, `${heading}: a second Findings section is a duplicate`);
    assert.ok(
      reviewProblems(markdown).some((problem) => problem.includes('has the heading "## Findings" twice')),
      `${heading}: ${reviewProblems(markdown).join("; ")}`,
    );
  }

  for (const heading of ["## Findings (continued)", "## Findings and Phase 3"]) {
    const markdown = review().replace(
      "## Phase 3 must check",
      `${heading}\n${BLOCKING_BULLET}\n\n## Phase 3 must check`,
    );
    assert.equal(parseReview(markdown), null, `${heading}: the finding-shaped bullet must be refused`);
    const problems = reviewProblems(markdown);
    assert.ok(
      problems.some(
        (problem) =>
          problem.includes("finding-shaped line under unknown heading") &&
          problem.includes(heading.slice(3)) &&
          problem.includes("put findings under ## Findings"),
      ),
      `${heading}: ${problems.join("; ")}`,
    );
    assert.ok(
      problems.some((problem) => problem.includes("put findings under ## Findings") && /at line \d+/.test(problem)),
      `${heading} names the line: ${problems.join("; ")}`,
    );
  }
});

test("known headings tolerate case, emphasis and a trailing colon", () => {
  const variant = review()
    .replace("## Fit", "## fit")
    .replace("## Plausibility", "## PLAUSIBILITY")
    .replace("## Relevance", "## **Relevance**:")
    .replace("## Data-character check", "## data-character CHECK:")
    .replace("## Known-result check", "## _Known-result check_")
    .replace("## Findings", "## FINDINGS:")
    .replace("## Phase 3 must check", "## phase 3 must check:");
  const parsed = mustParse(variant);
  assert.deepEqual(parsed.criteria, { fit: "adequate", plausibility: "adequate", relevance: "adequate" });
  assert.equal(parsed.dataCharacter, "ok");
  assert.equal(parsed.knownResult, "not-applicable");
  assert.deepEqual(parsed.phase3MustCheck, ["whether the handbook's silence is a rule or an omission"]);
});

test("a normalised duplicate of another known heading is refused", () => {
  const duplicate = review().replace("## Plausibility", "## **plausibility**:\nA second one.\n\n## Plausibility");
  assert.equal(parseReview(duplicate), null);
  assert.ok(
    reviewProblems(duplicate).some((problem) => problem.includes('has the heading "## Plausibility" twice')),
    reviewProblems(duplicate).join("; "),
  );
});

test("a blocking finding under a lower-case ## findings heading still drives the merge", () => {
  const a = mustParse(review({ plausibility: "fails" }).replace("## Findings", `## findings\n${BLOCKING_BULLET}`));
  const b = mustParse(review({ plausibility: "fails", findings: [BLOCKING_BULLET] }));
  const merged = mergeReviews(a, b);
  assert.equal(merged.flags.breakdown, true);
  assert.deepEqual(
    merged.findings.map((finding) => `${finding.severity}:${finding.confidence}`),
    ["blocking:high"],
  );
});

test("a finding-shaped bullet under ## Summary is refused; ordinary bullets there are ignored", () => {
  const bad = review().replace(
    "## Phase 3 must check",
    `## Summary\n${BLOCKING_BULLET}\n\n## Phase 3 must check`,
  );
  assert.equal(parseReview(bad), null);
  const problems = reviewProblems(bad);
  assert.ok(
    problems.some(
      (problem) =>
        problem.includes("finding-shaped line under unknown heading 'Summary'") &&
        problem.includes("put findings under ## Findings"),
    ),
    problems.join("; "),
  );

  const good = review().replace(
    "## Phase 3 must check",
    "## Summary\nA paragraph.\n- an ordinary bullet\n* another one\n\n## Phase 3 must check",
  );
  assert.deepEqual(mustParse(good).findings, []);
  assert.deepEqual(mustParse(good).phase3MustCheck, ["whether the handbook's silence is a rule or an omission"]);
});

test("the CLI treats a bad invocation as a usage error", (t) => {
  const none = spawnSync(process.execPath, [MERGE_REVIEWS], { encoding: "utf8" });
  assert.equal(none.status, 2);

  const tooMany = spawnSync(process.execPath, [MERGE_REVIEWS, "a", "b"], { encoding: "utf8" });
  assert.equal(tooMany.status, 2);

  const unknown = spawnSync(process.execPath, [MERGE_REVIEWS, puzzleNode(t, review(), review()), "--force"], {
    encoding: "utf8",
  });
  assert.equal(unknown.status, 2);

  const missingDir = spawnSync(process.execPath, [MERGE_REVIEWS, path.join(tmpdir(), "no-such-puzzle-node")], {
    encoding: "utf8",
  });
  assert.equal(missingDir.status, 2);
});
