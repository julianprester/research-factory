// `check-paper` is the code gate in front of a paper's style passes and its submit: it reads the
// manuscript, the embed sources the paper copies from its explanation, the quotations, the
// citations, the Predictions and the pins, and says what is wrong. These tests pin each rule with
// one failing case. Every host-side read is without following a link: a symlinked include is refused
// by name. Citations are injected (the real check calls `deepis`); the CLI tests use a paper with no
// citations, so the default runner passes without a database.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { prepareExploration } from "../analysis/run.ts";
import { quoteSource } from "../paper/quotes.ts";
import { checkPaper } from "../tools/check-paper.ts";
import { createChild, findNode, initRun, updateNode } from "../tree.ts";

const CHECK_PAPER = fileURLToPath(new URL("../tools/check-paper.ts", import.meta.url));

/** No citation problems: the unit tests never reach `deepis`. */
const NO_CITATIONS = { citations: (): string[] => [] };

const RULES = ["# Rules", "", "Be patient.   ", "  Wait your turn.", "", "Never interrupt.", ""].join("\n");

const PREDICTIONS = "The hold-out sample should show the same ordering.";

/** The explanation's argument: every section the Predictions pin reads, and the Predictions text. */
const ARGUMENT = [
  "Contribution: theoretical",
  "",
  "## Explanation",
  "Etiquette rules travel by example rather than by statement.",
  "",
  "## Mechanism and scope",
  "Readers copy the first example they meet.",
  "",
  "## What would count against it",
  "Rules stated in full on the opening pages.",
  "",
  "## Alternatives considered",
  "The timing account is ruled out by the ordering.",
  "",
  "## Evidence",
  "The share is [.401](output/numbers/12_model1.csv#m1) of the sampled pages.",
  "",
  "## Limitations",
  "The snapshot cannot show causality.",
  "",
  "## Predictions",
  PREDICTIONS,
  "",
].join("\n");

/** A complete paper: every embed resolves, no hand-typed number, the Predictions included. */
const PAPER_TEXT = [
  "---",
  'title: "Etiquette by example"',
  'author: "Test Author"',
  "bibliography: references.bib",
  "---",
  "",
  "# Introduction",
  "",
  "Readers copy the first example they meet. The share is {{< var m1_or_lspec >}} of the pages, out of {{< var n_pages >}} in all.",
  "",
  "{{< include embeds/tables/T1.qmd >}}",
  "",
  "![The sample](embeds/figures/F1.png)",
  "",
  "The handbook states the rule plainly:",
  "",
  "{{< include embeds/quotes/Q01.qmd >}}",
  "",
  "## Predictions",
  "",
  "{{< include embeds/predictions.qmd >}}",
  "",
].join("\n");

interface Fixture {
  run: string;
  explanation: string;
  paper: string;
}

function put(file: string, text: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function at(base: string, rel: string): string {
  return path.join(base, ...rel.split("/"));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * A run with an explanation E01 in phase 4 and its paper W01, complete: the explanation's argument,
 * registry, assets, table and figure; the paper's copies of each; the Predictions fragment; a quotation
 * from an exploration copy; the pins; and a reproduction record. Every test edits one piece of it.
 */
function fixture(t: TestContext): Fixture {
  const dataset = mkdtempSync(path.join(tmpdir(), "ctc-check-paper-dataset-"));
  t.after(() => rmSync(dataset, { recursive: true, force: true }));
  put(path.join(dataset, "handbook", "rules.md"), RULES);

  const run = mkdtempSync(path.join(tmpdir(), "ctc-check-paper-run-"));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  initRun(run, dataset, "interest");
  createChild(run, "D01", "Self Presentation", "owner-p1");
  createChild(run, "T01", "status quo: crowd", "owner-p2");
  createChild(run, "P01", "Explanation of crowd", "owner-p3", [], "explanation");
  updateNode(run, "E01", { phase: 3, status: "active" }, "owner-p3");
  updateNode(run, "E01", { phase: 4, status: "ready" }, "owner-p3");
  createChild(run, "E01", "Paper of crowd", "owner-p4", [], "paper");
  put(path.join(run, "config.json"), JSON.stringify({ model: "test-model", phases: { "4": "harness/skills/phase-4" } }, null, 2));

  const split = path.join(run, "prep", "Z01-profile", "workspace", "split");
  put(path.join(split, "exploration.txt"), "handbook/rules.md\n");
  put(path.join(split, "holdout.txt"), "handbook/held.md\n");
  prepareExploration(run);

  const explanation = findNode(run, "E01").dir;
  const paper = findNode(run, "W01").dir;
  const assets = {
    "_variables.yml": 'm1_or_lspec: ".401"\nn_pages: "1234"\n',
    "variables_sources.csv":
      "variable,value,rendered,source\n" +
      "m1_or_lspec,0.401,.401,output/numbers/12_model1.csv#m1\n" +
      "n_pages,1234,1234,output/numbers/01_counts.csv#n\n",
    "T1.qmd": "| Group | N |\n|---|---|\n| A | 12 |\n",
  };
  const figure = "figure bytes\n";
  put(at(explanation, "workspace/argument.md"), ARGUMENT);
  put(at(explanation, "workspace/output/numbers/01_counts.csv"), "name,value,note\nn,1234,\n");
  put(at(explanation, "workspace/output/numbers/12_model1.csv"), "name,value,note\nm1,0.401,\nm2,0.2,\n");
  for (const [name, text] of Object.entries(assets)) put(at(explanation, `workspace/output/assets/${name}`), text);
  put(at(explanation, "workspace/output/figures/F1.png"), figure);
  put(
    at(run, "owners/phase-3/loop/E01/reproduction.json"),
    JSON.stringify({ ok: true, workspaceHash: "hash-one", mismatches: [] }, null, 2) + "\n",
  );

  put(at(paper, "workspace/paper.qmd"), PAPER_TEXT);
  for (const [name, text] of Object.entries(assets)) put(at(paper, `workspace/${name}`), text);
  put(at(paper, "workspace/embeds/tables/T1.qmd"), assets["T1.qmd"]);
  put(at(paper, "workspace/embeds/figures/F1.png"), figure);
  put(at(paper, "workspace/embeds/predictions.qmd"), `${PREDICTIONS}\n`);
  put(at(paper, "workspace/checks/pins.json"), pins(ARGUMENT, "hash-one", PREDICTIONS));
  quoteSource(run, paper, { path: "handbook/rules.md", start: 3, end: 4 });
  return { run, explanation, paper };
}

/** The pins file a paper carries when it was pinned against these texts. */
function pins(argument: string, workspaceHash: string, predictions: string): string {
  return (
    JSON.stringify(
      { argumentSha: sha256(argument), workspaceHash, predictionsSha: sha256(predictions), reopens: 0, outlineShaAtReopen: null },
      null,
      2,
    ) + "\n"
  );
}

function check(f: Fixture, opts: Parameters<typeof checkPaper>[2] = {}): Promise<{ problems: string[]; warnings: string[] }> {
  return checkPaper(f.run, f.paper, { ...NO_CITATIONS, ...opts });
}

/** The line number (1-based) of the first line of `text` that is `line`. */
function lineOf(text: string, line: string): number {
  return text.split("\n").indexOf(line) + 1;
}

// ---------------------------------------------------------------------------
// The complete paper, and the first problem: paper.qmd.

test("a complete paper has no problems and no warnings", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await check(f), { problems: [], warnings: [] });
});

test("a paper with no paper.qmd names it, and the text checks are not run", async (t) => {
  const f = fixture(t);
  rmSync(at(f.paper, "workspace/paper.qmd"));
  assert.deepEqual(await check(f), { problems: ["workspace/paper.qmd is missing"], warnings: [] });
});

// ---------------------------------------------------------------------------
// Variables: in _variables.yml, and a source row that resolves once in the registry.

test("a variable that is not in _variables.yml is a problem naming it", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/paper.qmd"), `${PAPER_TEXT}\n{{< var k_missing >}}\n`);
  assert.deepEqual((await check(f)).problems, ["variable k_missing is not in workspace/_variables.yml"]);
});

test("a variable whose source key is present twice in the registry is a problem", async (t) => {
  const f = fixture(t);
  put(at(f.explanation, "workspace/output/numbers/01_counts.csv"), "name,value,note\nn,1234,\nn,1234,\n");
  assert.deepEqual((await check(f)).problems, ["variable n_pages has no source row that resolves to exactly one registry row"]);
});

test("a variable with no row in variables_sources.csv is a problem", async (t) => {
  const f = fixture(t);
  const without = (text: string): string => text.replace(/^n_pages,.*\n/m, "");
  for (const rel of ["workspace/output/assets/variables_sources.csv", "workspace/variables_sources.csv"]) {
    const file = at(rel.startsWith("workspace/output") ? f.explanation : f.paper, rel);
    put(file, without(readFileSync(file, "utf8")));
  }
  assert.deepEqual((await check(f)).problems, ["variable n_pages has no row in workspace/variables_sources.csv"]);
});

test("a registry file that cannot be read is a problem naming it, and the check does not throw", async (t) => {
  const f = fixture(t);
  put(at(f.explanation, "workspace/output/numbers/01_counts.csv"), "a,b\n1,2\n");
  const { problems } = await check(f);
  assert.deepEqual(problems, ["explanation workspace/output/numbers/01_counts.csv: the header must have name and value columns"]);
});

// ---------------------------------------------------------------------------
// The embed sources are byte-for-byte copies of the explanation's.

test("a _variables.yml that differs from the explanation's is a problem naming the file", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/_variables.yml"), 'm1_or_lspec: ".401"\nn_pages: "1234"\n# edited\n');
  assert.deepEqual((await check(f)).problems, [
    "workspace/_variables.yml differs from the explanation's workspace/output/assets/_variables.yml",
  ]);
});

test("a variables_sources.csv that differs from the explanation's is a problem naming the file", async (t) => {
  const f = fixture(t);
  const file = at(f.paper, "workspace/variables_sources.csv");
  put(file, readFileSync(file, "utf8").replace("n_pages,1234,1234,", "n_pages,1234,1234 ,"));
  assert.deepEqual((await check(f)).problems, [
    "workspace/variables_sources.csv differs from the explanation's workspace/output/assets/variables_sources.csv",
  ]);
});

test("a table fragment that differs from its counterpart is a problem naming the file", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/embeds/tables/T1.qmd"), "| changed |\n");
  assert.deepEqual((await check(f)).problems, [
    "workspace/embeds/tables/T1.qmd differs from the explanation's workspace/output/assets/T1.qmd",
  ]);
});

test("a table fragment with no counterpart in the explanation is a problem", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/embeds/tables/T9.qmd"), "| extra |\n");
  assert.deepEqual((await check(f)).problems, [
    "workspace/embeds/tables/T9.qmd has no counterpart in the explanation's workspace/output/assets/",
  ]);
});

test("a figure that differs from its counterpart is a problem naming the file", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/embeds/figures/F1.png"), "changed\n");
  assert.deepEqual((await check(f)).problems, [
    "workspace/embeds/figures/F1.png differs from the explanation's workspace/output/figures/F1.png",
  ]);
});

test("a figure with no counterpart in the explanation is a problem", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/embeds/figures/F9.png"), "extra\n");
  assert.deepEqual((await check(f)).problems, [
    "workspace/embeds/figures/F9.png has no counterpart in the explanation's workspace/output/figures/",
  ]);
});

// ---------------------------------------------------------------------------
// Includes and images: present, inside embeds/, not links, not empty.

test("an include through a symlink is refused by name, and the link is not read", async (t) => {
  const f = fixture(t);
  symlinkSync(at(f.paper, "workspace/embeds/tables/T1.qmd"), at(f.paper, "workspace/embeds/tables/Link.qmd"));
  put(at(f.paper, "workspace/paper.qmd"), `${PAPER_TEXT}\n{{< include embeds/tables/Link.qmd >}}\n`);
  const { problems } = await check(f);
  assert.ok(problems.includes("workspace/embeds/tables/Link.qmd is a link: refusing to use it"), problems.join("\n"));
  assert.ok(problems.every((problem) => problem.includes("Link.qmd is a link")), problems.join("\n"));
});

test("an include of a path outside workspace/embeds/ is a problem", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/paper.qmd"), `${PAPER_TEXT}\n{{< include ../../x.qmd >}}\n`);
  assert.deepEqual((await check(f)).problems, ["workspace/paper.qmd includes ../../x.qmd, which is outside workspace/embeds/"]);
});

test("an include and an image that are missing are each a problem", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/paper.qmd"), `${PAPER_TEXT}\n{{< include embeds/tables/Gone.qmd >}}\n\n![x](embeds/figures/Gone.png)\n`);
  assert.deepEqual((await check(f)).problems, [
    "workspace/paper.qmd includes embeds/tables/Gone.qmd, which is missing",
    "workspace/paper.qmd shows image embeds/figures/Gone.png, which is missing",
  ]);
});

test("an include whose fragment is empty is a problem", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/embeds/tables/T1.qmd"), "\n");
  put(at(f.explanation, "workspace/output/assets/T1.qmd"), "\n");
  assert.deepEqual((await check(f)).problems, ["workspace/paper.qmd includes embeds/tables/T1.qmd, which is empty"]);
});

// ---------------------------------------------------------------------------
// Quotations: verified, included, and never typed by hand.

test("a quote fragment that no include of the paper names is a problem", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/paper.qmd"), PAPER_TEXT.replace("{{< include embeds/quotes/Q01.qmd >}}\n", ""));
  assert.deepEqual((await check(f)).problems, ["workspace/embeds/quotes/Q01.qmd is not included by paper.qmd"]);
});

test("a hand-typed block quotation is a problem, and the numbers in it are not counted as bare numbers", async (t) => {
  const f = fixture(t);
  const text = `${PAPER_TEXT}\n> Rules of 12, 34, 56 and 78 kinds.\n`;
  put(at(f.paper, "workspace/paper.qmd"), text);
  const line = lineOf(text, "> Rules of 12, 34, 56 and 78 kinds.");
  assert.deepEqual(await check(f), {
    problems: [`workspace/paper.qmd line ${line}: a hand-typed block quotation; quote it with quote_source and include the fragment`],
    warnings: [],
  });
});

test("an altered quote fragment is a problem naming the quote", async (t) => {
  const f = fixture(t);
  const fragment = at(f.paper, "workspace/embeds/quotes/Q01.qmd");
  put(fragment, readFileSync(fragment, "utf8").replace("Be patient", "Be patien"));
  const { problems } = await check(f);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /^Q01: fragment Q01\.qmd is not the escaped form of lines 3-4 of handbook\/rules\.md/);
});

// ---------------------------------------------------------------------------
// Citations: numeric chunk ids while drafting, keys in references.bib once finalised.

test("a numeric chunk id is allowed while drafting, and check-citations runs on the draft", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/paper.qmd"), `${PAPER_TEXT}\nAs shown [@123].\n`);
  const seen: string[] = [];
  const result = await check(f, {
    citations: (file: string): string[] => {
      seen.push(file);
      return ["missing chunk id 123"];
    },
  });
  assert.deepEqual(result.problems, ["workspace/paper.qmd: missing chunk id 123"]);
  assert.equal(seen.length, 1);
  assert.ok(seen[0]?.endsWith(path.join("workspace", "paper.qmd")), seen.join("\n"));
});

test("a draft citation key that is neither a numeric chunk id nor in references.bib is a problem", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/paper.qmd"), `${PAPER_TEXT}\nAs shown [@smith2020].\n`);
  assert.deepEqual((await check(f)).problems, [
    "workspace/paper.qmd cites @smith2020, which is neither a numeric chunk id nor in references.bib",
  ]);
});

test("once references.bib exists, a numeric chunk id is a problem and check-citations is not run", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/paper.qmd"), `${PAPER_TEXT}\nAs shown [@123].\n`);
  put(at(f.paper, "workspace/references.bib"), "@article{smith2020,\n  title={A}\n}\n");
  let ran = false;
  const result = await check(f, {
    citations: (): string[] => {
      ran = true;
      return [];
    },
  });
  assert.deepEqual(result.problems, ["workspace/paper.qmd still cites chunk id @123 (references.bib exists: finalise the citations)"]);
  assert.equal(ran, false);
});

test("once references.bib exists, a key missing from it is a problem and a key in it is not", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/paper.qmd"), `${PAPER_TEXT}\nAs shown [@smith2020].\n`);
  put(at(f.paper, "workspace/references.bib"), "@article{jones2019,\n  title={A}\n}\n");
  assert.deepEqual((await check(f)).problems, ["workspace/paper.qmd cites @smith2020, which is not in references.bib"]);
  put(at(f.paper, "workspace/references.bib"), "@article{smith2020,\n  title={A}\n}\n");
  assert.deepEqual(await check(f), { problems: [], warnings: [] });
});

// ---------------------------------------------------------------------------
// The Predictions fragment: included, and the argument's Predictions text.

test("a paper that does not include the Predictions fragment is a problem", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/paper.qmd"), PAPER_TEXT.replace("{{< include embeds/predictions.qmd >}}\n", ""));
  assert.deepEqual((await check(f)).problems, ["workspace/paper.qmd does not include embeds/predictions.qmd"]);
});

test("a Predictions fragment that differs from the argument's Predictions section is a problem", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/embeds/predictions.qmd"), "Something else entirely.\n");
  assert.deepEqual((await check(f)).problems, ["workspace/embeds/predictions.qmd differs from the argument's ## Predictions section"]);
});

// ---------------------------------------------------------------------------
// The pins: present, readable, the reproduction record present, and current.

test("an edit to argument.md after the pin makes the pins stale", async (t) => {
  const f = fixture(t);
  const file = at(f.explanation, "workspace/argument.md");
  put(file, readFileSync(file, "utf8").replace("rather than by statement.", "rather than by statement, and so on."));
  assert.deepEqual((await check(f)).problems, ["stale: argumentSha changed since the paper was last pinned (repin_paper)"]);
});

test("a changed reproduction hash makes the pins stale", async (t) => {
  const f = fixture(t);
  put(at(f.run, "owners/phase-3/loop/E01/reproduction.json"), JSON.stringify({ ok: true, workspaceHash: "hash-two", mismatches: [] }));
  assert.deepEqual((await check(f)).problems, ["stale: workspaceHash changed since the paper was last pinned (repin_paper)"]);
});

test("a changed Predictions section makes the pins stale, and the fragment that follows it is not a problem", async (t) => {
  const f = fixture(t);
  const changed = "The hold-out sample should show a reversal.";
  const file = at(f.explanation, "workspace/argument.md");
  put(file, readFileSync(file, "utf8").replace(PREDICTIONS, changed));
  put(at(f.paper, "workspace/embeds/predictions.qmd"), `${changed}\n`);
  assert.deepEqual((await check(f)).problems, [
    "stale: argumentSha changed since the paper was last pinned (repin_paper)",
    "stale: predictionsSha changed since the paper was last pinned (repin_paper)",
  ]);
});

test("missing pins are a problem that names init_paper", async (t) => {
  const f = fixture(t);
  rmSync(at(f.paper, "workspace/checks/pins.json"));
  assert.deepEqual((await check(f)).problems, ["checks/pins.json is missing (run init_paper)"]);
});

test("unreadable pins are a problem naming the file", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/checks/pins.json"), "not json\n");
  const { problems } = await check(f);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /^checks\/pins\.json is unreadable: /);
});

test("a missing reproduction record is a problem, and the workspace hash is not compared", async (t) => {
  const f = fixture(t);
  rmSync(at(f.run, "owners/phase-3/loop/E01/reproduction.json"));
  assert.deepEqual((await check(f)).problems, [
    "owners/phase-3/loop/E01/reproduction.json is missing (the explanation has not been reproduced)",
  ]);
});

// ---------------------------------------------------------------------------
// Bare numbers: the limit from config, the detector's exclusions, the warnings below the limit.

test("three bare numbers in prose are a warning each, not a problem", async (t) => {
  const f = fixture(t);
  const text = `${PAPER_TEXT}\nCounts were 12, 34 and 56.\n`;
  put(at(f.paper, "workspace/paper.qmd"), text);
  const line = lineOf(text, "Counts were 12, 34 and 56.");
  assert.deepEqual(await check(f), {
    problems: [],
    warnings: [`workspace/paper.qmd line ${line}: bare number 12`, `workspace/paper.qmd line ${line}: bare number 34`, `workspace/paper.qmd line ${line}: bare number 56`],
  });
});

test("four bare numbers in prose are a problem listing them with their lines", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/paper.qmd"), `${PAPER_TEXT}\nCounts were 12, 34, 56 and 78.\n`);
  const { problems, warnings } = await check(f);
  assert.deepEqual(warnings, []);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /^workspace\/paper\.qmd has 4 bare numbers in prose \(limit 3\): line \d+ 12, line \d+ 34, line \d+ 56, line \d+ 78$/);
});

test("a year, and numbers in code, headings, includes, shortcodes and citation brackets, are not bare numbers", async (t) => {
  const f = fixture(t);
  const extra = [
    "In 1999 and 2050 the rule held, see `12 34`.",
    "",
    "```",
    "12 34 56 78",
    "```",
    "",
    "## Table 78",
    "",
    "The share is {{< var m1_or_lspec >}} [@123].",
    "",
  ].join("\n");
  put(at(f.paper, "workspace/paper.qmd"), `${PAPER_TEXT}\n${extra}`);
  assert.deepEqual(await check(f), { problems: [], warnings: [] });
});

test("the bare-number limit comes from config.json, and the option overrides it", async (t) => {
  const f = fixture(t);
  const text = `${PAPER_TEXT}\nCounts were 12.\n`;
  put(at(f.paper, "workspace/paper.qmd"), text);
  const line = lineOf(text, "Counts were 12.");
  put(at(f.run, "config.json"), JSON.stringify({ model: "test-model", phases: { "4": "harness/skills/phase-4" }, paperBareNumberLimit: 0 }));
  assert.deepEqual(await check(f, { bareNumberLimit: undefined }), {
    problems: [`workspace/paper.qmd has 1 bare number in prose (limit 0): line ${line} 12`],
    warnings: [],
  });
  assert.deepEqual(await check(f, { bareNumberLimit: 3 }), { problems: [], warnings: [`workspace/paper.qmd line ${line}: bare number 12`] });
});

// ---------------------------------------------------------------------------
// Warnings, and the hooks.

test("an author placeholder in the front matter is a warning, not a problem", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/paper.qmd"), PAPER_TEXT.replace('author: "Test Author"', 'author: "Author names to be added"'));
  assert.deepEqual(await check(f), {
    problems: [],
    warnings: ['workspace/paper.qmd\'s author is still the placeholder "Author names to be added"'],
  });
});

test("the outline problems come before the render problems, and both follow the other checks", async (t) => {
  const f = fixture(t);
  const result = await check(f, {
    outline: (): string[] => ["outline lists needs: send them in one reopen request"],
    render: async (): Promise<{ problems: string[] }> => ({ problems: ["render: T1 is empty"] }),
  });
  assert.deepEqual(result.problems, ["outline lists needs: send them in one reopen request", "render: T1 is empty"]);
});

test("an outline or render hook that throws is a problem, not a throw", async (t) => {
  const f = fixture(t);
  const result = await check(f, {
    outline: (): string[] => {
      throw new Error("boom");
    },
    render: async (): Promise<{ problems: string[] }> => {
      throw new Error("nope");
    },
  });
  assert.deepEqual(result.problems, ["outline check failed: boom", "render check failed: nope"]);
});

test("a nodeDir outside a run, or not a paper under an explanation, is a usage error that throws", async (t) => {
  const f = fixture(t);
  const outside = mkdtempSync(path.join(tmpdir(), "ctc-check-paper-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  await assert.rejects(checkPaper(f.run, outside, NO_CITATIONS), /is not a node folder inside the run/);
  await assert.rejects(checkPaper(f.run, f.explanation, NO_CITATIONS), /is not a paper under an explanation/);
});

// ---------------------------------------------------------------------------
// The CLI: `ok` or one problem per line, warnings first, usage errors exit 2.

test("the CLI prints ok and exits 0 for a complete paper", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [CHECK_PAPER, f.paper], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "ok\n");
});

test("the CLI prints warnings first, then ok, and still exits 0", (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/paper.qmd"), PAPER_TEXT.replace('author: "Test Author"', 'author: "Author names to be added"'));
  const result = spawnSync(process.execPath, [CHECK_PAPER, f.paper], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    result.stdout,
    'warning: workspace/paper.qmd\'s author is still the placeholder "Author names to be added"\nok\n',
  );
});

test("the CLI prints one problem per line and exits 1 for a bad paper", (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/paper.qmd"), `${PAPER_TEXT}\n{{< var k_missing >}}\n`);
  const result = spawnSync(process.execPath, [CHECK_PAPER, f.paper], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "variable k_missing is not in workspace/_variables.yml\n");
});

test("the CLI exits 2 on a usage error", (t) => {
  const f = fixture(t);
  assert.equal(spawnSync(process.execPath, [CHECK_PAPER], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [CHECK_PAPER, path.join(f.paper, "nowhere")], { encoding: "utf8" }).status, 2);
});
