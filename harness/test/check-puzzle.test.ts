// The puzzle card is the artefact Phase 2 produces: everything the judge and the
// reviewers read is in `workspace/puzzle.md`, and a card that is missing a section
// is a card no reader can be asked to judge. `check-puzzle` is the deterministic
// gate `promote` runs before a puzzle leaves Phase 2, so these tests pin every
// rule in the design (§9) with one failing case each: the seven headings, the
// lens/round/derivation lines, the two readings Phase 3 needs (status quo and
// artifact), the citation check on the card and on both reviews, the two
// reviews and their merge, and the absence of analysis (no `workspace/scripts/`
// or `workspace/results/` in Phase 2).
//
// The card is written by a model, so the parser bends on formatting (case,
// emphasis, a trailing colon on a heading, CRLF, `**Lens:**`) and is strict on
// presence: a heading that is not there is a problem, never a silence.
//
// Citations are injected in the unit tests (the real check calls `deepis`); the
// CLI tests use a card with no citations at all, so they exercise the default
// runner without a database.
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { checkPuzzle, citationProblems } from "../tools/check-puzzle.ts";
import { createChild, findNode, initRun } from "../tree.ts";

const CHECK_PUZZLE = fileURLToPath(new URL("../tools/check-puzzle.ts", import.meta.url));

/** No citation problems: the unit tests never reach `deepis`. */
const NO_CITATIONS = { citations: (): string[] => [] };

const HEADINGS = [
  "## Pattern",
  "## Violated expectation",
  "## A case of",
  "## Why it matters",
  "## Admissible explanations",
  "## Limits",
  "## Literature log",
];

/** A complete round-0 card, with a status-quo and an artifact reading, and no citations. */
function card(): string {
  return [
    "Lens: status quo — the theory nearest the violated expectation",
    "Round: 0",
    "",
    "## Pattern",
    "T03 measured 12 of 40 pages (30%), and the same ordering held at depth 2.",
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

/** The card with the derivation header lines an evolved puzzle carries. */
function derivedCard(ids: string[], move: string): string {
  return card().replace(/(Round: \d+\n)/, (_line, round: string) => `${round}Derived from: ${ids.join(", ")}\nMove: ${move}\n`);
}

interface Fixture {
  run: string;
  nodeDir: string;
  /** The ids a derived node's card must name. */
  parents: string[];
}

/**
 * A run with a pattern node T01 and two plain puzzles P01/P02; with
 * `derivedFrom`, the fixture's node is the derived P03. `card` writes the
 * puzzle card (default: the complete card for a plain, the matching one for a
 * derived node).
 */
function puzzleNode(t: TestContext, opts: { derivedFrom?: boolean; card?: string } = {}): Fixture {
  const run = mkdtempSync(path.join(tmpdir(), "ctc-check-puzzle-"));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  initRun(run, "data", "interest");
  createChild(run, "D01", "E03 Etiquette", "owner-p1"); // T01
  createChild(run, "T01", "Grounding puzzle", "owner-p2"); // P01
  createChild(run, "T01", "Second puzzle", "owner-p2"); // P02

  const parents = ["P01", "P02"];
  const node = opts.derivedFrom === true
    ? createChild(run, "T01", "Derived puzzle", "owner-p2", parents)
    : findNode(run, "P01");
  const markdown = opts.card ?? (opts.derivedFrom === true ? derivedCard(parents, "grounding") : card());
  write(path.join(node.dir, "workspace", "puzzle.md"), markdown);
  return { run, nodeDir: node.dir, parents };
}

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** The card with one canonical heading demoted to prose. */
function withoutHeading(markdown: string, heading: string): string {
  return markdown.replace(`${heading}\n`, `${heading.replace("## ", "")}\n`);
}

function problemsOf(fixture: Fixture, opts: { reviews?: boolean; citations?: (file: string) => string[] } = {}): string[] {
  return checkPuzzle(fixture.run, fixture.nodeDir, { ...NO_CITATIONS, ...opts }).problems;
}

/** A review in the fixed format the reviewers write (see merge-reviews.ts). */
function review(status = "DONE"): string {
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
    `Status: ${status}`,
    "",
  ].join("\n");
}

/** The two reviews and the merge every reviewed puzzle must have. */
function writeReviews(nodeDir: string, opts: { a?: string; b?: string | null; merged?: boolean } = {}): void {
  const dir = path.join(nodeDir, "workspace", "reviews");
  mkdirSync(dir, { recursive: true });
  write(path.join(dir, "a.md"), opts.a ?? review());
  if (opts.b !== null) write(path.join(dir, "b.md"), opts.b ?? review());
  if (opts.merged !== false) write(path.join(dir, "merged.json"), "{}\n");
}

test("a complete card has no problems", (t) => {
  const plain = puzzleNode(t);
  assert.deepEqual(checkPuzzle(plain.run, plain.nodeDir, NO_CITATIONS), { problems: [] });

  const derived = puzzleNode(t, { derivedFrom: true });
  assert.deepEqual(checkPuzzle(derived.run, derived.nodeDir, NO_CITATIONS), { problems: [] });
});

test("a missing workspace/puzzle.md is the only problem reported", (t) => {
  const { run, nodeDir } = puzzleNode(t);
  rmSync(path.join(nodeDir, "workspace", "puzzle.md"));
  assert.deepEqual(problemsOf({ run, nodeDir, parents: [] }), ["workspace/puzzle.md is missing"]);
});

test("each missing heading is a problem", (t) => {
  for (const heading of HEADINGS) {
    const fixture = puzzleNode(t, { card: withoutHeading(card(), heading) });
    const problems = problemsOf(fixture);
    assert.ok(
      problems.some((problem) => problem === `workspace/puzzle.md lacks the heading "${heading}"`),
      `${heading}: ${problems.join("\n")}`,
    );
  }
});

test("a card with only some headings names every missing one", (t) => {
  const fixture = puzzleNode(t, { card: ["Lens: status quo", "Round: 0", "", "## Pattern", "T03 measured 12 of 40."].join("\n") });
  const problems = problemsOf(fixture);
  for (const heading of HEADINGS.slice(1)) {
    assert.ok(problems.some((problem) => problem.includes(`lacks the heading "${heading}"`)), problems.join("\n"));
  }
});

test("a missing Lens: or Round: line is a problem", (t) => {
  const noLens = puzzleNode(t, { card: card().replace(/^Lens:.*\n/m, "") });
  assert.deepEqual(problemsOf(noLens), ['workspace/puzzle.md lacks a "Lens:" line']);

  const emptyLens = puzzleNode(t, { card: card().replace(/^Lens:.*$/m, "Lens:") });
  assert.deepEqual(problemsOf(emptyLens), ['workspace/puzzle.md lacks a "Lens:" line']);

  const noRound = puzzleNode(t, { card: card().replace(/^Round:.*\n/m, "") });
  assert.deepEqual(problemsOf(noRound), ['workspace/puzzle.md lacks a "Round: <integer>" line']);

  const emptyRound = puzzleNode(t, { card: card().replace(/^Round:.*$/m, "Round:") });
  assert.deepEqual(problemsOf(emptyRound), ['workspace/puzzle.md lacks a "Round: <integer>" line']);

  const badRound = puzzleNode(t, { card: card().replace(/^Round:.*$/m, "Round: soon") });
  assert.deepEqual(problemsOf(badRound), ['workspace/puzzle.md\'s "Round: soon" is not an integer']);
});

test("an evolved puzzle must name exactly its derivedFrom ids", (t) => {
  const missing = puzzleNode(t, { derivedFrom: true, card: card() });
  const missingProblems = problemsOf(missing);
  assert.ok(
    missingProblems.some((problem) => /lacks a "Derived from:" line naming P01, P02/.test(problem)),
    missingProblems.join("\n"),
  );

  const wrong = puzzleNode(t, { derivedFrom: true, card: derivedCard(["P01", "P03"], "grounding") });
  const wrongProblems = problemsOf(wrong);
  assert.ok(
    wrongProblems.some((problem) => problem === 'workspace/puzzle.md\'s "Derived from:" line names P01, P03, not P01, P02'),
    wrongProblems.join("\n"),
  );

  const one = puzzleNode(t, { derivedFrom: true, card: derivedCard(["P01"], "grounding") });
  assert.ok(
    problemsOf(one).some((problem) => /"Derived from:" line names P01, not P01, P02/.test(problem)),
    problemsOf(one).join("\n"),
  );

  const extra = puzzleNode(t, { derivedFrom: true, card: derivedCard(["P01", "P02", "P03"], "grounding") });
  assert.ok(
    problemsOf(extra).some((problem) => /"Derived from:" line names P01, P02, P03, not P01, P02/.test(problem)),
    problemsOf(extra).join("\n"),
  );
});

test("a Derived from: whose ids are in another order is accepted", (t) => {
  const fixture = puzzleNode(t, { derivedFrom: true, card: derivedCard(["P02", "P01"], "grounding") });
  assert.deepEqual(problemsOf(fixture), []);
});

test("a plain puzzle must not carry a Derived from: line", (t) => {
  const fixture = puzzleNode(t, { card: derivedCard(["P01"], "grounding") });
  assert.deepEqual(problemsOf(fixture), ['workspace/puzzle.md has a "Derived from:" line but node.json has no derivedFrom']);
});

test("an evolved puzzle needs a valid Move:", (t) => {
  const moves = ["grounding", "simplification", "out-of-the-box", "combination", "out of the box"];
  for (const move of moves) {
    const fixture = puzzleNode(t, { derivedFrom: true, card: derivedCard(["P01", "P02"], move) });
    assert.deepEqual(problemsOf(fixture), [], move);
  }

  const missing = puzzleNode(t, { derivedFrom: true, card: derivedCard(["P01", "P02"], "grounding").replace(/^Move:.*\n/m, "") });
  assert.deepEqual(problemsOf(missing), [
    'workspace/puzzle.md lacks a "Move:" line (grounding, simplification, out-of-the-box or combination)',
  ]);

  const bad = puzzleNode(t, { derivedFrom: true, card: derivedCard(["P01", "P02"], "recasting") });
  assert.deepEqual(problemsOf(bad), [
    'workspace/puzzle.md\'s "Move: recasting" is not one of grounding, simplification, out-of-the-box, combination',
  ]);
});

test("## Admissible explanations must carry a status-quo and an artifact reading", (t) => {
  const noStatusQuo = puzzleNode(t, {
    card: card().replace("- The status-quo reading: existing theory already explains the share.", "- A rival reading: another theory explains it."),
  });
  assert.deepEqual(problemsOf(noStatusQuo), [
    'workspace/puzzle.md\'s "## Admissible explanations" lacks a status-quo reading',
  ]);

  const noArtifact = puzzleNode(t, {
    card: card().replace("- An artifact reading: the corpus's page form produced the count.", "- A corpus reading: the pages are short."),
  });
  assert.deepEqual(problemsOf(noArtifact), ['workspace/puzzle.md\'s "## Admissible explanations" lacks an artifact reading']);

  const neither = puzzleNode(t, { card: card().replace(/## Admissible explanations\n[\s\S]*?\n## Limits/, "## Admissible explanations\n- one reading\n\n## Limits") });
  const problems = problemsOf(neither);
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.match(problems[0] ?? "", /lacks a status-quo reading/);
  assert.match(problems[1] ?? "", /lacks an artifact reading/);
});

test("the readings are matched only inside ## Admissible explanations", (t) => {
  // "status quo" and "artifact" in other sections are not the section's readings.
  const fixture = puzzleNode(t, {
    card: card()
      .replace("- The status-quo reading: existing theory already explains the share.", "- A rival reading: existing theory explains it.")
      .replace("## Why it matters\nIt speaks to the debate on how organisational rules travel.", "## Why it matters\nIt speaks to the artifact debate and the status quo reading."),
  });
  assert.deepEqual(problemsOf(fixture), [
    'workspace/puzzle.md\'s "## Admissible explanations" lacks a status-quo reading',
  ]);
});

test("citation problems on the card are reported, prefixed with the card's path", (t) => {
  const fixture = puzzleNode(t);
  const problems = problemsOf(fixture, {
    citations: (file) => {
      assert.ok(file.endsWith("workspace/puzzle.md"), file);
      return ["missing chunk id 144636", 'quote not in cited chunk 12 (line 7): "a rule"'];
    },
  });
  assert.deepEqual(problems, [
    "workspace/puzzle.md: missing chunk id 144636",
    'workspace/puzzle.md: quote not in cited chunk 12 (line 7): "a rule"',
  ]);
});

test("a passing citation check reports nothing", (t) => {
  const fixture = puzzleNode(t);
  assert.deepEqual(problemsOf(fixture, { citations: () => [] }), []);
});

test("a file under workspace/scripts or workspace/results is a problem", (t) => {
  const scripts = puzzleNode(t);
  write(path.join(scripts.nodeDir, "workspace", "scripts", "x.py"), "print('counted')\n");
  assert.deepEqual(problemsOf(scripts), ["workspace/scripts/x.py exists: Phase 2 runs no analysis"]);

  const results = puzzleNode(t);
  write(path.join(results.nodeDir, "workspace", "results", "counts.csv"), "slice,n\n");
  assert.deepEqual(problemsOf(results), ["workspace/results/counts.csv exists: Phase 2 runs no analysis"]);
});

test("empty workspace/scripts and workspace/results directories are fine", (t) => {
  const fixture = puzzleNode(t);
  mkdirSync(path.join(fixture.nodeDir, "workspace", "scripts"), { recursive: true });
  mkdirSync(path.join(fixture.nodeDir, "workspace", "results"), { recursive: true });
  assert.deepEqual(problemsOf(fixture), []);
});

test("with reviews: true the two reviews and their merge are required", (t) => {
  const fixture = puzzleNode(t);
  assert.deepEqual(problemsOf(fixture, { reviews: true }), [
    "workspace/reviews/a.md is missing",
    "workspace/reviews/b.md is missing",
    "workspace/reviews/merged.json is missing",
  ]);

  writeReviews(fixture.nodeDir, {});
  assert.deepEqual(problemsOf(fixture, { reviews: true }), []);

  writeReviews(fixture.nodeDir, { b: null });
  rmSync(path.join(fixture.nodeDir, "workspace", "reviews", "b.md"));
  assert.deepEqual(problemsOf(fixture, { reviews: true }), ["workspace/reviews/b.md is missing"]);
});

test("an unparseable review is named with its file and its problems", (t) => {
  const fixture = puzzleNode(t);
  writeReviews(fixture.nodeDir, { a: review().replace("## Fit\nRating: adequate", "## Fit\nno rating here") });
  const problems = problemsOf(fixture, { reviews: true });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /^workspace\/reviews\/a\.md: /);
  assert.match(problems[0] ?? "", /Fit/i);
});

test("the citation check must pass on both review files", (t) => {
  const fixture = puzzleNode(t);
  writeReviews(fixture.nodeDir, {});
  const seen: string[] = [];
  const problems = problemsOf(fixture, {
    reviews: true,
    citations: (file) => {
      seen.push(path.relative(fixture.nodeDir, file).split(path.sep).join("/"));
      return file.endsWith("b.md") ? ["missing chunk id 7"] : [];
    },
  });
  assert.deepEqual(problems, ["workspace/reviews/b.md: missing chunk id 7"]);
  assert.deepEqual(seen.sort(), ["workspace/puzzle.md", "workspace/reviews/a.md", "workspace/reviews/b.md"]);
});

test("the reviews are not checked without reviews: true", (t) => {
  const fixture = puzzleNode(t);
  assert.deepEqual(problemsOf(fixture), []);
});

test("the card parser bends on formatting but not on presence", (t) => {
  const lenient = [
    "# Puzzle P01",
    "",
    "**Lens:** status quo — the nearest existing theory",
    "**Round:** 0",
    "",
    "## pattern:",
    "T03 measured 12 of 40 pages (30%).",
    "",
    "## VIOLATED EXPECTATION",
    "Smith (2001) expects the rule to be stated.",
    "",
    "## A case of:",
    "A case of translation.",
    "",
    "## Why it matters",
    "It speaks to the debate.",
    "",
    "## admissible explanations",
    "- Status-Quo reading: existing theory already explains the share.",
    "- An Artefact reading: the page form produced the count.",
    "",
    "## Limits",
    "This snapshot cannot show causality.",
    "",
    "## Literature log",
    "- deepis search 'etiquette rules'.",
    "",
  ].join("\r\n");
  const fixture = puzzleNode(t, { card: lenient });
  assert.deepEqual(problemsOf(fixture), []);
});

test("problems are reported in the brief's order", (t) => {
  const fixture = puzzleNode(t, {
    // A card missing its "## Pattern" heading, no Lens line, no readings, with a stray script.
    card: [
      "Round: 0",
      "",
      "## Violated expectation",
      "Smith (2001) expects the rule to be stated.",
      "",
      "## A case of",
      "A case of translation.",
      "",
      "## Why it matters",
      "It speaks to the debate.",
      "",
      "## Admissible explanations",
      "- one reading",
      "",
      "## Limits",
      "Thin.",
      "",
      "## Literature log",
      "- deepis search.",
    ].join("\n"),
  });
  write(path.join(fixture.nodeDir, "workspace", "results", "n.csv"), "n\n");
  const problems = problemsOf(fixture, { citations: () => ["missing chunk id 3"] });
  assert.deepEqual(problems, [
    'workspace/puzzle.md lacks the heading "## Pattern"',
    'workspace/puzzle.md lacks a "Lens:" line',
    'workspace/puzzle.md\'s "## Admissible explanations" lacks a status-quo reading',
    'workspace/puzzle.md\'s "## Admissible explanations" lacks an artifact reading',
    "workspace/puzzle.md: missing chunk id 3",
    "workspace/results/n.csv exists: Phase 2 runs no analysis",
  ]);
});

test("a derivedFrom naming a node that is not in the run is a problem", (t) => {
  const fixture = puzzleNode(t, { derivedFrom: true, card: derivedCard(["P09"], "grounding") });
  // Re-point the derived node at an id the run does not have, as a hand edit would.
  const stateFile = path.join(fixture.nodeDir, "node.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as { derivedFrom: string[] };
  state.derivedFrom = ["P09"];
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  assert.deepEqual(problemsOf(fixture), ["node.json's derivedFrom names P09, which is not a node in this run"]);
});

test("a node folder that is not a node is a usage error, not a finding", (t) => {
  const fixture = puzzleNode(t);
  const outside = mkdtempSync(path.join(tmpdir(), "P99-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  assert.throws(() => checkPuzzle(fixture.run, path.join(fixture.run, "patterns")), /not a node folder/);
  assert.throws(() => checkPuzzle(fixture.run, outside), /not inside the run/);
});

test("the CLI prints ok and exits 0 for a good node", (t) => {
  const fixture = puzzleNode(t);
  const result = spawnSync(process.execPath, [CHECK_PUZZLE, fixture.nodeDir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), ["ok"]);
});

test("the CLI prints one problem per line and exits 1 for a bad node", (t) => {
  const fixture = puzzleNode(t, { card: withoutHeading(card(), "## Limits") });
  write(path.join(fixture.nodeDir, "workspace", "scripts", "x.py"), "print('counted')\n");

  const result = spawnSync(process.execPath, [CHECK_PUZZLE, fixture.nodeDir], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    'workspace/puzzle.md lacks the heading "## Limits"',
    "workspace/scripts/x.py exists: Phase 2 runs no analysis",
  ]);
});

test("the CLI accepts --reviews and enforces the review files", (t) => {
  const fixture = puzzleNode(t);
  const missing = spawnSync(process.execPath, [CHECK_PUZZLE, fixture.nodeDir, "--reviews"], { encoding: "utf8" });
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stdout, /workspace\/reviews\/a\.md is missing/);

  writeReviews(fixture.nodeDir, {});
  const ok = spawnSync(process.execPath, [CHECK_PUZZLE, fixture.nodeDir, "--reviews"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), "ok");
});

test("the CLI rejects a bad invocation with exit 2", (t) => {
  const fixture = puzzleNode(t);
  const noArgs = spawnSync(process.execPath, [CHECK_PUZZLE], { encoding: "utf8" });
  assert.equal(noArgs.status, 2);

  const unknown = spawnSync(process.execPath, [CHECK_PUZZLE, fixture.nodeDir, "--nope"], { encoding: "utf8" });
  assert.equal(unknown.status, 2);

  const notADir = spawnSync(process.execPath, [CHECK_PUZZLE, path.join(fixture.run, "nope")], { encoding: "utf8" });
  assert.equal(notADir.status, 2);
});

test("the default citation runner turns a failure into problem lines", (t) => {
  const fixture = puzzleNode(t);
  const file = path.join(fixture.nodeDir, "workspace", "puzzle.md");

  // A check that exits non-zero: its stderr lines are the problem lines.
  const failing = path.join(fixture.run, "failing-citations.mjs");
  write(failing, 'console.error("missing chunk id 12");\nprocess.exit(1);\n');
  assert.deepEqual(citationProblems(file, { command: failing }), ["missing chunk id 12"]);

  // A check that exits 0 has nothing to report.
  const passing = path.join(fixture.run, "passing-citations.mjs");
  write(passing, "console.log('ok 0 citations');\n");
  assert.deepEqual(citationProblems(file, { command: passing }), []);

  // A hung check is a problem line, never a hung tool.
  const hung = path.join(fixture.run, "hung-citations.mjs");
  write(hung, "setTimeout(() => {}, 10000);\n");
  const timedOut = citationProblems(file, { command: hung, timeoutMs: 100 });
  assert.equal(timedOut.length, 1, timedOut.join("\n"));
  assert.match(timedOut[0] ?? "", /citation check .* failed/);
});
