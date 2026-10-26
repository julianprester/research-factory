// The style-pass bracket (design §8): `beginPass` records the paper and its embeds, `endPass` accepts a pass that
// changed no embed and restores `paper.qmd` byte for byte from the begin commit when one did. Every call leaves
// the working tree as it was apart from what it commits.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { acceptedPasses, beginPass, endPass, PASSES } from "../paper/passes.ts";
import { sha256, paperRun, put } from "./paper-fixture.ts";
import { git } from "./explain-fixture.ts";

const PAPER = [
  "---",
  'title: "Etiquette"',
  "bibliography: references.bib",
  "---",
  "",
  "# Findings",
  "",
  "Readers copy the first example they meet, and {{< var n_pages >}} pages show it [@smith2020].",
  "",
  "{{< include embeds/tables/T1.qmd >}}",
  "",
  "{{< include embeds/quotes/Q01.qmd >}}",
  "",
].join("\n");

/** A paper node W01 whose workspace holds the draft, a passing check for it, and everything committed. */
function setup(t: import("node:test").TestContext) {
  const f = paperRun(t, undefined);
  const workspace = path.join(f.paper, "workspace");
  put(path.join(workspace, "paper.qmd"), PAPER);
  put(path.join(workspace, "embeds", "tables", "T1.qmd"), "| A |\n|---|\n| 1 |\n");
  put(path.join(workspace, "embeds", "quotes", "Q01.qmd"), "> A quote.\n");
  git(f.run, "add", "-A");
  git(f.run, "commit", "-q", "-m", "fixture");
  checkOk(f.paper);
  git(f.run, "add", "-A");
  git(f.run, "commit", "-q", "-m", "fixture check");
  return { ...f, paperDir: f.paper, qmd: path.join(workspace, "paper.qmd") };
}

/** A passing `checks/result.json` for the paper as it stands now. */
function checkOk(paper: string): void {
  const qmd = readFileSync(path.join(paper, "workspace", "paper.qmd"));
  put(
    path.join(paper, "workspace", "checks", "result.json"),
    `${JSON.stringify({ paperSha: sha256(qmd), ok: true, problems: [], warnings: [], renderedAt: "2026-10-26T00:00:00Z" }, null, 2)}\n`,
  );
}

/** The paper as the style worker leaves it: `edit` rewrites its text. */
function rewrite(file: string, from: string, to: string): void {
  const text = readFileSync(file, "utf8");
  if (!text.includes(from)) throw new Error(`fixture: ${from} is not in the paper`);
  put(file, text.replace(from, to));
}

const clean = (run: string, why: string) => assert.equal(git(run, "status", "--porcelain"), "", why);
const subjectsOf = (run: string) => git(run, "log", "--format=%s").trim().split("\n");
const passesFile = (paper: string) => path.join(paper, "workspace", "checks", "passes.json");

test("PASSES are the two style passes, concise first", () => {
  assert.deepEqual([...PASSES], ["concise", "humanize"]);
});

test("a reworded paragraph is accepted, recorded and committed; the tree is clean after each call", (t) => {
  const f = setup(t);
  const begin = beginPass(f.run, f.paperDir, "concise");
  assert.equal(begin.paperSha, sha256(readFileSync(f.qmd)));
  assert.ok(begin.embeds.vars.includes("n_pages"));
  assert.equal(subjectsOf(f.run)[0], "[P4:pass-begin] W01 concise");
  clean(f.run, "begin commits its own files only");

  rewrite(f.qmd, "Readers copy the first example they meet, and", "Readers copy the first example, and");
  const result = endPass(f.run, f.paperDir, "concise");
  assert.deepEqual(result, { accepted: true, diff: [] });
  assert.equal(subjectsOf(f.run)[0], "[P4:pass-accepted] W01 concise");
  const records = JSON.parse(readFileSync(passesFile(f.paperDir), "utf8")) as { pass: string; beforeSha: string; afterSha: string }[];
  assert.deepEqual(records, [{ pass: "concise", beforeSha: begin.paperSha, afterSha: sha256(readFileSync(f.qmd)) }]);
  assert.equal(existsSync(path.join(f.paperDir, "workspace", "checks", "pass-concise.begin.json")), false, "the begin record is consumed");
  clean(f.run, "accept leaves the tree clean");
});

test("a pass that changes a number variable's key is rejected, the diff names it, and paper.qmd is restored byte for byte", (t) => {
  const f = setup(t);
  const before = readFileSync(f.qmd);
  beginPass(f.run, f.paperDir, "concise");
  rewrite(f.qmd, "{{< var n_pages >}}", "{{< var n_pagez >}}");
  const result = endPass(f.run, f.paperDir, "concise");
  assert.equal(result.accepted, false);
  assert.deepEqual(result.diff, ["variable n_pages: 1 before, 0 after", "variable n_pagez: 0 before, 1 after"]);
  assert.ok(readFileSync(f.qmd).equals(before), "restored byte for byte");
  assert.equal(subjectsOf(f.run)[0], "[P4:pass-rejected] W01 concise");
  assert.equal(existsSync(passesFile(f.paperDir)), false, "nothing is accepted");
  clean(f.run, "the rejection leaves the tree clean");
});

test("a pass that drops a citation, swaps a quote id or adds an include is rejected", (t) => {
  const cases: [string, string, string][] = [
    ["drops a citation", "[@smith2020]", ""],
    ["swaps a quote id", "embeds/quotes/Q01.qmd", "embeds/quotes/Q02.qmd"],
    ["adds an include", "{{< include embeds/tables/T1.qmd >}}", "{{< include embeds/tables/T1.qmd >}}\n\n{{< include embeds/tables/T1.qmd >}}"],
  ];
  for (const [why, from, to] of cases) {
    const f = setup(t);
    const before = readFileSync(f.qmd);
    beginPass(f.run, f.paperDir, "concise");
    rewrite(f.qmd, from, to);
    const result = endPass(f.run, f.paperDir, "concise");
    assert.equal(result.accepted, false, `${why}: rejected`);
    assert.ok(result.diff.length > 0, `${why}: the diff names the item`);
    assert.ok(readFileSync(f.qmd).equals(before), `${why}: restored`);
    clean(f.run, `${why}: clean`);
  }
});

test("humanize before concise is refused, and so is a pass with no check for the current paper", (t) => {
  const f = setup(t);
  assert.throws(() => beginPass(f.run, f.paperDir, "humanize"), /concise/);
  put(path.join(f.paperDir, "workspace", "checks", "result.json"), `${JSON.stringify({ paperSha: "0".repeat(64), ok: true })}\n`);
  assert.throws(() => beginPass(f.run, f.paperDir, "concise"), /not ok for the current paper\.qmd/);
  put(path.join(f.paperDir, "workspace", "checks", "result.json"), `${JSON.stringify({ paperSha: sha256(readFileSync(f.qmd)), ok: false })}\n`);
  assert.throws(() => beginPass(f.run, f.paperDir, "concise"), /not ok for the current paper\.qmd/);
});

test("endPass without a begin is refused", (t) => {
  const f = setup(t);
  assert.throws(() => endPass(f.run, f.paperDir, "concise"), /no pass-begin/);
  clean(f.run, "refusal changes nothing");
});

test("humanize after concise is accepted once concise is, and a second concise is refused", (t) => {
  const f = setup(t);
  beginPass(f.run, f.paperDir, "concise");
  rewrite(f.qmd, "Readers copy the first example they meet, and", "Readers copy the first example, and");
  assert.equal(endPass(f.run, f.paperDir, "concise").accepted, true);
  assert.throws(() => beginPass(f.run, f.paperDir, "concise"), /already accepted/);
  checkOk(f.paperDir);
  git(f.run, "add", "-A");
  git(f.run, "commit", "-q", "-m", "check again");
  beginPass(f.run, f.paperDir, "humanize");
  rewrite(f.qmd, "Readers copy the first example, and", "Readers copy the first example; and");
  assert.equal(endPass(f.run, f.paperDir, "humanize").accepted, true);
  const records = JSON.parse(readFileSync(passesFile(f.paperDir), "utf8")) as { pass: string }[];
  assert.deepEqual(records.map((record) => record.pass), ["concise", "humanize"]);
  clean(f.run, "both passes leave the tree clean");
});

test("a rejected pass is redone cleanly: begin again, then accept", (t) => {
  const f = setup(t);
  beginPass(f.run, f.paperDir, "concise");
  rewrite(f.qmd, "{{< var n_pages >}}", "{{< var n_pagez >}}");
  assert.equal(endPass(f.run, f.paperDir, "concise").accepted, false);
  checkOk(f.paperDir);
  beginPass(f.run, f.paperDir, "concise");
  rewrite(f.qmd, "Readers copy the first example they meet, and", "Readers copy the first example, and");
  assert.equal(endPass(f.run, f.paperDir, "concise").accepted, true);
});

test("a second endPass after an accepted pass is refused: its begin was consumed", (t) => {
  const f = setup(t);
  beginPass(f.run, f.paperDir, "concise");
  assert.equal(endPass(f.run, f.paperDir, "concise").accepted, true);
  assert.throws(() => endPass(f.run, f.paperDir, "concise"), /no pass-begin/);
});

test("an edit to the paper after the passes makes both passes run again: the stale records stand for nothing", (t) => {
  const f = setup(t);
  beginPass(f.run, f.paperDir, "concise");
  rewrite(f.qmd, "Readers copy the first example they meet, and", "Readers copy the first example, and");
  assert.equal(endPass(f.run, f.paperDir, "concise").accepted, true);
  rewrite(f.qmd, "Readers copy the first example, and", "Readers copy the first example; and");
  assert.deepEqual(acceptedPasses(f.run, f.paperDir), [], "stale: nothing stands");
  checkOk(f.paperDir);
  assert.throws(() => beginPass(f.run, f.paperDir, "humanize"), /comes after concise/);
  beginPass(f.run, f.paperDir, "concise");
  rewrite(f.qmd, "Readers copy the first example; and", "Readers copy the first example, and");
  assert.equal(endPass(f.run, f.paperDir, "concise").accepted, true);
  assert.deepEqual(acceptedPasses(f.run, f.paperDir).map((record) => record.pass), ["concise"]);
});
