// `check-argument` is the code gate in front of an explanation's end gate: it
// reads the node's `argument.md`, its literature reports, its registry and its
// variables, and says what is missing. These tests pin each rule with one
// failing case, and the host-side reads: every file under `workspace/output/`
// and `workspace/archive/` is worker-writable, so a link, a planted folder or a
// `..` escape is refused by name and never read through.
//
// Citations are injected in the unit tests (the real check calls `deepis`); the
// CLI tests use prose with no citations and no quotation marks, so the default
// runner passes without a database.
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { argumentLinks, checkArgument, checkRevision, parseReport } from "../tools/check-argument.ts";
import { initRun } from "../tree.ts";

const CHECK_ARGUMENT = fileURLToPath(new URL("../tools/check-argument.ts", import.meta.url));

/** No citation problems: the unit tests never reach `deepis`. */
const NO_CITATIONS = { citations: (): string[] => [] };

const ARGUMENT_HEADINGS = [
  "## Explanation",
  "## Mechanism and scope",
  "## What would count against it",
  "## Alternatives considered",
  "## Evidence",
  "## Limitations",
  "## Predictions",
];

const REPORT_HEADINGS = [
  "## What the results are",
  "## Literature on these results",
  "## Rival and artifact accounts",
  "## What else should be true",
  "## Measurement precedents",
  "## Implications for the argument",
];

const ARGUMENT_FILE = path.join("workspace", "argument.md");

/** A complete argument: every heading, the contribution line, links to the registry and a report. */
function argument(): string {
  return [
    "Contribution: theoretical",
    "",
    "## Explanation",
    "Etiquette rules travel by example rather than by statement.",
    "",
    "## Mechanism and scope",
    "Readers copy the first example they meet; the claim covers the handbook corpus only.",
    "",
    "## What would count against it",
    "Rules stated in full on the opening pages of the handbooks.",
    "",
    "## Alternatives considered",
    "The timing account is ruled out by the ordering in the registry.",
    "",
    "## Evidence",
    "The share is [.401](output/numbers/12_model1.csv#m1) of the sampled pages, and the sample is [1234](output/numbers/01_counts.csv#n) pages long.",
    "The literature is in [report one](reports/01.md).",
    "",
    "## Limitations",
    "The snapshot cannot show causality.",
    "",
    "## Predictions",
    "The hold-out sample should show the same ordering.",
    "",
  ].join("\n");
}

/** A complete literature report for round 1. */
function report(round = "Round: 1"): string {
  const lines = [round, ""];
  for (const heading of REPORT_HEADINGS) lines.push(heading, "Two sources on the ordering were read.", "");
  return lines.join("\n");
}

/** A review report in the fixed format: four check headings, findings, and a closing status. */
function review(): string {
  return [
    "## Citation fidelity",
    "Result: ok",
    "Every quoted sentence is in its chunk.",
    "",
    "## Number provenance",
    "Result: concerns",
    "The sample count is not in the registry.",
    "",
    "## Overclaiming",
    "Result: ok",
    "The claim stays within the corpus.",
    "",
    "## Abductive honesty",
    "Result: ok",
    "The argument names its rivals.",
    "",
    "## Findings",
    "- [F1] [major] Number provenance: the sample count has no registry row.",
    "- [F2] [minor] Overclaiming: the scope sentence is broad.",
    "",
    "Status: DONE_WITH_CONCERNS",
    "",
  ].join("\n");
}

/** The argument with `lines` placed under its Explanation heading. */
function withExplanation(...lines: string[]): string {
  return argument().replace("## Explanation\n", `## Explanation\n${lines.join("\n")}\n`);
}

/** The text with one canonical heading demoted to prose. */
function withoutHeading(markdown: string, heading: string): string {
  return markdown.replace(`${heading}\n`, `${heading.replace("## ", "")}\n`);
}

/** The text with one canonical section's body emptied (its heading stays). */
function emptySection(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.indexOf(heading);
  assert.ok(start >= 0, `${heading} is in the text`);
  let end = lines.findIndex((line, at) => at > start && /^##\s/.test(line));
  if (end < 0) end = lines.length;
  return [...lines.slice(0, start + 1), "", ...lines.slice(end)].join("\n");
}

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/**
 * A run with one explanation node, E01-etiquette, whose workspace is complete:
 * an argument, two registry files, the assets pair, two scripts and a report.
 */
function nodeFixture(t: TestContext): { run: string; nodeDir: string } {
  const run = mkdtempSync(path.join(tmpdir(), "ctc-check-argument-"));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  initRun(run, "data", "interest");
  const nodeDir = path.join(run, "explanations", "E01-etiquette");
  const files: Record<string, string> = {
    "workspace/argument.md": argument(),
    "workspace/output/numbers/12_model1.csv": "name,value,note\nm1,0.401,\nm2,0.2,\n",
    "workspace/output/numbers/01_counts.csv": "name,value,note\nn,1234,\n",
    "workspace/output/assets/_variables.yml": 'm1_or_lspec: ".401"\nn_pages: "1234"\n',
    "workspace/output/assets/variables_sources.csv":
      "variable,value,rendered,source\n" +
      "m1_or_lspec,0.401,.401,output/numbers/12_model1.csv#m1\n" +
      "n_pages,1234,1234,output/numbers/01_counts.csv#n\n",
    "workspace/scripts/A_01.R": "# counts\n",
    "workspace/scripts/assets.R": "# assets\n",
    "workspace/reports/01.md": report(),
  };
  for (const [rel, text] of Object.entries(files)) write(path.join(nodeDir, rel), text);
  return { run, nodeDir };
}

function argumentFile(nodeDir: string): string {
  return path.join(nodeDir, ARGUMENT_FILE);
}

function problemsOf(
  fixture: { run: string; nodeDir: string },
  opts: { report?: boolean; citations?: (file: string) => string[] } = {},
): string[] {
  return checkArgument(fixture.run, fixture.nodeDir, { ...NO_CITATIONS, ...opts }).problems;
}

test("a complete node has no problems and no warnings", (t) => {
  const fixture = nodeFixture(t);
  assert.deepEqual(checkArgument(fixture.run, fixture.nodeDir, NO_CITATIONS), { problems: [], warnings: [] });
});

// §10.1 "no unreferenced scripts under a retired letter": a warning, never a problem.

test("a lettered script whose registry is linked from neither argument.md nor variables_sources.csv draws a warning that names it, and the check still passes", (t) => {
  const fixture = nodeFixture(t);
  write(path.join(fixture.nodeDir, "workspace/scripts/B_02.R"), "# a dead end\n");
  write(path.join(fixture.nodeDir, "workspace/output/numbers/B_02.csv"), "name,value,note\nx,5,\n");
  const result = checkArgument(fixture.run, fixture.nodeDir, NO_CITATIONS);
  assert.deepEqual(result.problems, [], "a warning is not a problem");
  assert.equal(result.warnings.length, 1, result.warnings.join("\n"));
  assert.match(result.warnings[0] ?? "", /workspace\/scripts\/B_02\.R/);
  assert.match(result.warnings[0] ?? "", /output\/numbers\/B_02\.csv/);
  assert.match(result.warnings[0] ?? "", /archive_script/);
});

test("a script is not warned about when its registry is linked from the argument, with or without a key", (t) => {
  const fixture = nodeFixture(t);
  write(path.join(fixture.nodeDir, "workspace/scripts/B_02.R"), "# kept\n");
  write(path.join(fixture.nodeDir, "workspace/output/numbers/B_02.csv"), "name,value,note\nx,5,\n");
  write(path.join(fixture.nodeDir, "workspace/scripts/C_01.R"), "# kept\n");
  write(path.join(fixture.nodeDir, "workspace/output/numbers/C_01.csv"), "name,value,note\ny,6,\n");
  write(argumentFile(fixture.nodeDir), withExplanation("The extra count is [five](output/numbers/B_02.csv#x), see also [all of C](output/numbers/C_01.csv)."));
  assert.deepEqual(checkArgument(fixture.run, fixture.nodeDir, NO_CITATIONS), { problems: [], warnings: [] });
});

test("a script is not warned about when its registry is a source in variables_sources.csv", (t) => {
  const fixture = nodeFixture(t);
  write(path.join(fixture.nodeDir, "workspace/scripts/B_02.R"), "# kept\n");
  write(path.join(fixture.nodeDir, "workspace/output/numbers/B_02.csv"), "name,value,note\nx,5,\n");
  write(path.join(fixture.nodeDir, "workspace/output/assets/_variables.yml"), 'm1_or_lspec: ".401"\nn_pages: "1234"\nextra: "5"\n');
  write(
    path.join(fixture.nodeDir, "workspace/output/assets/variables_sources.csv"),
    "variable,value,rendered,source\n" +
      "m1_or_lspec,0.401,.401,output/numbers/12_model1.csv#m1\n" +
      "n_pages,1234,1234,output/numbers/01_counts.csv#n\n" +
      "extra,5,5,output/numbers/B_02.csv#x\n",
  );
  assert.deepEqual(checkArgument(fixture.run, fixture.nodeDir, NO_CITATIONS), { problems: [], warnings: [] });
});

test("an archived script is not warned about, nor a script without a registry file, nor the assets script", (t) => {
  const fixture = nodeFixture(t);
  // archived: the move leaves the script, registry and log under archive/<stem>/ and none in scripts/ or numbers/
  write(path.join(fixture.nodeDir, "workspace/archive/B_02/B_02.R"), "# dropped\n");
  write(path.join(fixture.nodeDir, "workspace/archive/B_02/B_02.csv"), "name,value,note\nx,5,\n");
  write(path.join(fixture.nodeDir, "workspace/archive/B_02/README.md"), "Reason: dead end\n");
  // A_01.R has no registry file at all, assets.R has none by that name
  assert.deepEqual(checkArgument(fixture.run, fixture.nodeDir, NO_CITATIONS), { problems: [], warnings: [] });
});

test("the retired-script warning is printed by the CLI and the exit stays 0", (t) => {
  const fixture = nodeFixture(t);
  write(path.join(fixture.nodeDir, "workspace/scripts/B_02.R"), "# a dead end\n");
  write(path.join(fixture.nodeDir, "workspace/output/numbers/B_02.csv"), "name,value,note\nx,5,\n");
  const run = spawnSync(process.execPath, [CHECK_ARGUMENT, fixture.nodeDir], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^warning: .*B_02\.R/m);
  assert.match(run.stdout, /^ok$/m);
});

test("a node outside the run is a usage error, not a finding", (t) => {
  const fixture = nodeFixture(t);
  const outside = mkdtempSync(path.join(tmpdir(), "ctc-check-argument-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  assert.throws(() => checkArgument(fixture.run, outside, NO_CITATIONS), /is not a node folder inside the run/);
});

test("a missing argument.md is the only problem", (t) => {
  const fixture = nodeFixture(t);
  rmSync(argumentFile(fixture.nodeDir));
  assert.deepEqual(problemsOf(fixture), ["workspace/argument.md is missing"]);
});

test("argument.md that is a link or not a regular file is refused by name, never read", (t) => {
  const fixture = nodeFixture(t);
  const file = argumentFile(fixture.nodeDir);
  const outside = path.join(fixture.run, "outside.md");
  write(outside, argument());
  rmSync(file);
  symlinkSync(outside, file);
  assert.deepEqual(problemsOf(fixture), ["workspace/argument.md is a link: refusing to read it"]);

  rmSync(file);
  mkdirSync(file);
  assert.deepEqual(problemsOf(fixture), ["workspace/argument.md is not a regular file"]);
});

test("a workspace/output that is a link is refused once, and nothing is read through it", (t) => {
  const fixture = nodeFixture(t);
  const output = path.join(fixture.nodeDir, "workspace", "output");
  renameSync(output, path.join(fixture.run, "elsewhere"));
  symlinkSync(path.join(fixture.run, "elsewhere"), output);
  assert.deepEqual(problemsOf(fixture), ["workspace/output is a link: refusing to read it"]);
});

test("each missing heading is a problem", (t) => {
  for (const heading of ARGUMENT_HEADINGS) {
    const fixture = nodeFixture(t);
    write(argumentFile(fixture.nodeDir), withoutHeading(argument(), heading));
    assert.deepEqual(problemsOf(fixture), [`workspace/argument.md lacks the heading "${heading}"`], heading);
  }
});

test("the Contribution line must be theoretical or pattern", (t) => {
  const missing = nodeFixture(t);
  write(argumentFile(missing.nodeDir), argument().replace("Contribution: theoretical\n", ""));
  assert.deepEqual(problemsOf(missing), ['workspace/argument.md lacks a "Contribution: theoretical|pattern" line']);

  const other = nodeFixture(t);
  write(argumentFile(other.nodeDir), argument().replace("theoretical", "maybe"));
  assert.deepEqual(problemsOf(other), ['workspace/argument.md lacks a "Contribution: theoretical|pattern" line']);

  const pattern = nodeFixture(t);
  write(argumentFile(pattern.nodeDir), argument().replace("theoretical", "pattern"));
  assert.deepEqual(problemsOf(pattern), []);
});

test("an empty Alternatives considered section is a problem", (t) => {
  const fixture = nodeFixture(t);
  write(argumentFile(fixture.nodeDir), emptySection(argument(), "## Alternatives considered"));
  assert.deepEqual(problemsOf(fixture), ['workspace/argument.md\'s "## Alternatives considered" section is empty']);
});

test("an empty Predictions section is a problem (they are the Phase 5 preregistration)", (t) => {
  const fixture = nodeFixture(t);
  write(argumentFile(fixture.nodeDir), emptySection(argument(), "## Predictions"));
  assert.deepEqual(problemsOf(fixture), ['workspace/argument.md\'s "## Predictions" section is empty']);

  const fenced = `${emptySection(argument(), "## Predictions").trimEnd()}\n\`\`\`\nThe hold-out should agree.\n\`\`\`\n`;
  write(argumentFile(fixture.nodeDir), fenced);
  assert.deepEqual(problemsOf(fixture), ['workspace/argument.md\'s "## Predictions" section is empty'], "a fenced block is not a prediction");
});

test("a one-line Predictions section passes, whatever it says", (t) => {
  const fixture = nodeFixture(t);
  write(argumentFile(fixture.nodeDir), `${emptySection(argument(), "## Predictions").trimEnd()}\nThe ordering holds.\n`);
  assert.deepEqual(problemsOf(fixture), []);
});

test("a one-line Alternatives considered section passes, whatever it says", (t) => {
  const fixture = nodeFixture(t);
  write(argumentFile(fixture.nodeDir), argument().replace("The timing account is ruled out by the ordering in the registry.", "Nothing."));
  assert.deepEqual(problemsOf(fixture), []);
});

test("an Alternatives considered section holding only a fenced block is empty", (t) => {
  const fixture = nodeFixture(t);
  const body = "```\nThe timing account is ruled out.\n```";
  write(argumentFile(fixture.nodeDir), emptySection(argument(), "## Alternatives considered").replace("## Alternatives considered\n\n", `## Alternatives considered\n${body}\n`));
  assert.deepEqual(problemsOf(fixture), ['workspace/argument.md\'s "## Alternatives considered" section is empty']);
});

test("a relative link to a missing file is a problem", (t) => {
  const fixture = nodeFixture(t);
  write(argumentFile(fixture.nodeDir), `${argument()}Gone: [gone](output/tables/missing.csv).\n`);
  assert.deepEqual(problemsOf(fixture), ["workspace/argument.md links to a missing file: output/tables/missing.csv"]);
});

test("a link into archive/ is a problem even when the file exists", (t) => {
  const fixture = nodeFixture(t);
  write(path.join(fixture.nodeDir, "workspace", "archive", "old.md"), "dropped\n");
  write(argumentFile(fixture.nodeDir), `${argument()}Dropped: [old](archive/old.md).\n`);
  assert.deepEqual(problemsOf(fixture), ["workspace/argument.md links into archive/: archive/old.md"]);
});

test("a link that leaves workspace/, or is absolute, is a problem and is not read", (t) => {
  const fixture = nodeFixture(t);
  write(path.join(fixture.run, "secret.md"), "secret\n");
  write(
    argumentFile(fixture.nodeDir),
    `${argument()}Escape: [up](../../secret.md) and [round](output/../../secret.md) and [abs](/etc/passwd).\n`,
  );
  assert.deepEqual(problemsOf(fixture), [
    "workspace/argument.md link leaves workspace/: ../../secret.md",
    "workspace/argument.md link leaves workspace/: output/../../secret.md",
    "workspace/argument.md link is an absolute path: /etc/passwd",
  ]);
});

test("a link that is not a file path or an http(s) URL is a problem; a web link is not a file link", (t) => {
  const web = nodeFixture(t);
  write(argumentFile(web.nodeDir), `${argument()}See [the handbook](https://example.org/handbook).\n`);
  assert.deepEqual(problemsOf(web), []);

  const scheme = nodeFixture(t);
  write(argumentFile(scheme.nodeDir), `${argument()}Mail [me](mailto:someone@example.org).\n`);
  assert.deepEqual(problemsOf(scheme), ["workspace/argument.md link is not a relative file path: mailto:someone@example.org"]);
});

test("a link to a file that is a link is refused, never read through", (t) => {
  const fixture = nodeFixture(t);
  const outside = path.join(fixture.run, "outside.md");
  write(outside, "outside\n");
  const linked = path.join(fixture.nodeDir, "workspace", "output", "tables", "t.md");
  mkdirSync(path.dirname(linked), { recursive: true });
  symlinkSync(outside, linked);
  write(argumentFile(fixture.nodeDir), `${argument()}Table: [t](output/tables/t.md).\n`);
  assert.deepEqual(problemsOf(fixture), ["workspace/output/tables/t.md is a link: refusing to read it"]);
});

test("a registry link whose key is absent is a problem", (t) => {
  const fixture = nodeFixture(t);
  write(argumentFile(fixture.nodeDir), `${argument()}Missing: [.9](output/numbers/12_model1.csv#zz).\n`);
  assert.deepEqual(problemsOf(fixture), [
    'workspace/argument.md\'s link output/numbers/12_model1.csv#zz names no row "zz" in 12_model1.csv',
  ]);
});

test("a registry link whose key appears twice is a problem, and so is the variable that names it", (t) => {
  const fixture = nodeFixture(t);
  write(path.join(fixture.nodeDir, "workspace", "output", "numbers", "12_model1.csv"), "name,value,note\nm1,0.401,\nm1,0.5,\n");
  assert.deepEqual(problemsOf(fixture), [
    'workspace/argument.md\'s link output/numbers/12_model1.csv#m1 names "m1", which appears 2 times in 12_model1.csv',
    "variable m1_or_lspec has no row whose source resolves to exactly one registry row",
  ]);
});

test("a registry link must name a file directly in workspace/output/numbers/", (t) => {
  const fixture = nodeFixture(t);
  write(path.join(fixture.nodeDir, "workspace", "output", "tables", "t.csv"), "name,value\nk,1\n");
  write(argumentFile(fixture.nodeDir), `${argument()}Table: [t](output/tables/t.csv#k).\n`);
  assert.deepEqual(problemsOf(fixture), [
    "workspace/argument.md's link output/tables/t.csv#k must name a file directly in workspace/output/numbers/",
  ]);
});

test("a file in workspace/scripts/ that is not a script name is a problem", (t) => {
  const fixture = nodeFixture(t);
  write(path.join(fixture.nodeDir, "workspace", "scripts", "helper.R"), "# helper\n");
  assert.deepEqual(problemsOf(fixture), [
    "workspace/scripts/helper.R is not a script name (X_nn.R, X_nn.py, assets.R or assets.py)",
  ]);
});

test("a nested script, or a script link, is refused by name", (t) => {
  const nested = nodeFixture(t);
  write(path.join(nested.nodeDir, "workspace", "scripts", "sub", "A_02.R"), "# nested\n");
  assert.deepEqual(problemsOf(nested), [
    "workspace/scripts/sub/A_02.R is not a script name (X_nn.R, X_nn.py, assets.R or assets.py)",
  ]);

  const linked = nodeFixture(t);
  const outside = path.join(linked.run, "outside.R");
  write(outside, "# outside\n");
  symlinkSync(outside, path.join(linked.nodeDir, "workspace", "scripts", "B_01.R"));
  assert.deepEqual(problemsOf(linked), ["workspace/scripts/B_01.R is a link: refusing to read it"]);
});

test("the script-name patterns: letters and two digits with .R or .py, and assets", (t) => {
  const fixture = nodeFixture(t);
  for (const name of ["A_02.py", "B_01.R", "assets.py"]) write(path.join(fixture.nodeDir, "workspace", "scripts", name), "\n");
  assert.deepEqual(problemsOf(fixture), []);
});

test("a missing _variables.yml is a problem", (t) => {
  const fixture = nodeFixture(t);
  rmSync(path.join(fixture.nodeDir, "workspace", "output", "assets", "_variables.yml"));
  assert.deepEqual(problemsOf(fixture), ["workspace/output/assets/_variables.yml is missing"]);
});

test("a missing variables_sources.csv is a problem", (t) => {
  const fixture = nodeFixture(t);
  rmSync(path.join(fixture.nodeDir, "workspace", "output", "assets", "variables_sources.csv"));
  assert.deepEqual(problemsOf(fixture), ["workspace/output/assets/variables_sources.csv is missing"]);
});

test("a variable without a row in variables_sources.csv is a problem", (t) => {
  const fixture = nodeFixture(t);
  write(path.join(fixture.nodeDir, "workspace", "output", "assets", "_variables.yml"), 'm1_or_lspec: ".401"\nn_pages: "1234"\nextra_var: "7"\n');
  assert.deepEqual(problemsOf(fixture), ["variable extra_var has no row in workspace/output/assets/variables_sources.csv"]);
});

test("a variable whose source row resolves to no registry row is a problem", (t) => {
  const fixture = nodeFixture(t);
  write(
    path.join(fixture.nodeDir, "workspace", "output", "assets", "variables_sources.csv"),
    "variable,value,rendered,source\nm1_or_lspec,0.401,.401,output/numbers/12_model1.csv#m1\nn_pages,1234,1234,output/numbers/01_counts.csv#nope\n",
  );
  assert.deepEqual(problemsOf(fixture), [
    "variable n_pages has no row whose source resolves to exactly one registry row",
  ]);
});

test("a line of _variables.yml that is not name: value is a problem", (t) => {
  const fixture = nodeFixture(t);
  write(path.join(fixture.nodeDir, "workspace", "output", "assets", "_variables.yml"), 'm1_or_lspec: ".401"\nn_pages: "1234"\noops\n');
  assert.deepEqual(problemsOf(fixture), [
    'workspace/output/assets/_variables.yml line 3 is not a \'name: "value"\' line',
  ]);
});

test("a report without a Round: line is a problem", (t) => {
  const fixture = nodeFixture(t);
  write(path.join(fixture.nodeDir, "workspace", "reports", "01.md"), report().replace("Round: 1\n", ""));
  assert.deepEqual(problemsOf(fixture), ['workspace/reports/01.md lacks a "Round: N" line']);
});

test("a report whose Round: is not an integer is a problem", (t) => {
  const fixture = nodeFixture(t);
  write(path.join(fixture.nodeDir, "workspace", "reports", "01.md"), report("Round: x"));
  assert.deepEqual(problemsOf(fixture), ['workspace/reports/01.md\'s "Round: x" is not an integer']);
});

test("a report missing a heading is a problem", (t) => {
  const fixture = nodeFixture(t);
  write(path.join(fixture.nodeDir, "workspace", "reports", "01.md"), withoutHeading(report(), "## Measurement precedents"));
  assert.deepEqual(problemsOf(fixture), ['workspace/reports/01.md lacks the heading "## Measurement precedents"']);
});

test("a report that is a link is refused by name and is not passed to the citation check", (t) => {
  const fixture = nodeFixture(t);
  const outside = path.join(fixture.run, "outside.md");
  write(outside, report());
  const linked = path.join(fixture.nodeDir, "workspace", "reports", "01.md");
  rmSync(linked);
  symlinkSync(outside, linked);
  const seen: string[] = [];
  const problems = problemsOf(fixture, {
    citations: (file) => {
      seen.push(file);
      return [];
    },
  });
  assert.deepEqual(problems, ["workspace/reports/01.md is a link: refusing to read it"]);
  assert.deepEqual(seen, [argumentFile(fixture.nodeDir)]);
});

test("citation problems on argument.md and each report are reported, prefixed with their paths", (t) => {
  const fixture = nodeFixture(t);
  const seen: string[] = [];
  const problems = problemsOf(fixture, {
    citations: (file) => {
      seen.push(file);
      return [`bad in ${path.basename(file)}`];
    },
  });
  assert.deepEqual(problems, [
    "workspace/argument.md: bad in argument.md",
    "workspace/reports/01.md: bad in 01.md",
  ]);
  assert.deepEqual(seen, [argumentFile(fixture.nodeDir), path.join(fixture.nodeDir, "workspace", "reports", "01.md")]);
});

test("with report: true, a missing reviews/report.md is a problem; without it the review is not checked", (t) => {
  const fixture = nodeFixture(t);
  assert.deepEqual(problemsOf(fixture, { report: true }), ["workspace/reviews/report.md is missing"]);
  assert.deepEqual(problemsOf(fixture), []);
});

test("with report: true, a malformed reviews/report.md is a problem, named as malformed", (t) => {
  const fixture = nodeFixture(t);
  write(path.join(fixture.nodeDir, "workspace", "reviews", "report.md"), "## Findings\nsomething\nStatus: DONE\n");
  const problems = problemsOf(fixture, { report: true });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /^workspace\/reviews\/report\.md is malformed/);
});

test("with report: true, a check section that does not open with Result: is a problem", (t) => {
  const fixture = nodeFixture(t);
  write(
    path.join(fixture.nodeDir, "workspace", "reviews", "report.md"),
    review().replace("## Citation fidelity\nResult: ok\n", "## Citation fidelity\nLooks fine.\n"),
  );
  assert.deepEqual(problemsOf(fixture, { report: true }), [
    'workspace/reviews/report.md\'s "## Citation fidelity" does not open with "Result: ok|concerns"',
  ]);
});

test("with report: true, the review's citations are checked and prefixed with its path", (t) => {
  const fixture = nodeFixture(t);
  write(path.join(fixture.nodeDir, "workspace", "reviews", "report.md"), review());
  const problems = problemsOf(fixture, {
    report: true,
    citations: (file) => (file.endsWith(path.join("reviews", "report.md")) ? ["missing chunk id 144636"] : []),
  });
  assert.deepEqual(problems, ["workspace/reviews/report.md: missing chunk id 144636"]);
});

test("a bare number outside a link warns; link text, years, code, URLs, fences and headings do not", (t) => {
  const fixture = nodeFixture(t);
  const text = withExplanation(
    "The share is 0.401 of pages.",
    "The share is [.401](output/numbers/12_model1.csv#m1) of pages.",
    "The years 1998 and 2026 are not counts.",
    "The code `0.403` is code.",
    "The address https://example.org/2026/0.404 is not a count.",
    "# Draft 0.7",
    "```",
    "The fenced 0.402 is code.",
    "```",
    "Only 12345 pages are counted.",
    "The rate is 1,234 per page.",
    "T03 and P23 are identifiers.",
  );
  write(argumentFile(fixture.nodeDir), text);
  const lines = text.split("\n");
  const lineOf = (needle: string): number => lines.indexOf(needle) + 1;
  const result = checkArgument(fixture.run, fixture.nodeDir, NO_CITATIONS);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.warnings, [
    `workspace/argument.md line ${lineOf("The share is 0.401 of pages.")}: bare number 0.401`,
    `workspace/argument.md line ${lineOf("Only 12345 pages are counted.")}: bare number 12345`,
    `workspace/argument.md line ${lineOf("The rate is 1,234 per page.")}: bare number 1,234`,
  ]);
});

test("argumentLinks returns each link in order; fenced code, inline code and titles are handled", () => {
  const markdown = [
    "See [a](output/numbers/x.csv#k) and [b](https://example.org).",
    "```",
    "[c](fenced.md)",
    "```",
    "Inline `[d](inline.md)` and [e](e.md \"title\").",
  ].join("\n");
  assert.deepEqual(argumentLinks(markdown), [
    { text: "a", target: "output/numbers/x.csv#k" },
    { text: "b", target: "https://example.org" },
    { text: "e", target: "e.md" },
  ]);
});

test("parseReport returns the findings with their ids, and the status", () => {
  assert.deepEqual(parseReport(review()), {
    findings: [
      { id: "F1", severity: "major", section: "Number provenance", text: "the sample count has no registry row." },
      { id: "F2", severity: "minor", section: "Overclaiming", text: "the scope sentence is broad." },
    ],
    status: "DONE_WITH_CONCERNS",
  });
});

test("parseReport is null when the Status: line is missing or is not the last line", () => {
  assert.equal(parseReport(review().replace("Status: DONE_WITH_CONCERNS\n", "")), null);
  assert.equal(parseReport(review().replace("Status: DONE_WITH_CONCERNS\n", "Status: DONE_WITH_CONCERNS\nAfterwards.\n")), null);
  assert.equal(parseReport(review().replace("Status: DONE_WITH_CONCERNS", "Status: MAYBE")), null);
});

test("parseReport is null when a heading is missing", () => {
  assert.equal(parseReport(review().replace("## Overclaiming\n", "Overclaiming\n")), null);
});

test("parseReport is null when a finding line is not a finding, so no finding is silently dropped", () => {
  assert.equal(parseReport(review().replace("- [F2] [minor] Overclaiming: the scope sentence is broad.", "- a finding without an id")), null);
});

test("checkRevision flags a finding with no ruling and an overruled ruling with no reason", () => {
  const findings = [{ id: "F1" }, { id: "F2" }, { id: "F3" }];
  assert.deepEqual(
    checkRevision(findings, "F1: taken — the number now cites its row\nF2: overruled — the scope is the owner's call\nF3: taken — narrowed the claim\n"),
    [],
  );
  assert.deepEqual(checkRevision(findings, "F1: taken — changed\nF3: taken — narrowed\n"), ["revision.md has no ruling for F2"]);
  assert.deepEqual(
    checkRevision(findings, "F1: taken — changed\nF2: overruled — \nF3: taken — narrowed\n"),
    ["revision.md: F2 is overruled with no reason"],
  );
});

test("the CLI prints ok and exits 0 for a complete node", (t) => {
  const fixture = nodeFixture(t);
  const result = spawnSync(process.execPath, [CHECK_ARGUMENT, fixture.nodeDir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ok\n");
});

test("the CLI prints warnings first, then ok, and still exits 0", (t) => {
  const fixture = nodeFixture(t);
  const text = withExplanation("The share is 0.401 of pages.");
  write(argumentFile(fixture.nodeDir), text);
  const line = text.split("\n").indexOf("The share is 0.401 of pages.") + 1;
  const result = spawnSync(process.execPath, [CHECK_ARGUMENT, fixture.nodeDir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [`warning: workspace/argument.md line ${line}: bare number 0.401`, "ok"]);
});

test("the CLI prints one problem per line and exits 1 for a bad node", (t) => {
  const fixture = nodeFixture(t);
  write(argumentFile(fixture.nodeDir), withoutHeading(argument(), "## Limitations"));
  const result = spawnSync(process.execPath, [CHECK_ARGUMENT, fixture.nodeDir], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), ['workspace/argument.md lacks the heading "## Limitations"']);
});

test("the CLI with --report requires reviews/report.md", (t) => {
  const fixture = nodeFixture(t);
  const missing = spawnSync(process.execPath, [CHECK_ARGUMENT, fixture.nodeDir, "--report"], { encoding: "utf8" });
  assert.equal(missing.status, 1, missing.stderr);
  assert.deepEqual(missing.stdout.trim().split("\n"), ["workspace/reviews/report.md is missing"]);

  write(path.join(fixture.nodeDir, "workspace", "reviews", "report.md"), review());
  const ok = spawnSync(process.execPath, [CHECK_ARGUMENT, fixture.nodeDir, "--report"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "ok\n");
});

test("the CLI rejects a bad invocation with exit 2", (t) => {
  const fixture = nodeFixture(t);
  const noArgs = spawnSync(process.execPath, [CHECK_ARGUMENT], { encoding: "utf8" });
  assert.equal(noArgs.status, 2);

  const unknown = spawnSync(process.execPath, [CHECK_ARGUMENT, fixture.nodeDir, "--nope"], { encoding: "utf8" });
  assert.equal(unknown.status, 2);

  const notADir = spawnSync(process.execPath, [CHECK_ARGUMENT, path.join(fixture.run, "nope")], { encoding: "utf8" });
  assert.equal(notADir.status, 2);
  assert.match(notADir.stderr, /check-argument:/);
});

test("the default citation runner passes on prose with no citations", (t) => {
  const fixture = nodeFixture(t);
  assert.deepEqual(checkArgument(fixture.run, fixture.nodeDir).problems, []);
  assert.equal(readFileSync(argumentFile(fixture.nodeDir), "utf8").includes("[@"), false);
});

test("argumentLinks reads an angle-bracket target, including spaces", () => {
  assert.deepEqual(argumentLinks("[a](<archive/my file.md>)"), [{ text: "a", target: "archive/my file.md" }]);
});

test("argumentLinks keeps one level of balanced parentheses in a target", () => {
  assert.deepEqual(argumentLinks("[a](foo_(1).md) and [b](https://x/a_(b))"), [
    { text: "a", target: "foo_(1).md" },
    { text: "b", target: "https://x/a_(b)" },
  ]);
});

test("argumentLinks keeps brackets in link text, and the text as written", () => {
  assert.deepEqual(argumentLinks("[a [b] c](x.md) and [`code` text](y.md)"), [
    { text: "a [b] c", target: "x.md" },
    { text: "`code` text", target: "y.md" },
  ]);
});

test("argumentLinks resolves reference links through their definitions; a definition is a link", () => {
  const markdown = [
    "[full][one] and [collapsed][] and [short].",
    "",
    "[one]: archive/one.md",
    "[collapsed]: <output/numbers/12_model1.csv#m1>",
    '[short]: output/tables/t.md "a title"',
    "[unused]: archive/unused.md",
  ].join("\n");
  assert.deepEqual(argumentLinks(markdown), [
    { text: "full", target: "archive/one.md" },
    { text: "collapsed", target: "output/numbers/12_model1.csv#m1" },
    { text: "short", target: "output/tables/t.md" },
    { text: "one", target: "archive/one.md" },
    { text: "collapsed", target: "output/numbers/12_model1.csv#m1" },
    { text: "short", target: "output/tables/t.md" },
    { text: "unused", target: "archive/unused.md" },
  ]);
});

test("argumentLinks drops a link title from the target, whatever its quotes", () => {
  assert.deepEqual(argumentLinks(`[a](x.md "title") [b](y.md 'title') [c](z.md (title)) [d](<w v.md> "t")`), [
    { text: "a", target: "x.md" },
    { text: "b", target: "y.md" },
    { text: "c", target: "z.md" },
    { text: "d", target: "w v.md" },
  ]);
});

test("argumentLinks reads an unbracketed destination with a space as far as it goes, so it is still checked", () => {
  assert.deepEqual(argumentLinks("[a](archive/old file.md)"), [{ text: "a", target: "archive/old file.md" }]);
});

test("an archive/ link is reported however it is written: reference style, angle brackets, a title, a percent escape", (t) => {
  const fixture = nodeFixture(t);
  for (const name of ["old.md", "my file.md", "pct.md"]) write(path.join(fixture.nodeDir, "workspace", "archive", name), "dropped\n");
  write(
    argumentFile(fixture.nodeDir),
    `${argument()}Refs: [old][o], [mine](<archive/my file.md>), [p](archive/pct%2Emd "t").\n\n[o]: archive/old.md\n`,
  );
  assert.deepEqual(problemsOf(fixture), [
    "workspace/argument.md links into archive/: archive/old.md",
    "workspace/argument.md links into archive/: archive/my file.md",
    "workspace/argument.md links into archive/: archive/pct%2Emd",
  ]);
});

test("an unused reference definition into archive/ is still a problem", (t) => {
  const fixture = nodeFixture(t);
  write(path.join(fixture.nodeDir, "workspace", "archive", "gone.md"), "dropped\n");
  write(argumentFile(fixture.nodeDir), `${argument()}\n[unused]: archive/gone.md\n`);
  assert.deepEqual(problemsOf(fixture), ["workspace/argument.md links into archive/: archive/gone.md"]);
});

test("a link target with balanced parentheses resolves to its file, and a missing one is named in full", (t) => {
  const fixture = nodeFixture(t);
  write(path.join(fixture.nodeDir, "workspace", "output", "tables", "t_(1).md"), "table\n");
  write(
    argumentFile(fixture.nodeDir),
    `${argument()}Table: [a [b] c](output/tables/t_(1).md) and [u](output/tables/u_(2).md).\n`,
  );
  assert.deepEqual(problemsOf(fixture), ["workspace/argument.md links to a missing file: output/tables/u_(2).md"]);
});

test("a reference link to a missing file is reported by the file it names", (t) => {
  const fixture = nodeFixture(t);
  write(argumentFile(fixture.nodeDir), `${argument()}Table: [x][r].\n\n[r]: output/tables/nope.md\n`);
  assert.deepEqual(problemsOf(fixture), ["workspace/argument.md links to a missing file: output/tables/nope.md"]);
});

test("a registry link written with angle brackets, a title or reference style resolves", (t) => {
  const fixture = nodeFixture(t);
  write(
    argumentFile(fixture.nodeDir),
    `${argument()}Forms: [.401](<output/numbers/12_model1.csv#m1>), [.401](output/numbers/12_model1.csv#m1 "value"), [.401][r].\n\n[r]: output/numbers/12_model1.csv#m1\n`,
  );
  assert.deepEqual(problemsOf(fixture), []);
});

test("a registry key written with angle brackets is still counted: a repeated key is a problem", (t) => {
  const fixture = nodeFixture(t);
  write(path.join(fixture.nodeDir, "workspace", "output", "numbers", "12_model1.csv"), "name,value,note\nm1,0.401,\nm1,0.5,\n");
  write(argumentFile(fixture.nodeDir), `${argument()}Again: [.401](<output/numbers/12_model1.csv#m1>).\n`);
  assert.deepEqual(problemsOf(fixture), [
    'workspace/argument.md\'s link output/numbers/12_model1.csv#m1 names "m1", which appears 2 times in 12_model1.csv',
    "variable m1_or_lspec has no row whose source resolves to exactly one registry row",
  ]);
});

test("bare numbers in reference-style link text and in reference definitions do not warn", (t) => {
  const fixture = nodeFixture(t);
  write(
    argumentFile(fixture.nodeDir),
    `${argument()}See [0.402][r] and [.403](output/numbers/12_model1.csv#m1).\n\n[r]: output/numbers/12_model1.csv#m1\n`,
  );
  assert.deepEqual(checkArgument(fixture.run, fixture.nodeDir, NO_CITATIONS), { problems: [], warnings: [] });
});

test("an overruled ruling needs a reason with a letter or digit in it", () => {
  const findings = [{ id: "F1" }];
  assert.deepEqual(checkRevision(findings, "F1: overruled —\n"), ["revision.md: F1 is overruled with no reason"]);
  assert.deepEqual(checkRevision(findings, "F1: overruled --\n"), ["revision.md: F1 is overruled with no reason"]);
  assert.deepEqual(checkRevision(findings, "F1: overruled — -\n"), ["revision.md: F1 is overruled with no reason"]);
  assert.deepEqual(checkRevision(findings, "F1: overruled — 2 is a count, not a claim\n"), []);
});

test("F1 and F10 are different findings: a ruling for one does not rule the other", () => {
  const findings = [{ id: "F1" }, { id: "F10" }];
  assert.deepEqual(checkRevision(findings, "F10: taken — changed\n"), ["revision.md has no ruling for F1"]);
  assert.deepEqual(checkRevision(findings, "F1: taken — changed\n"), ["revision.md has no ruling for F10"]);
});
