// The outline (`workspace/outline.md`) and its coverage (design §7.1, §8.4): every link of the explanation's
// `argument.md` that names a number, table or figure is embedded in the paper or listed under `## Omitted` with a
// reason, and `## Needs` blocks the paper until a reopen has run. These tests pin each rule with one failing case.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { coverage, parseOutline } from "../paper/outline.ts";

interface Fixture {
  run: string;
  explanation: string;
  paper: string;
}

function put(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A run with explanation E01 and paper W01 under it. Each test writes the pieces it needs. */
function fixture(t: TestContext): Fixture {
  const run = mkdtempSync(path.join(tmpdir(), "ctc-outline-"));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  const explanation = path.join(run, "explanations", "E01-crowd");
  const paper = path.join(explanation, "papers", "W01-crowd");
  mkdirSync(paper, { recursive: true });
  return { run, explanation, paper };
}

/** The argument, with one number, one table and one figure linked from its Evidence section. */
const ARGUMENT = [
  "Contribution: theoretical",
  "",
  "## Evidence",
  "The share is [.401](output/numbers/12_model1.csv#m1) of the pages.",
  "The count is [1234](output/numbers/01_counts.csv#n) in all.",
  "See [the table](output/tables/A_01_file_classes.csv) and [the figure](output/figures/F1.png).",
  "A [link](https://example.com/paper) and a [note](../notes.md) are not evidence.",
  "",
  "## Predictions",
  "The held-back split should agree.",
  "",
].join("\n");

const SOURCES = [
  "variable,value,rendered,source",
  "m1_or_lspec,0.401,.401,output/numbers/12_model1.csv#m1",
  "n_pages,1234,1234,output/numbers/01_counts.csv#n",
  "",
].join("\n");

/** A paper with every target embedded: the share through its variable, the count, the table and the figure. */
const EMBEDS_ALL = [
  "---",
  'title: "Crowd"',
  "---",
  "",
  "The share is {{< var m1_or_lspec >}} of {{< var n_pages >}} pages.",
  "",
  "{{< include embeds/tables/A_01_file_classes.qmd >}}",
  "",
  "![The figure](embeds/figures/F1.png)",
  "",
].join("\n");

function outlineText(sections: string, omitted: string[], needs: string[]): string {
  return [
    "# Outline",
    "",
    "## Sections",
    sections,
    "",
    "## Omitted",
    ...omitted,
    "",
    "## Needs",
    ...needs,
    "",
  ].join("\n");
}

/** Writes the argument, the sources, the paper and its outline; `paperText` and `outline` default to the complete ones. */
function build(f: Fixture, o: { paperText?: string; outline?: string; argument?: string; pins?: string } = {}): void {
  put(path.join(f.explanation, "workspace", "argument.md"), o.argument ?? ARGUMENT);
  put(path.join(f.paper, "workspace", "paper.qmd"), o.paperText ?? EMBEDS_ALL);
  put(path.join(f.paper, "workspace", "variables_sources.csv"), SOURCES);
  put(path.join(f.paper, "workspace", "outline.md"), o.outline ?? outlineText("Introduction, then the evidence.", [], []));
  rmSync(path.join(f.paper, "workspace", "checks", "pins.json"), { force: true });
  if (o.pins !== undefined) put(path.join(f.paper, "workspace", "checks", "pins.json"), o.pins);
}

// ---------------------------------------------------------------------------
// parseOutline

test("parseOutline reads the three sections, the omissions and the needs", () => {
  const parsed = parseOutline(
    outlineText("Intro and evidence.", ["- output/numbers/B_03.csv#range_cc_pp — the range is not in the argument's claim"], ["- the per-page rate"]),
  );
  assert.deepEqual(parsed, {
    sections: "Intro and evidence.",
    omitted: [{ target: "output/numbers/B_03.csv#range_cc_pp", reason: "the range is not in the argument's claim" }],
    needs: ["the per-page rate"],
  });
});

test("parseOutline is null when a heading is missing", () => {
  assert.equal(parseOutline("## Sections\nText\n## Omitted\n"), null);
  assert.equal(parseOutline("## Sections\nText\n## Needs\n"), null);
  assert.equal(parseOutline("# Outline only\n"), null);
});

test("parseOutline keeps an omission with no reason, so coverage can name it", () => {
  const parsed = parseOutline(outlineText("", ["- output/tables/A_01_file_classes.csv"], []));
  assert.deepEqual(parsed?.omitted, [{ target: "output/tables/A_01_file_classes.csv", reason: "" }]);
});

test("parseOutline reads 'None.' as no needs and no omissions", () => {
  const parsed = parseOutline(outlineText("", ["None."], ["None."]));
  assert.deepEqual(parsed?.omitted, []);
  assert.deepEqual(parsed?.needs, []);
});

// ---------------------------------------------------------------------------
// coverage

test("coverage: every target embedded (a number through its variable) is no problem", (t) => {
  const f = fixture(t);
  build(f);
  assert.deepEqual(coverage(f.run, f.paper), { covered: 4, problems: [] });
});

test("coverage: an argument target neither embedded nor omitted is named", (t) => {
  const f = fixture(t);
  build(f, { paperText: EMBEDS_ALL.replace("{{< var n_pages >}}", "") });
  const result = coverage(f.run, f.paper);
  assert.deepEqual(result.problems, [
    "argument.md links output/numbers/01_counts.csv#n, which paper.qmd does not embed and ## Omitted does not list",
  ]);
});

test("coverage: an omission with an empty reason is a problem naming it", (t) => {
  const f = fixture(t);
  build(f, {
    paperText: EMBEDS_ALL.replace("{{< var n_pages >}}", ""),
    outline: outlineText("", ["- output/numbers/01_counts.csv#n —   "], []),
  });
  assert.deepEqual(coverage(f.run, f.paper), {
    covered: 3,
    problems: ["outline ## Omitted: output/numbers/01_counts.csv#n has no reason"],
  });
});

test("coverage: an omission that is also embedded is a problem", (t) => {
  const f = fixture(t);
  build(f, { outline: outlineText("", ["- output/numbers/01_counts.csv#n — not needed here"], []) });
  assert.deepEqual(coverage(f.run, f.paper).problems, [
    "outline ## Omitted: output/numbers/01_counts.csv#n is embedded in paper.qmd, so it is not omitted",
  ]);
});

test("coverage: an omission naming a target the argument does not have is a problem", (t) => {
  const f = fixture(t);
  build(f, { outline: outlineText("", ["- output/numbers/B_03.csv#range_cc_pp — the range"], []) });
  assert.deepEqual(coverage(f.run, f.paper).problems, [
    "outline ## Omitted names output/numbers/B_03.csv#range_cc_pp, which argument.md does not link as a number, table or figure",
  ]);
});

test("coverage: an omitted link that is not a coverage target (a URL, a note) is a problem", (t) => {
  const f = fixture(t);
  build(f, { outline: outlineText("", ["- https://example.com/paper — the paper it is"], []) });
  assert.deepEqual(coverage(f.run, f.paper).problems, [
    "outline ## Omitted names https://example.com/paper, which argument.md does not link as a number, table or figure",
  ]);
});

test("coverage: a table is covered by an include and a figure by an image of the same name", (t) => {
  const f = fixture(t);
  build(f, { paperText: EMBEDS_ALL.replace("{{< include embeds/tables/A_01_file_classes.qmd >}}", "") });
  assert.deepEqual(coverage(f.run, f.paper).problems, [
    "argument.md links output/tables/A_01_file_classes.csv, which paper.qmd does not embed and ## Omitted does not list",
  ]);
});

test("coverage: a figure is not covered by an include, and a number is not covered by a variable of another source", (t) => {
  const f = fixture(t);
  build(f, {
    paperText: EMBEDS_ALL.replace("![The figure](embeds/figures/F1.png)", "{{< include embeds/tables/F1.qmd >}}").replace(
      "{{< var m1_or_lspec >}}",
      "{{< var n_pages >}}",
    ),
  });
  assert.deepEqual(coverage(f.run, f.paper).problems, [
    "argument.md links output/figures/F1.png, which paper.qmd does not embed and ## Omitted does not list",
    "argument.md links output/numbers/12_model1.csv#m1, which paper.qmd does not embed and ## Omitted does not list",
  ]);
});

test("coverage: a valid omission covers its target", (t) => {
  const f = fixture(t);
  build(f, {
    paperText: EMBEDS_ALL.replace("{{< var n_pages >}}", ""),
    outline: outlineText("", ["- output/numbers/01_counts.csv#n — a count of the pages, not a finding"], []),
  });
  assert.deepEqual(coverage(f.run, f.paper), { covered: 4, problems: [] });
});

test("coverage: a missing outline names it, and the other targets are not checked", (t) => {
  const f = fixture(t);
  build(f);
  rmSync(path.join(f.paper, "workspace", "outline.md"));
  assert.deepEqual(coverage(f.run, f.paper).problems, ["workspace/outline.md is missing"]);
});

test("coverage: an outline without its headings is named", (t) => {
  const f = fixture(t);
  build(f, { outline: "## Sections\nText\n" });
  assert.deepEqual(coverage(f.run, f.paper).problems, [
    "workspace/outline.md is missing a ## Sections, ## Omitted or ## Needs heading",
  ]);
});

test("coverage: a non-empty ## Needs is a problem until a reopen has run", (t) => {
  const f = fixture(t);
  const needs = outlineText("", [], ["- the per-page rate of the subject-to-change class"]);
  const pins = (reopens: number): string => JSON.stringify({ reopens, outlineShaAtReopen: null }) + "\n";
  build(f, { outline: needs, pins: pins(0) });
  assert.deepEqual(coverage(f.run, f.paper).problems, ["outline lists needs: send them in one reopen request"]);
  build(f, { outline: needs, pins: pins(1) });
  assert.deepEqual(coverage(f.run, f.paper).problems, []);
  build(f, { outline: needs });
  assert.deepEqual(coverage(f.run, f.paper).problems, ["outline lists needs: send them in one reopen request"]);
});

test("coverage: links to URLs and to files outside output/ are not targets", (t) => {
  const f = fixture(t);
  build(f, {
    argument: "## Evidence\nSee [a](https://example.com) and [b](../notes.md) and [c](output/logs/x.txt).\n\n## Predictions\nNone.\n",
  });
  assert.deepEqual(coverage(f.run, f.paper), { covered: 0, problems: [] });
});
