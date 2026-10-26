// The paper's project scaffold (`init_paper`), its pins, its authors, the `deepis bib` finalisation and the
// re-pin after a reopen (design §4, §5.6, §9; plan Task 10). The fixtures are real runs (`initRun`, `createChild`),
// so the explanation and its paper are the nodes the tools see. Every test names the rule it pins.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { argumentSha } from "../explain/rounds.ts";
import { finalizeBib, initPaper, repinPaper } from "../paper/project.ts";
import { checkPaper } from "../tools/check-paper.ts";
import { sectionText } from "../tools/check-argument.ts";
import { createChild, findNode, initRun, updateNode } from "../tree.ts";

const TEMPLATES = fileURLToPath(new URL("../templates/", import.meta.url));
const DPKW_CSL = path.join(process.env.HOME ?? "", "Development", "dpkw-text-reuse", "apa.csl");

const PREDICTIONS = "The hold-out sample should show the same ordering.";

const ARGUMENT = [
  "Contribution: theoretical",
  "",
  "## Explanation",
  "Etiquette rules travel by example rather than by statement.",
  "",
  "## Evidence",
  "The share is [.401](output/numbers/12_model1.csv#m1) of the sampled pages.",
  "",
  "## Alternatives considered",
  "The timing account is ruled out by the ordering.",
  "",
  "## Predictions",
  PREDICTIONS,
  "",
  "## Limitations",
  "The snapshot cannot show causality.",
  "",
].join("\n");

const ASSETS: Record<string, string> = {
  "_variables.yml": 'm1_or_lspec: ".401"\n',
  "variables_sources.csv": "variable,value,rendered,source\nm1_or_lspec,0.401,.401,output/numbers/12_model1.csv#m1\n",
  "T1.qmd": "| Group | N |\n|---|---|\n| A | 12 |\n",
};
const FIGURE = "figure bytes\n";

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
 * A run with explanation E01 in phase 4 (its argument, registry, assets, table, figure, reproduction and report) and
 * its paper W01 created under it, not yet initialised. `phase` is the explanation's phase when the paper is made.
 */
function fixture(t: TestContext, phase = 4): Fixture {
  const run = mkdtempSync(path.join(tmpdir(), "ctc-paper-project-"));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  const dataset = mkdtempSync(path.join(tmpdir(), "ctc-paper-project-dataset-"));
  t.after(() => rmSync(dataset, { recursive: true, force: true }));
  initRun(run, dataset, "interest");
  createChild(run, "D01", "Self Presentation", "owner-p1");
  createChild(run, "T01", "status quo: crowd", "owner-p2");
  createChild(run, "P01", "Explanation of crowd", "owner-p3", [], "explanation");
  updateNode(run, "E01", { phase: 3, status: "active" }, "owner-p3");
  updateNode(run, "E01", { phase: 4, status: "ready" }, "owner-p3");
  createChild(run, "E01", "Paper of crowd", "owner-p4", [], "paper");
  if (phase !== 4) updateNode(run, "E01", { phase: 3, status: "ready" }, "owner-p4");
  put(path.join(run, "config.json"), JSON.stringify({ model: "test-model", phases: { "4": "harness/skills/phase-4" } }, null, 2));

  const explanation = findNode(run, "E01").dir;
  const paper = findNode(run, "W01").dir;
  put(at(explanation, "workspace/argument.md"), ARGUMENT);
  put(at(explanation, "workspace/output/numbers/12_model1.csv"), "name,value,note\nm1,0.401,\n");
  for (const [name, text] of Object.entries(ASSETS)) put(at(explanation, `workspace/output/assets/${name}`), text);
  put(at(explanation, "workspace/output/figures/F1.png"), FIGURE);
  put(at(explanation, "workspace/scripts/A_01.R"), "# analysis\n");
  put(at(explanation, "workspace/archive/A_02/README.md"), "# Archived: A_02.R\n\nReason: superseded by A_03\n\nMoved here from:\n");
  put(at(explanation, "workspace/reviews/report.md"), REPORT);
  put(
    at(run, "owners/phase-3/loop/E01/rounds.json"),
    JSON.stringify(
      [
        {
          round: 1,
          changed: true,
          argumentSha: sha256("x"),
          summary: "The mechanism section now states the copying step.\nSecond line.",
          letters: ["A"],
        },
      ],
      null,
      2,
    ) + "\n",
  );
  put(
    at(run, "owners/phase-3/loop/E01/reproduction.json"),
    JSON.stringify({ ok: true, workspaceHash: "hash-one", mismatches: [] }, null, 2) + "\n",
  );
  return { run, explanation, paper };
}

const REPORT = [
  "## Citation fidelity",
  "Result: ok",
  "",
  "## Number provenance",
  "Result: ok",
  "",
  "## Overclaiming",
  "Result: concerns",
  "",
  "## Abductive honesty",
  "Result: ok",
  "",
  "## Findings",
  "- [F1] [major] Limitations: the snapshot cannot show causality, so the claim is narrower.",
  "- [F2] [minor] Evidence: the share needs its denominator.",
  "",
  "Status: DONE",
  "",
].join("\n");

/** The text of a paper file (under `workspace/`). */
function read(paper: string, rel: string): string {
  return readFileSync(at(paper, `workspace/${rel}`), "utf8");
}

// ---------------------------------------------------------------------------
// initPaper

test("initPaper creates every file of the scaffold, copying the explanation's assets, tables and figures", (t) => {
  const f = fixture(t);
  const summary = initPaper(f.run, f.paper);
  assert.match(summary, /W01/);
  for (const rel of [
    "workspace/paper.qmd",
    "workspace/outline.md",
    "workspace/_variables.yml",
    "workspace/variables_sources.csv",
    "workspace/apa.csl",
    "workspace/_quarto.yml",
    "workspace/embeds/tables/T1.qmd",
    "workspace/embeds/figures/F1.png",
    "workspace/embeds/predictions.qmd",
    "workspace/checks/pins.json",
    "workspace/audit/index.md",
  ]) {
    assert.ok(existsSync(at(f.paper, rel)), `${rel} is created`);
  }
  assert.equal(read(f.paper, "_variables.yml"), ASSETS["_variables.yml"]);
  assert.equal(read(f.paper, "embeds/tables/T1.qmd"), ASSETS["T1.qmd"]);
  assert.equal(read(f.paper, "embeds/figures/F1.png"), FIGURE);
  assert.equal(read(f.paper, "apa.csl"), readFileSync(path.join(TEMPLATES, "apa.csl"), "utf8"));
  assert.equal(read(f.paper, "_quarto.yml"), readFileSync(path.join(TEMPLATES, "_quarto.yml"), "utf8"));
  assert.equal(read(f.paper, "outline.md"), "# Outline\n\n## Sections\n\n## Omitted\n\n## Needs\n");
});

test("the skeleton's front matter has only allow-listed keys, and its headings and predictions include are in place", (t) => {
  const f = fixture(t);
  initPaper(f.run, f.paper);
  const qmd = read(f.paper, "paper.qmd");
  assert.match(qmd, /^---\ntitle: "[^"]+"\nauthor:\n  - "Author names to be added"\nbibliography: references\.bib\ncsl: apa\.csl\n---\n/);
  for (const heading of [
    "# Introduction",
    "# Conceptual Background",
    "# Research Method",
    "# Findings",
    "# Theory Development",
    "# Discussion",
    "# Conclusion",
    "# Appendix",
    "# References",
  ]) {
    assert.ok(qmd.split("\n").includes(heading) || qmd.includes(`${heading} {`), `${heading} is a section`);
  }
  assert.ok(qmd.includes("## What the held-back split could contradict\n\n{{< include embeds/predictions.qmd >}}\n"));
});

test("the predictions fragment is the argument's Predictions section and a newline, byte for byte", (t) => {
  const f = fixture(t);
  initPaper(f.run, f.paper);
  assert.equal(read(f.paper, "embeds/predictions.qmd"), `${sectionText(ARGUMENT, "Predictions")}\n`);
  assert.equal(read(f.paper, "embeds/predictions.qmd"), `${PREDICTIONS}\n`);
});

test("initPaper copies no link: a linked table or figure is refused, and nothing is written", (t) => {
  const f = fixture(t);
  const target = path.join(f.run, "elsewhere.qmd");
  writeFileSync(target, "secret\n");
  symlinkSync(target, at(f.explanation, "workspace/output/assets/Linked.qmd"));
  assert.throws(() => initPaper(f.run, f.paper), /link/);
  assert.equal(existsSync(at(f.paper, "workspace/paper.qmd")), false);
  assert.equal(existsSync(at(f.paper, "workspace/embeds")), false);

  rmSync(at(f.explanation, "workspace/output/assets/Linked.qmd"));
  symlinkSync(target, at(f.explanation, "workspace/output/figures/Linked.png"));
  assert.throws(() => initPaper(f.run, f.paper), /link/);
  assert.equal(existsSync(at(f.paper, "workspace/embeds/figures/Linked.png")), false);
});

test("initPaper is idempotent: a second call changes nothing that exists", (t) => {
  const f = fixture(t);
  initPaper(f.run, f.paper);
  const before = snapshot(f.paper);
  writeFileSync(at(f.paper, "workspace/paper.qmd"), "# Written by the writer\n");
  const again = initPaper(f.run, f.paper);
  assert.match(again, /created 0/);
  assert.equal(read(f.paper, "paper.qmd"), "# Written by the writer\n");
  const after = snapshot(f.paper);
  assert.deepEqual([...after].filter(([name]) => name !== "workspace/paper.qmd"), [...before].filter(([name]) => name !== "workspace/paper.qmd"));
});

/** Every file under the paper, with its bytes. */
function snapshot(paper: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${rel}/`);
      else files.set(rel, readFileSync(path.join(dir, entry.name), "utf8"));
    }
  };
  walk(path.join(paper, "workspace"), "workspace/");
  return files;
}

test("the pins record the explanation's current hashes, and the reopen count", (t) => {
  const f = fixture(t);
  initPaper(f.run, f.paper);
  assert.deepEqual(JSON.parse(read(f.paper, "checks/pins.json")), {
    argumentSha: argumentSha(f.explanation),
    workspaceHash: "hash-one",
    predictionsSha: sha256(PREDICTIONS),
    reopens: 0,
    outlineShaAtReopen: null,
  });
});

test("initPaper refuses an explanation that is not in phase 4", (t) => {
  const f = fixture(t, 3);
  assert.throws(() => initPaper(f.run, f.paper), /phase 3, not phase 4/);
  assert.equal(existsSync(at(f.paper, "workspace/paper.qmd")), false);
});

test("the audit index holds no prose: one line per round, plain lists of scripts and reasons, finding ids and severities", (t) => {
  const f = fixture(t);
  initPaper(f.run, f.paper);
  assert.equal(
    read(f.paper, "audit/index.md"),
    [
      "# Audit index",
      "",
      "## Rounds",
      "",
      "- round 01 | changed: yes | reopen: 0 | stop: none",
      "",
      "## Kept scripts",
      "",
      "- scripts/A_01.R",
      "",
      "## Archived scripts",
      "",
      "- archive/A_02: superseded by A_03",
      "",
      "## Review findings",
      "",
      "- F1 [major]",
      "- F2 [minor]",
      "",
    ].join("\n"),
  );
});

// ---------------------------------------------------------------------------
// The skeleton and check-paper

test("the skeleton passes check-paper except for the coverage problems an empty paper has, and warns about the author", async (t) => {
  const f = fixture(t);
  initPaper(f.run, f.paper);
  const result = await checkPaper(f.run, f.paper, { citations: () => [] });
  assert.deepEqual(result.problems, [
    "argument.md links output/numbers/12_model1.csv#m1, which paper.qmd does not embed and ## Omitted does not list",
  ]);
  assert.deepEqual(result.warnings, ['workspace/paper.qmd\'s author is still the placeholder "Author names to be added"']);
});

// ---------------------------------------------------------------------------
// Authors

test("the authors file is used for the front matter when present", (t) => {
  const f = fixture(t);
  put(path.join(f.run, "authors.yml"), "# the researcher's authors\n- Ada Lovelace\nCharles Babbage\n\n");
  initPaper(f.run, f.paper);
  const qmd = read(f.paper, "paper.qmd");
  assert.match(qmd, /author:\n  - "Ada Lovelace"\n  - "Charles Babbage"\n/);
  assert.doesNotMatch(qmd, /Author names to be added/);
});

test("an authors file with no names keeps the visible placeholder", (t) => {
  const f = fixture(t);
  put(path.join(f.run, "authors.yml"), "# none yet\n\n");
  initPaper(f.run, f.paper);
  assert.match(read(f.paper, "paper.qmd"), /Author names to be added/);
});

test("a linked authors file falls back to the placeholder, and the summary says so", (t) => {
  const f = fixture(t);
  const target = path.join(f.run, "elsewhere-authors.yml");
  put(target, "- Ada Lovelace\n");
  symlinkSync(target, path.join(f.run, "authors.yml"));
  const summary = initPaper(f.run, f.paper);
  assert.match(summary, /^warning: authors\.yml is a link: using the placeholder$/m);
  assert.match(read(f.paper, "paper.qmd"), /Author names to be added/);
  assert.doesNotMatch(read(f.paper, "paper.qmd"), /Ada Lovelace/);
});

test("an unreadable authors file falls back to the placeholder, and the summary says so", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads every file");
  const f = fixture(t);
  put(path.join(f.run, "authors.yml"), "- Ada Lovelace\n");
  chmodSync(path.join(f.run, "authors.yml"), 0o000);
  const summary = initPaper(f.run, f.paper);
  assert.match(summary, /^warning: authors\.yml cannot be read/m);
  assert.match(read(f.paper, "paper.qmd"), /Author names to be added/);
});

// ---------------------------------------------------------------------------
// finalizeBib

const PAPER_WITH_CITES = [
  "---",
  'title: "Crowd"',
  "bibliography: references.bib",
  "csl: apa.csl",
  "---",
  "",
  "Copying is common [@123] and has a range of [@456, p. 3].",
  "",
  "The share is {{< var m1_or_lspec >}}.",
  "",
  "{{< include embeds/tables/T1.qmd >}}",
  "",
].join("\n");

/** A fake `deepis bib`: rewrites each chunk id to a key, and writes the bib the keys come from. */
function fakeDeepis(paper: string, rewrite: (qmd: string) => string, bib: string | undefined) {
  return (args: string[]): { code: number; stderr: string } => {
    assert.deepEqual(args, ["bib", "paper.qmd"]);
    const file = at(paper, "workspace/paper.qmd");
    writeFileSync(file, rewrite(readFileSync(file, "utf8")));
    if (bib !== undefined) writeFileSync(at(paper, "workspace/references.bib"), bib);
    return { code: 0, stderr: "" };
  };
}

const GOOD_REWRITE = (qmd: string): string => qmd.replace("[@123]", "[@smith2020]").replace("[@456,", "[@jones2011,");
const GOOD_BIB = "@article{smith2020,\n  title = {Copying}\n}\n\n@book{jones2011,\n  title = {Crowds}\n}\n";

function paperWithCites(f: Fixture): void {
  put(at(f.paper, "workspace/paper.qmd"), PAPER_WITH_CITES);
}

test("finalizeBib: chunk ids rewritten to keys in references.bib, with the embeds unchanged, is no problem", (t) => {
  const f = fixture(t);
  initPaper(f.run, f.paper);
  paperWithCites(f);
  assert.deepEqual(finalizeBib(f.run, f.paper, fakeDeepis(f.paper, GOOD_REWRITE, GOOD_BIB)), []);
  assert.match(read(f.paper, "paper.qmd"), /\[@smith2020\]/);
});

test("finalizeBib: a key missing from references.bib is a problem naming it", (t) => {
  const f = fixture(t);
  initPaper(f.run, f.paper);
  paperWithCites(f);
  const problems = finalizeBib(f.run, f.paper, fakeDeepis(f.paper, GOOD_REWRITE, "@article{smith2020,\n  title = {Copying}\n}\n"));
  assert.deepEqual(problems, ["citation @jones2011 is not in references.bib"]);
});

test("finalizeBib: a chunk id still cited after the run is a problem naming it", (t) => {
  const f = fixture(t);
  initPaper(f.run, f.paper);
  paperWithCites(f);
  const problems = finalizeBib(f.run, f.paper, fakeDeepis(f.paper, (qmd) => qmd.replace("[@123]", "[@smith2020]"), GOOD_BIB));
  assert.ok(problems.includes("chunk id @456 is still cited (not rewritten to a key)"), problems.join("\n"));
});

test("finalizeBib: an embed lost in the rewrite is a problem, and the citations are counted", (t) => {
  const f = fixture(t);
  initPaper(f.run, f.paper);
  paperWithCites(f);
  const dropped = (qmd: string): string => GOOD_REWRITE(qmd).replace("{{< var m1_or_lspec >}}", "0.401");
  const problems = finalizeBib(f.run, f.paper, fakeDeepis(f.paper, dropped, GOOD_BIB));
  assert.deepEqual(problems, ["deepis bib changed an embed: variable m1_or_lspec: 1 before, 0 after"]);
  assert.equal(read(f.paper, "paper.qmd"), PAPER_WITH_CITES, "the manuscript is restored byte for byte");

  paperWithCites(f);
  const extra = (qmd: string): string => GOOD_REWRITE(qmd).replace("[@jones2011, p. 3]", "[@jones2011, p. 3] [@jones2011]");
  assert.deepEqual(finalizeBib(f.run, f.paper, fakeDeepis(f.paper, extra, GOOD_BIB)), [
    "deepis bib changed the number of citations: 2 before, 3 after",
  ]);
});

test("finalizeBib: a failing deepis is a problem naming its exit code", (t) => {
  const f = fixture(t);
  initPaper(f.run, f.paper);
  paperWithCites(f);
  const problems = finalizeBib(f.run, f.paper, () => ({ code: 3, stderr: "no database\n" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /deepis bib paper\.qmd failed \(exit 3\): no database/);
});

// ---------------------------------------------------------------------------
// repinPaper

test("repinPaper refuses until the outline changed since the reopen, and then writes the new pins", (t) => {
  const f = fixture(t);
  initPaper(f.run, f.paper);
  const outlineAtReopen = sha256(read(f.paper, "outline.md"));
  // The reopen: the explanation goes back to phase 3 and returns to phase 4 ready with a second reopen record.
  updateNode(f.run, "E01", { phase: 3, status: "ready" }, "owner-p4");
  updateNode(f.run, "E01", { phase: 4, status: "ready" }, "owner-p3");
  put(at(f.paper, "workspace/checks/pins.json"), JSON.stringify({ ...JSON.parse(read(f.paper, "checks/pins.json")), reopens: 1, outlineShaAtReopen: outlineAtReopen }, null, 2));
  assert.throws(() => repinPaper(f.run, f.paper), /outline\.md has not changed/);

  put(at(f.paper, "workspace/outline.md"), "# Outline\n\n## Sections\nRevised.\n\n## Omitted\n\n## Needs\n");
  put(at(f.run, "owners/phase-3/loop/E01/reproduction.json"), JSON.stringify({ ok: true, workspaceHash: "hash-two", mismatches: [] }) + "\n");
  const summary = repinPaper(f.run, f.paper);
  assert.match(summary, /W01/);
  assert.deepEqual(JSON.parse(read(f.paper, "checks/pins.json")), {
    argumentSha: argumentSha(f.explanation),
    workspaceHash: "hash-two",
    predictionsSha: sha256(PREDICTIONS),
    reopens: 0,
    outlineShaAtReopen: null,
  });
});

/** The reopen of the explanation: the paper's pins take the outline as it stands, and the explanation goes back to phase 4 ready. */
function reopenExplanation(f: Fixture): void {
  const outlineAtReopen = sha256(read(f.paper, "outline.md"));
  updateNode(f.run, "E01", { phase: 3, status: "ready" }, "owner-p4");
  updateNode(f.run, "E01", { phase: 4, status: "ready" }, "owner-p3");
  put(at(f.paper, "workspace/checks/pins.json"), JSON.stringify({ ...JSON.parse(read(f.paper, "checks/pins.json")), reopens: 1, outlineShaAtReopen: outlineAtReopen }, null, 2));
  put(at(f.paper, "workspace/outline.md"), "# Outline\n\n## Sections\nRevised.\n\n## Omitted\n\n## Needs\n");
}

/** The problems check-paper gives for the paper's generated copies (the copies of the explanation's assets, tables and figures). */
function copyProblemsOf(problems: string[]): string[] {
  return problems.filter((line) => /(differs from|has no counterpart|is missing|is a link|not a regular file)/.test(line));
}

test("repinPaper refreshes the generated copies from the reopened explanation, and check-paper's copy comparisons pass again", async (t) => {
  const f = fixture(t);
  initPaper(f.run, f.paper);
  // The reopen revises the explanation's outputs: a variable, a new table fragment, and the figure is gone.
  const assets = {
    "_variables.yml": 'm1_or_lspec: ".401"\nm2_or_lspec: ".512"\n',
    "variables_sources.csv": "variable,value,rendered,source\nm1_or_lspec,0.401,.401,output/numbers/12_model1.csv#m1\nm2_or_lspec,0.512,.512,output/numbers/12_model1.csv#m1\n",
  };
  for (const [name, text] of Object.entries(assets)) put(at(f.explanation, `workspace/output/assets/${name}`), text);
  put(at(f.explanation, "workspace/output/assets/T2.qmd"), "| Group | N |\n|---|---|\n| B | 9 |\n");
  rmSync(at(f.explanation, "workspace/output/figures/F1.png"));
  reopenExplanation(f);

  const stale = await checkPaper(f.run, f.paper, { citations: () => [] });
  assert.ok(copyProblemsOf(stale.problems).length > 0, "the stale copies are problems before the repin");

  repinPaper(f.run, f.paper);
  for (const [name, text] of Object.entries(assets)) assert.equal(read(f.paper, name), text);
  assert.equal(read(f.paper, "embeds/tables/T2.qmd"), "| Group | N |\n|---|---|\n| B | 9 |\n");
  assert.equal(existsSync(at(f.paper, "workspace/embeds/figures/F1.png")), false, "the figure the explanation no longer has is removed");

  const after = await checkPaper(f.run, f.paper, { citations: () => [] });
  assert.deepEqual(copyProblemsOf(after.problems), []);
  assert.deepEqual(after.problems, [
    "argument.md links output/numbers/12_model1.csv#m1, which paper.qmd does not embed and ## Omitted does not list",
  ]);
});

test("repinPaper refuses a linked table or figure of the explanation, and writes nothing", (t) => {
  const f = fixture(t);
  initPaper(f.run, f.paper);
  reopenExplanation(f);
  const target = path.join(f.run, "elsewhere.qmd");
  writeFileSync(target, "secret\n");
  const before = snapshot(f.paper);

  symlinkSync(target, at(f.explanation, "workspace/output/assets/Linked.qmd"));
  assert.throws(() => repinPaper(f.run, f.paper), /link/);
  assert.deepEqual(snapshot(f.paper), before);

  rmSync(at(f.explanation, "workspace/output/assets/Linked.qmd"));
  symlinkSync(target, at(f.explanation, "workspace/output/figures/Linked.png"));
  assert.throws(() => repinPaper(f.run, f.paper), /link/);
  assert.deepEqual(snapshot(f.paper), before);
  assert.equal(existsSync(at(f.paper, "workspace/embeds/tables/Linked.qmd")), false);
});

test("repinPaper refuses when the Predictions changed, and when no reopen is pinned", (t) => {
  const f = fixture(t);
  initPaper(f.run, f.paper);
  assert.throws(() => repinPaper(f.run, f.paper), /no reopen is pinned/);

  const outlineAtReopen = sha256(read(f.paper, "outline.md"));
  put(at(f.paper, "workspace/checks/pins.json"), JSON.stringify({ ...JSON.parse(read(f.paper, "checks/pins.json")), reopens: 1, outlineShaAtReopen: outlineAtReopen }));
  updateNode(f.run, "E01", { phase: 3, status: "ready" }, "owner-p4");
  updateNode(f.run, "E01", { phase: 4, status: "ready" }, "owner-p3");
  put(at(f.paper, "workspace/outline.md"), "# Outline\n\n## Sections\nRevised.\n\n## Omitted\n\n## Needs\n");
  put(at(f.explanation, "workspace/argument.md"), ARGUMENT.replace(PREDICTIONS, "A different prediction."));
  assert.throws(() => repinPaper(f.run, f.paper), /Predictions/);
});

test("repinPaper refuses an explanation that is not back in phase 4 ready", (t) => {
  const f = fixture(t);
  initPaper(f.run, f.paper);
  put(at(f.paper, "workspace/checks/pins.json"), JSON.stringify({ ...JSON.parse(read(f.paper, "checks/pins.json")), reopens: 1, outlineShaAtReopen: "a".repeat(64) }));
  updateNode(f.run, "E01", { phase: 3, status: "ready" }, "owner-p4");
  assert.throws(() => repinPaper(f.run, f.paper), /not phase 4 ready/);
});

// ---------------------------------------------------------------------------
// The templates

test("the harness templates are dpkw's apa.csl and a _quarto.yml with only the bibliography, csl, formats and execute keys", () => {
  if (existsSync(DPKW_CSL)) assert.equal(readFileSync(path.join(TEMPLATES, "apa.csl")).equals(readFileSync(DPKW_CSL)), true);
  assert.equal(
    readFileSync(path.join(TEMPLATES, "_quarto.yml"), "utf8"),
    [
      "bibliography: references.bib",
      "csl: apa.csl",
      "",
      "format:",
      "  html:",
      "    embed-resources: true",
      "  docx: default",
      "",
      "execute:",
      "  enabled: false",
      "",
    ].join("\n"),
  );
});
