// `check-paper` is the code gate in front of a paper's style passes and its submit: it reads the
// manuscript, the embed sources the paper copies from its explanation, the quotations, the
// citations, the Predictions and the pins, and says what is wrong. These tests pin each rule with
// one failing case. Every host-side read is without following a link: a symlinked include is refused
// by name. Citations are injected (the real check calls `deepis`); the CLI tests use a paper with no
// citations, so the default runner passes without a database.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { Exec } from "../analysis/run.ts";
import { prepareExploration } from "../analysis/run.ts";
import { renderDiagram } from "../paper/diagram.ts";
import { quoteSource } from "../paper/quotes.ts";
import { checkPaper } from "../tools/check-paper.ts";
import { createChild, findNode, initRun, updateNode } from "../tree.ts";

const CHECK_PAPER = fileURLToPath(new URL("../tools/check-paper.ts", import.meta.url));
/** The harness templates every paper carries a copy of; the fixture copies them, so a planted change is the only difference. */
const TEMPLATES = fileURLToPath(new URL("../templates/", import.meta.url));

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

/** An outline that omits nothing and needs nothing: the paper embeds the argument's one number, table and figure. */
const OUTLINE = ["# Outline", "", "## Sections", "Introduction, then the evidence.", "", "## Omitted", "", "## Needs", ""].join("\n");

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
  put(at(paper, "workspace/outline.md"), OUTLINE);
  for (const name of ["apa.csl", "_quarto.yml"]) put(at(paper, `workspace/${name}`), readFileSync(path.join(TEMPLATES, name)));
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

test("a year, an include, a shortcode and a citation bracket are not bare numbers", async (t) => {
  const f = fixture(t);
  const extra = [
    "In 1999 and 2050 the rule held.",
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

// ---------------------------------------------------------------------------
// Review round 1: the gate reads the raw paper. Quarto and pandoc render code spans, fences, comments and
// raw blocks, so nothing is hidden from it; a construct it cannot judge is a problem.

/** Whether the process may chmod away its own read access (root may read anything, so the probe would not bite). */
const ROOT = process.getuid?.() === 0;

/** The paper with `extra` appended to its prose. */
function withProse(f: Fixture, extra: string): void {
  put(at(f.paper, "workspace/paper.qmd"), `${PAPER_TEXT}\n${extra}\n`);
}

/** The paper with one front matter line added after the author line. */
function withFront(line: string): string {
  return PAPER_TEXT.replace('author: "Test Author"', `author: "Test Author"\n${line}`);
}

// Scanning is raw (review 1).

test("a variable in inline code is a variable: it must be in _variables.yml", async (t) => {
  const f = fixture(t);
  withProse(f, "`x {{< var v >}}`");
  assert.deepEqual((await check(f)).problems, ["variable v is not in workspace/_variables.yml"]);
});

test("a variable in a fence with an invalid opener is still a variable", async (t) => {
  const f = fixture(t);
  withProse(f, "``` a`b\n{{< var v >}}\n");
  const { problems } = await check(f);
  assert.ok(problems.some((p) => /line \d+: fenced code is not allowed/.test(p)), problems.join("\n"));
  assert.ok(problems.includes("variable v is not in workspace/_variables.yml"), problems.join("\n"));
});

test("a citation in inline code is a citation: a draft key must be numeric or in references.bib", async (t) => {
  const f = fixture(t);
  withProse(f, "`x [@smith2020]`");
  assert.deepEqual((await check(f)).problems, [
    "workspace/paper.qmd cites @smith2020, which is neither a numeric chunk id nor in references.bib",
  ]);
});

test("an image in inline code is an image: an unlisted image target is a problem", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/embeds/evil.png"), "arbitrary bytes\n");
  withProse(f, "`x ![i](embeds/evil.png)`");
  assert.deepEqual((await check(f)).problems, ["workspace/paper.qmd shows image embeds/evil.png, which is not an allowed embed"]);
});

// Raw constructs (review 2 and 6).

test("a fence with a code chunk info string is a problem naming its line", async (t) => {
  const f = fixture(t);
  withProse(f, "```{python}\nprint(1)\n```");
  const { problems } = await check(f);
  assert.ok(problems.some((p) => /^workspace\/paper\.qmd line \d+: fenced code is not allowed/.test(p)), problems.join("\n"));
});

test("a raw LaTeX block with \\input is a problem: the fence and the command both", async (t) => {
  const f = fixture(t);
  withProse(f, "```{=latex}\n\\input{x}\n```");
  const { problems } = await check(f);
  assert.ok(problems.some((p) => /line \d+: fenced code is not allowed/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /line \d+: TeX command \\input is not allowed/.test(p)), problems.join("\n"));
});

test("a tilde fence is a problem too", async (t) => {
  const f = fixture(t);
  withProse(f, "~~~\ncode\n~~~");
  const { problems } = await check(f);
  assert.ok(problems.some((p) => /fenced code is not allowed/.test(p)), problems.join("\n"));
});

test("raw HTML tags and comments are problems naming their lines", async (t) => {
  const f = fixture(t);
  withProse(f, "<span>x</span>\n<!-- hidden -->\n</div>");
  const { problems } = await check(f);
  for (const offset of [0, 1, 2]) {
    const line = PAPER_LINE + offset;
    assert.ok(problems.some((p) => p.startsWith(`workspace/paper.qmd line ${line}: raw HTML is not allowed`)), problems.join("\n"));
  }
});

test("a raw script element is a problem", async (t) => {
  const f = fixture(t);
  withProse(f, "<script>x</script>");
  const { problems } = await check(f);
  assert.ok(problems.some((p) => /raw HTML is not allowed/.test(p)), problems.join("\n"));
});

test("a bare < followed by a space or a digit is not HTML", async (t) => {
  const f = fixture(t);
  withProse(f, "The effect was p < .05, and x <3.");
  assert.deepEqual((await check(f)).problems, []);
});

test("each TeX command the list names is a problem", async (t) => {
  const f = fixture(t);
  const commands = ["input", "include", "write", "openin", "read", "immediate", "usepackage", "verbatiminput"];
  withProse(f, commands.map((name) => `\\${name}{x}`).join("\n"));
  const { problems } = await check(f);
  commands.forEach((name, index) => {
    assert.ok(problems.includes(`workspace/paper.qmd line ${PAPER_LINE + index}: TeX command \\${name} is not allowed`), problems.join("\n"));
  });
});

/** The first line of the prose `withProse` appends: the paper's line count before it, plus one. */
const PAPER_LINE = PAPER_TEXT.split("\n").length + 1;

// Shortcodes (review 3).

test("an env shortcode is a problem: it prints the environment", async (t) => {
  const f = fixture(t);
  withProse(f, "{{< env HOME >}}");
  assert.ok((await check(f)).problems.some((p) => /line \d+: shortcode env is not allowed \(only var and include\)/.test(p)));
});

test("a meta shortcode is a problem: it prints the title", async (t) => {
  const f = fixture(t);
  withProse(f, "{{< meta title >}}");
  assert.ok((await check(f)).problems.some((p) => /line \d+: shortcode meta is not allowed/.test(p)));
});

test("every other shortcode name is a problem too", async (t) => {
  const f = fixture(t);
  const names = ["kbd", "brand", "video", "embed", "pagebreak"];
  withProse(f, names.map((name) => `{{< ${name} x >}}`).join("\n"));
  const { problems } = await check(f);
  for (const name of names) {
    assert.ok(problems.some((p) => p.includes(`shortcode ${name} is not allowed`)), `${name}\n${problems.join("\n")}`);
  }
});

test("the var shortcode in the spellings Quarto accepts is a variable, with no problem", async (t) => {
  const f = fixture(t);
  withProse(f, "{{<var m1_or_lspec>}} and {{< var  n_pages >}} and {{< var\nm1_or_lspec >}}");
  assert.deepEqual(await check(f), { problems: [], warnings: [] });
});

test("a malformed var shortcode is a problem naming its line", async (t) => {
  const f = fixture(t);
  withProse(f, "{{< var >}}");
  assert.ok((await check(f)).problems.some((p) => /line \d+: malformed \{\{< shortcode/.test(p)));
});

test("a shortcode that never closes is a problem naming its line", async (t) => {
  const f = fixture(t);
  withProse(f, "The count {{< var n_pages");
  assert.ok((await check(f)).problems.some((p) => /line \d+: malformed \{\{< shortcode/.test(p)));
});

// Includes and images (review 2).

test("an include outside the allow-list is a problem, and its fragment is not counted", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/embeds/notes/n.qmd"), "Counted 12 34 56 78\n");
  withProse(f, "{{< include embeds/notes/n.qmd >}}");
  assert.deepEqual((await check(f)).problems, [
    "workspace/paper.qmd includes embeds/notes/n.qmd, which is not an allowed embed (embeds/tables/*.qmd, embeds/quotes/Q<nn>.qmd, embeds/predictions.qmd)",
  ]);
});

test("an image outside the allowed folders is a problem, whatever its bytes", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/embeds/evil.png"), "arbitrary bytes\n");
  withProse(f, "![x](embeds/evil.png)");
  assert.deepEqual((await check(f)).problems, ["workspace/paper.qmd shows image embeds/evil.png, which is not an allowed embed"]);
});

test("a reference-style image is a problem", async (t) => {
  const f = fixture(t);
  withProse(f, "![x][ref]\n\n[ref]: embeds/figures/F1.png");
  assert.ok((await check(f)).problems.some((p) => /reference-style image is not allowed/.test(p)));
});

test("an img element is a problem", async (t) => {
  const f = fixture(t);
  withProse(f, '<img src="../../x.png">');
  assert.ok((await check(f)).problems.some((p) => /raw HTML is not allowed/.test(p)));
});

test("a table fragment with a shortcode is a problem: fragments are scanned raw", async (t) => {
  const f = fixture(t);
  const table = "| a |\n{{< var m1_or_lspec >}}\n";
  put(at(f.paper, "workspace/embeds/tables/T1.qmd"), table);
  put(at(f.explanation, "workspace/output/assets/T1.qmd"), table);
  assert.ok((await check(f)).problems.some((p) => /^workspace\/embeds\/tables\/T1\.qmd: contains a \{\{< shortcode/.test(p)));
});

test("a table fragment with a fence is a problem", async (t) => {
  const f = fixture(t);
  const table = "| a |\n```\ncode\n```\n";
  put(at(f.paper, "workspace/embeds/tables/T1.qmd"), table);
  put(at(f.explanation, "workspace/output/assets/T1.qmd"), table);
  assert.ok((await check(f)).problems.some((p) => /^workspace\/embeds\/tables\/T1\.qmd: contains fenced code/.test(p)));
});

// Hand-typed block quotations (review 5).

test("a block quotation in a list item is a hand-typed quotation", async (t) => {
  const f = fixture(t);
  withProse(f, "- > Rules of the house.");
  assert.ok((await check(f)).problems.some((p) => /line \d+: a hand-typed block quotation/.test(p)));
});

test("a numbered or starred list item with a quotation is a hand-typed quotation", async (t) => {
  const f = fixture(t);
  withProse(f, "1. > Rules of the house.\n  * > More rules.");
  const { problems } = await check(f);
  assert.equal(problems.filter((p) => /hand-typed block quotation/.test(p)).length, 1, problems.join("\n"));
});

// Bare numbers (review 4). Every probe runs at limit 0, so one number is one count.

test("a number in link text counts", async (t) => {
  const f = fixture(t);
  withProse(f, "[40 12 56 78](https://example.org/a)");
  const { problems } = await check(f, { bareNumberLimit: 0 });
  assert.ok(problems.some((p) => p.startsWith("workspace/paper.qmd has 4 bare numbers in prose (limit 0)")), problems.join("\n"));
});

test("a number in an image caption counts", async (t) => {
  const f = fixture(t);
  withProse(f, "![The 40 12 56 78 share](embeds/figures/F1.png)");
  const { problems } = await check(f, { bareNumberLimit: 0 });
  assert.ok(problems.some((p) => p.startsWith("workspace/paper.qmd has 4 bare numbers in prose (limit 0)")), problems.join("\n"));
});

test("numbers in a citation bracket count: only the key is blanked", async (t) => {
  const f = fixture(t);
  withProse(f, "[12 34 56 78, @smith2020]");
  const { problems } = await check(f, { bareNumberLimit: 0, citations: (): string[] => [] });
  assert.ok(problems.some((p) => p.startsWith("workspace/paper.qmd has 4 bare numbers in prose (limit 0)")), problems.join("\n"));
});

test("a number in a non-identifier attribute-looking text counts", async (t) => {
  const f = fixture(t);
  withProse(f, "{# 12 34 56 78 }");
  const { problems } = await check(f, { bareNumberLimit: 0 });
  assert.ok(problems.some((p) => p.startsWith("workspace/paper.qmd has 4 bare numbers in prose (limit 0)")), problems.join("\n"));
});

test("numbers with letters or a percent sign after them count", async (t) => {
  const f = fixture(t);
  withProse(f, "12x 95th 12e6 12ms");
  const { problems } = await check(f, { bareNumberLimit: 0 });
  assert.ok(problems.some((p) => p.startsWith("workspace/paper.qmd has 4 bare numbers in prose (limit 0)")), problems.join("\n"));
});

test("numbers in the front matter's values count", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/paper.qmd"), withFront('abstract: "Forty 12 34 56 78 cases"'));
  const { problems } = await check(f, { bareNumberLimit: 0 });
  assert.ok(problems.some((p) => p.startsWith("workspace/paper.qmd has 4 bare numbers in prose (limit 0)")), problems.join("\n"));
});

test("a number in a heading counts", async (t) => {
  const f = fixture(t);
  withProse(f, "## Table 78");
  const { problems } = await check(f, { bareNumberLimit: 0 });
  assert.ok(problems.some((p) => /has 1 bare number in prose \(limit 0\): line \d+ 78$/.test(p)), problems.join("\n"));
});

test("a year and a cross-reference id are not counted", async (t) => {
  const f = fixture(t);
  withProse(f, "In 1999 and 2050 see @fig-12 and {#tbl-12}.");
  assert.deepEqual(await check(f, { bareNumberLimit: 0, citations: (): string[] => [] }), { problems: [], warnings: [] });
});

// Front matter (review 6).

test("a front matter key outside the allow-list is a problem", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/paper.qmd"), withFront("filters:\n  - x.lua"));
  assert.deepEqual((await check(f)).problems, ["workspace/paper.qmd front matter key filters is not allowed"]);
});

test("each Quarto key that can run code or inject markup is a problem", async (t) => {
  const f = fixture(t);
  const keys = ["include-in-header", "include-before-body", "execute", "format", "resources"];
  put(at(f.paper, "workspace/paper.qmd"), withFront(keys.map((key) => `${key}: x`).join("\n")));
  const { problems } = await check(f);
  for (const key of keys) assert.ok(problems.includes(`workspace/paper.qmd front matter key ${key} is not allowed`), problems.join("\n"));
});

test("a bibliography other than references.bib is a problem", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/paper.qmd"), PAPER_TEXT.replace("bibliography: references.bib", "bibliography: other.bib"));
  assert.deepEqual((await check(f)).problems, ["workspace/paper.qmd front matter bibliography must be references.bib"]);
});

test("a csl other than apa.csl is a problem", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/paper.qmd"), withFront("csl: other.csl"));
  assert.deepEqual((await check(f)).problems, ["workspace/paper.qmd front matter csl must be apa.csl"]);
});

test("every allowed front matter key passes", async (t) => {
  const f = fixture(t);
  const allowed = [
    'subtitle: "A plain subtitle"',
    "keywords:\n  - etiquette",
    'abstract: "Plain words only"',
    'date: "October"',
    "lang: en",
    "toc: true",
    "number-sections: true",
    "fig-cap-location: bottom",
    "tbl-cap-location: top",
    "link-citations: true",
    "csl: apa.csl",
  ];
  put(at(f.paper, "workspace/paper.qmd"), withFront(allowed.join("\n")));
  assert.deepEqual(await check(f), { problems: [], warnings: [] });
});

// The workspace root (review 6): no Quarto project file, extension or filter the writer could plant.

test("a _metadata.yml, an _extensions folder, a lua filter and a stylesheet in the workspace root are each a problem", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/_metadata.yml"), "filters: [x.lua]\n");
  mkdirSync(at(f.paper, "workspace/_extensions/x"), { recursive: true });
  put(at(f.paper, "workspace/filter.lua"), "-- lua\n");
  put(at(f.paper, "workspace/style.css"), "p {}\n");
  const { problems } = await check(f);
  for (const name of ["_metadata.yml", "_extensions", "filter.lua", "style.css"]) {
    assert.ok(problems.some((p) => p.startsWith(`workspace/${name} is not allowed`)), `${name}\n${problems.join("\n")}`);
  }
});

// Quotations and citations (minor 9 and 10).

test("an @ in a URL is not a citation", async (t) => {
  const f = fixture(t);
  withProse(f, "See https://x.org/@user for details.");
  assert.deepEqual(await check(f), { problems: [], warnings: [] });
});

test("a Unicode citation key is read whole: [@müller2020] is the key müller2020", async (t) => {
  const f = fixture(t);
  withProse(f, "As [@müller2020] shows.");
  assert.deepEqual((await check(f)).problems, [
    "workspace/paper.qmd cites @müller2020, which is neither a numeric chunk id nor in references.bib",
  ]);
});

test("a quoted include path is accepted", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/paper.qmd"), PAPER_TEXT.replace("{{< include embeds/tables/T1.qmd >}}", '{{< include "embeds/tables/T1.qmd" >}}'));
  assert.deepEqual(await check(f), { problems: [], warnings: [] });
});

test("a quoted include outside embeds/ names the path it refuses", async (t) => {
  const f = fixture(t);
  withProse(f, '{{< include "../../x.qmd" >}}');
  assert.ok((await check(f)).problems.includes("workspace/paper.qmd includes ../../x.qmd, which is outside workspace/embeds/"));
});

// The Predictions fragment is byte for byte (review 8).

test("a Predictions fragment with leading spaces is a problem", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/embeds/predictions.qmd"), `  ${PREDICTIONS}\n`);
  assert.deepEqual((await check(f)).problems, ["workspace/embeds/predictions.qmd differs from the argument's ## Predictions section"]);
});

test("a Predictions fragment with trailing blank lines is a problem", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/embeds/predictions.qmd"), `${PREDICTIONS}\n\n`);
  assert.deepEqual((await check(f)).problems, ["workspace/embeds/predictions.qmd differs from the argument's ## Predictions section"]);
});

test("a Predictions fragment with CRLF endings is a problem", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/embeds/predictions.qmd"), `${PREDICTIONS}\r\n`);
  assert.deepEqual((await check(f)).problems, ["workspace/embeds/predictions.qmd differs from the argument's ## Predictions section"]);
});

// Never throws (review 7).

test("an unreadable embeds folder is a problem naming it, and checkPaper does not throw", { skip: ROOT }, async (t) => {
  const f = fixture(t);
  const embeds = at(f.paper, "workspace/embeds");
  chmodSync(embeds, 0o000);
  try {
    const { problems } = await check(f);
    assert.ok(
      problems.some((p) => p.includes("workspace/embeds") && /cannot be read: EACCES|cannot be listed/.test(p)),
      problems.join("\n"),
    );
  } finally {
    chmodSync(embeds, 0o755);
  }
});

test("the CLI exits 1, not 2, for an unreadable embeds folder", { skip: ROOT }, (t) => {
  const f = fixture(t);
  const embeds = at(f.paper, "workspace/embeds");
  chmodSync(embeds, 0o000);
  try {
    const result = spawnSync(process.execPath, [CHECK_PAPER, f.paper], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /workspace\/embeds/);
  } finally {
    chmodSync(embeds, 0o755);
  }
});

// ---------------------------------------------------------------------------
// Round 2: Quarto renders an include only when it stands alone. Probed with Quarto 1.9.37 (paper.qmd rendered from a
// project folder with embeds/): on its own line after a blank line, the table renders; inside a text line it renders as
// nothing, with a `Shortcode 'include' not found` warning; directly after a text line it renders as nothing and no
// warning is logged. Whitespace around the shortcode on its line is fine.

test("an include inside a text line is a problem naming its line", async (t) => {
  const f = fixture(t);
  withProse(f, "Text {{< include embeds/tables/T1.qmd >}} more.");
  const { problems } = await check(f);
  const line = PAPER_TEXT.split("\n").length + 1;
  assert.ok(
    problems.includes(
      `workspace/paper.qmd line ${line}: an include must stand alone on its own line; Quarto renders one inside a text line as nothing`,
    ),
    problems.join("\n"),
  );
});

test("an include directly after a text line, with no blank line before it, is a problem naming its line", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/paper.qmd"), `${PAPER_TEXT}\nAfter the table.\n{{< include embeds/tables/T1.qmd >}}\n`);
  const { problems } = await check(f);
  const line = `${PAPER_TEXT}\nAfter the table.\n{{< include embeds/tables/T1.qmd >}}\n`.split("\n").length - 1;
  assert.ok(
    problems.includes(
      `workspace/paper.qmd line ${line}: an include must follow a blank line; Quarto renders one directly after a text line as nothing`,
    ),
    problems.join("\n"),
  );
});

test("an include after a blank line, at the start of the body, or after the front matter is not a placement problem", async (t) => {
  const f = fixture(t);
  put(
    at(f.paper, "workspace/paper.qmd"),
    '---\ntitle: "T"\n---\n{{< include embeds/tables/T1.qmd >}}\n\nText.\n\n{{< include embeds/tables/T1.qmd >}}\n',
  );
  const { problems } = await check(f);
  assert.deepEqual(
    problems.filter((p) => /stand alone|follow a blank line/.test(p)),
    [],
    problems.join("\n"),
  );
});

// The Quarto-backed claim: the render, not my reading of its documentation, decides what an include does.

const QUARTO_PRESENT = spawnSync("quarto", ["--version"], { encoding: "utf8" }).status === 0;

test(
  "Quarto renders a table include that stands alone and renders nothing for one inside a text line; check-paper refuses the inline one",
  { skip: QUARTO_PRESENT ? false : "quarto is not installed on this host", timeout: 600_000 },
  async (t) => {
    const project = mkdtempSync(path.join(tmpdir(), "ctc-check-paper-quarto-"));
    t.after(() => rmSync(project, { recursive: true, force: true }));
    put(path.join(project, "_quarto.yml"), "project:\n  type: default\n");
    put(path.join(project, "embeds", "tables", "T1.qmd"), "| Group | N |\n|---|---|\n| A | 12 |\n");
    put(
      path.join(project, "own.qmd"),
      '---\ntitle: "Own line"\n---\n\nBefore the table.\n\n{{< include embeds/tables/T1.qmd >}}\n\nAfter the table.\n',
    );
    put(path.join(project, "inline.qmd"), '---\ntitle: "Inline"\n---\n\nText {{< include embeds/tables/T1.qmd >}} more.\n');

    const tablesIn = (name: string): number => {
      const render = spawnSync("quarto", ["render", name, "--to", "html"], { cwd: project, encoding: "utf8" });
      assert.equal(render.status, 0, render.stdout + render.stderr);
      return (readFileSync(path.join(project, `${name.replace(/\.qmd$/, "")}.html`), "utf8").match(/<table/g) ?? []).length;
    };
    assert.equal(tablesIn("own.qmd"), 1, "a stand-alone include renders its table");
    assert.equal(tablesIn("inline.qmd"), 0, "an include inside a text line renders nothing");

    // Round 3: the spellings the checker refuses render nothing; the two it accepts each render their table.
    const spelled = (name: string, spellings: string[]): void =>
      put(path.join(project, name), `---\ntitle: "${name}"\n---\n\n${spellings.join("\n\n")}\n\nAfter.\n`);
    spelled("dropped.qmd", DROPPED_INCLUDES);
    spelled("accepted.qmd", ["{{< include embeds/tables/T1.qmd >}}", '{{< include "embeds/tables/T1.qmd" >}}']);
    assert.equal(tablesIn("dropped.qmd"), 0, "each spelling the checker refuses renders nothing");
    assert.equal(tablesIn("accepted.qmd"), 2, "the bare and the quoted spellings each render their table");

    const f = fixture(t);
    withProse(f, "Text {{< include embeds/tables/T1.qmd >}} more.");
    const { problems } = await check(f);
    assert.ok(
      problems.some((p) => /an include must stand alone on its own line/.test(p)),
      problems.join("\n"),
    );

    for (const text of DROPPED_INCLUDES) {
      const g = fixture(t);
      withProse(g, text);
      assert.ok((await check(g)).problems.some((p) => /malformed \{\{< shortcode/.test(p)), JSON.stringify(text));
    }
  },
);

// ---------------------------------------------------------------------------
// Round 3 (review of the fix diff). Each probe was run against the checker, and against Quarto where the claim is
// about rendering.

// Include spellings (ruling 1): only `{{< include X >}}` and `{{< include "X" >}}`, with single spaces, are includes.
// Quarto 1.9.37 renders the other spellings below as nothing, with exit 0 and no warning; the checker refuses them.

const DROPPED_INCLUDES = [
  "{{< include embeds/tables/T1.qmd>}}",
  "{{<include embeds/tables/T1.qmd >}}",
  "{{<include embeds/tables/T1.qmd>}}",
  '{{< include "embeds/tables/T1.qmd">}}',
  "{{< include\nembeds/tables/T1.qmd >}}",
];

test("each include spelling Quarto drops is a malformed shortcode problem naming its line", async (t) => {
  for (const text of DROPPED_INCLUDES) {
    const f = fixture(t);
    withProse(f, text);
    const { problems } = await check(f);
    assert.ok(
      problems.some((p) => p.startsWith(`workspace/paper.qmd line ${PAPER_LINE}: malformed {{< shortcode`)),
      `${JSON.stringify(text)}\n${problems.join("\n")}`,
    );
  }
});

test("the two include spellings Quarto renders, bare and quoted with single spaces, are not malformed", async (t) => {
  const f = fixture(t);
  withProse(f, '{{< include embeds/tables/T1.qmd >}}\n\n{{< include "embeds/tables/T1.qmd" >}}');
  assert.deepEqual((await check(f)).problems, []);
});

// Math (ruling 2): a span pandoc reads as math is not raw HTML. Currency is not math, and code is not math.

test("inline and display math that Quarto renders are not raw HTML: $x<y$, $x<5$, $$x<y$$, \\(x<n\\)", async (t) => {
  const f = fixture(t);
  withProse(f, "Let $x<y$ and $x<5$ hold, $$x<y$$ too, and \\(x<n\\) as well.");
  assert.deepEqual(await check(f), { problems: [], warnings: [] });
});

test("currency does not hide raw HTML: a $ amount beside a tag is still refused", async (t) => {
  const f = fixture(t);
  withProse(f, "costs $5 <script>x</script> and $10\n$5 <b>x</b> $10");
  const { problems } = await check(f);
  assert.ok(problems.some((p) => p.startsWith(`workspace/paper.qmd line ${PAPER_LINE}: raw HTML is not allowed`)), problems.join("\n"));
  assert.ok(problems.some((p) => p.startsWith(`workspace/paper.qmd line ${PAPER_LINE + 1}: raw HTML is not allowed`)), problems.join("\n"));
});

test("an unclosed $ is not math: $x<y with no closing $ is raw HTML", async (t) => {
  const f = fixture(t);
  withProse(f, "The value $x<y is open.");
  assert.ok((await check(f)).problems.some((p) => /raw HTML is not allowed/.test(p)));
});

test("a $ in inline code does not open math over a tag after the code", async (t) => {
  const f = fixture(t);
  withProse(f, "`$` <script>x</script> $y$\n`$` <script>x</script>$y$");
  const { problems } = await check(f);
  for (const offset of [0, 1]) {
    assert.ok(problems.some((p) => p.startsWith(`workspace/paper.qmd line ${PAPER_LINE + offset}: raw HTML is not allowed`)), problems.join("\n"));
  }
});

test("a $ followed by a space or a letter is not a closing $: a tag between two currency signs is still refused", async (t) => {
  const f = fixture(t);
  withProse(f, "costs $5 <script>x</script> and $ten\ncosts $5 <b>x</b> and $ok");
  const { problems } = await check(f);
  for (const offset of [0, 1]) {
    assert.ok(problems.some((p) => p.startsWith(`workspace/paper.qmd line ${PAPER_LINE + offset}: raw HTML is not allowed`)), problems.join("\n"));
  }
});

test("display math does not run across a blank line", async (t) => {
  const f = fixture(t);
  withProse(f, "$$ a\n\n<script>x</script>\n\n$$");
  const { problems } = await check(f);
  assert.ok(problems.some((p) => p.startsWith(`workspace/paper.qmd line ${PAPER_LINE + 2}: raw HTML is not allowed`)), problems.join("\n"));
});

test("a link target is not math: a $ in a URL does not hide a tag inside it", async (t) => {
  const f = fixture(t);
  withProse(f, "[t](http://x.org/$<b>$)");
  assert.ok((await check(f)).problems.some((p) => /raw HTML is not allowed/.test(p)));
});

// Include placement (ruling 3): a heading or a fenced-div opener directly above an include is fine; a list item, a
// figure line or a text line is not.

test("an include directly after a heading or a fenced-div opener needs no blank line", async (t) => {
  const f = fixture(t);
  withProse(f, "## Results {#sec-results}\n{{< include embeds/tables/T1.qmd >}}\n\n::: {.callout-note}\n{{< include embeds/tables/T1.qmd >}}\n:::");
  assert.deepEqual(await check(f), { problems: [], warnings: [] });
});

test("an include directly after a list item or a figure line is still refused", async (t) => {
  const f = fixture(t);
  withProse(f, "- item\n{{< include embeds/tables/T1.qmd >}}\n![x](embeds/figures/F1.png)\n{{< include embeds/tables/T1.qmd >}}");
  const { problems } = await check(f);
  for (const offset of [1, 3]) {
    assert.ok(
      problems.includes(
        `workspace/paper.qmd line ${PAPER_LINE + offset}: an include must follow a blank line; Quarto renders one directly after a text line as nothing`,
      ),
      problems.join("\n"),
    );
  }
});

// Citation locators (minor 4): `p.`, `pp.`, `chap.` and `sec.` with their numbers inside a citation bracket are not
// bare numbers. The same digits outside a bracket still count, and so do the other numbers in a bracket.

test("a locator inside a citation bracket is not a bare number", async (t) => {
  const f = fixture(t);
  withProse(f, "As [@smith2020, p. 123] and [see @jones2019, pp. 12-14, chap. 3, sec. 2] show.");
  const { problems } = await check(f, { bareNumberLimit: 0 });
  assert.ok(!problems.some((p) => /bare number/.test(p)), problems.join("\n"));
});

test("a locator in a bracket with no citation still counts its number", async (t) => {
  const f = fixture(t);
  withProse(f, "Plain [see p. 78] text.");
  const { problems } = await check(f, { bareNumberLimit: 0 });
  assert.ok(/has 1 bare number in prose \(limit 0\): line \d+ 78$/.test(problems.join("\n")), problems.join("\n"));
});

test("the same locator digits outside a bracket still count, and so do the other numbers in a bracket", async (t) => {
  const f = fixture(t);
  withProse(f, "As [@smith2020] shows p. 123 and pp. 12-14.\n\nAnd [12 34, @jones2019, p. 56] too.");
  const { problems } = await check(f, { bareNumberLimit: 0 });
  assert.ok(
    problems.some((p) => /has 5 bare numbers in prose \(limit 0\): line \d+ 123, line \d+ 12, line \d+ 14, line \d+ 12, line \d+ 34/.test(p)),
    problems.join("\n"),
  );
});

// The date in the front matter (minor 5): an ISO date value is a date, not bare numbers. A date in the prose still counts.

test("an ISO date value in the front matter is not counted, quoted or not", async (t) => {
  for (const line of ["date: 2026-10-26", 'date: "2026-10-26"']) {
    const f = fixture(t);
    put(at(f.paper, "workspace/paper.qmd"), withFront(line));
    assert.deepEqual(await check(f, { bareNumberLimit: 0 }), { problems: [], warnings: [] }, line);
  }
});

test("an ISO date in the prose still counts its month and day", async (t) => {
  const f = fixture(t);
  withProse(f, "Filed 2026-10-26.");
  const { problems } = await check(f, { bareNumberLimit: 0 });
  assert.ok(/has 2 bare numbers in prose \(limit 0\): line \d+ 10, line \d+ 26$/.test(problems.join("\n")), problems.join("\n"));
});

// ---------------------------------------------------------------------------
// The outline: coverage of the argument's links, and ## Needs until a reopen has run (Task 8).

test("an argument link the paper neither embeds nor omits is a check-paper problem", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/paper.qmd"), PAPER_TEXT.replace("{{< var m1_or_lspec >}}", "{{< var n_pages >}}"));
  const problems = (await check(f)).problems;
  assert.ok(
    problems.includes(
      "argument.md links output/numbers/12_model1.csv#m1, which paper.qmd does not embed and ## Omitted does not list",
    ),
    problems.join("\n"),
  );
});

test("a non-empty ## Needs blocks check-paper until a reopen has run, and an empty one does not", async (t) => {
  const f = fixture(t);
  const needs = OUTLINE.replace("## Needs\n", "## Needs\n- the per-page rate of the subject-to-change class\n");
  put(at(f.paper, "workspace/outline.md"), needs);
  assert.deepEqual((await check(f)).problems, ["outline lists needs: send them in one reopen request"]);
  put(at(f.paper, "workspace/checks/pins.json"), pins(ARGUMENT, "hash-one", PREDICTIONS).replace('"reopens": 0', '"reopens": 1'));
  assert.deepEqual(await check(f), { problems: [], warnings: [] });
});

test("a paper with no outline is a check-paper problem naming it", async (t) => {
  const f = fixture(t);
  rmSync(at(f.paper, "workspace/outline.md"));
  assert.deepEqual((await check(f)).problems, ["workspace/outline.md is missing"]);
});

test("a paper whose _quarto.yml differs from the harness template is a problem naming the file", async (t) => {
  const f = fixture(t);
  const template = readFileSync(path.join(TEMPLATES, "_quarto.yml"), "utf8");
  put(at(f.paper, "workspace/_quarto.yml"), template.replace("execute:", "filters:\n  - ./planted.lua\nexecute:"));
  assert.deepEqual((await check(f)).problems, ["workspace/_quarto.yml differs from the explanation's harness/templates/_quarto.yml"]);
});

test("a paper whose apa.csl differs from the harness template, or lacks one, is a problem", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/apa.csl"), "<style/>\n");
  assert.deepEqual((await check(f)).problems, ["workspace/apa.csl differs from the explanation's harness/templates/apa.csl"]);
  rmSync(at(f.paper, "workspace/apa.csl"));
  assert.deepEqual((await check(f)).problems, ["workspace/apa.csl is missing"]);
});

// ---------------------------------------------------------------------------
// The theory diagrams (Task 9): a PNG is the rendering the render tool recorded, and a spec edited since makes it stale.

const DIAGRAM_SPEC = [
  "nodes:",
  "  - id: example",
  "    label: The first example",
  "    claim: Explanation",
  "  - id: copy",
  "    label: Readers copy it",
  "    claim: Mechanism and scope",
  "edges:",
  "  - from: example",
  "    to: copy",
  "    claim: Mechanism and scope",
  "",
].join("\n");

/** A fake `dot` that writes the PNG bytes into the folder it is given, as the paper image would. */
function fakeDot(): Exec {
  return async (args) => {
    const mount = args[args.indexOf("-v") + 1] ?? "";
    writeFileSync(path.join(mount.slice(0, mount.lastIndexOf(":/work")), "theory.png"), "png bytes");
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
}

test("a rendered diagram that matches its record is clean; a spec edited since makes it stale", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/embeds/diagrams/theory.yml"), DIAGRAM_SPEC);
  await renderDiagram(f.run, f.paper, "theory", fakeDot());
  assert.deepEqual(await check(f), { problems: [], warnings: [] });
  put(at(f.paper, "workspace/embeds/diagrams/theory.yml"), DIAGRAM_SPEC.replace("Readers copy it", "Readers copy"));
  assert.deepEqual((await check(f)).problems, ["diagram theory is stale: render_diagram again"]);
});

test("a PNG no render recorded is a problem, and so is a diagrams.json that is garbage", async (t) => {
  const f = fixture(t);
  put(at(f.paper, "workspace/embeds/diagrams/theory.png"), "hand-made");
  assert.deepEqual((await check(f)).problems, [
    "workspace/embeds/diagrams/diagrams.json is missing (diagrams were not rendered by render_diagram)",
  ]);
  put(at(f.paper, "workspace/embeds/diagrams/diagrams.json"), "garbage");
  assert.ok((await check(f)).problems.some((p) => /diagrams\.json is unreadable/.test(p)));
});

test("the render check's problems come out as the paper's problems", async (t) => {
  const f = fixture(t);
  const warning = "workspace/paper.qmd render: [WARNING] Citeproc: citation 1 not found";
  const render = async () => ({ problems: [warning] });
  assert.deepEqual(await check(f, { render }), { problems: [warning], warnings: [] });
});
