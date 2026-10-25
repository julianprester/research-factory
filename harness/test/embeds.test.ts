// `scanEmbeds` reads the embeds a paper names: its variables, includes, images and
// citation keys. `embedSetDiff` says how two scans differ, so a style pass that changes
// an embed is caught by counts. Fenced code, inline code, HTML comments and the YAML
// front matter are not prose: a decoy there is not an embed.
import assert from "node:assert/strict";
import test from "node:test";

import { embedSetDiff, scanEmbeds } from "../paper/embeds.ts";

const PAPER = [
  "---",
  'title: "A paper"',
  "---",
  "",
  "# Findings {#sec-findings}",
  "",
  "The share is {{< var m1_or_lspec >}} and the count {{< var n_pages >}} again {{< var n_pages >}}.",
  "",
  "{{< include embeds/tables/T1.qmd >}}",
  "{{< include embeds/quotes/Q01.qmd >}}",
  "",
  "![The map](embeds/figures/F1.png)",
  "",
  "As [@smith2020] and [-@jones2019, p. 4] show, and @lee2021 agrees; see @fig-theory and [@sec-findings].",
  "",
  "Mail foo@bar.com is not a citation.",
  "",
  "```",
  "{{< var decoy >}} [@fenced2000] ![x](embeds/figures/decoy.png)",
  "```",
  "",
  "Inline `{{< var inline >}}` and `[@inline2000]` are code.",
  "<!-- {{< var hidden >}} [@hidden2000] -->",
  "",
].join("\n");

test("every embed form is found, with repeats kept and cross-references and decoys left out", () => {
  assert.deepEqual(scanEmbeds(PAPER), {
    vars: ["m1_or_lspec", "n_pages", "n_pages"],
    includes: ["embeds/quotes/Q01.qmd", "embeds/tables/T1.qmd"],
    images: ["embeds/figures/F1.png"],
    quotes: ["embeds/quotes/Q01.qmd"],
    citations: ["jones2019", "lee2021", "smith2020"],
  });
});

test("an include outside embeds/quotes/ is not a quotation", () => {
  assert.deepEqual(scanEmbeds("{{< include embeds/tables/T1.qmd >}}").quotes, []);
});

test("a citation key with a cross-reference prefix is not a citation", () => {
  const set = scanEmbeds("See [@fig-theory], [@tbl-counts], [@sec-a], [@eq-b] and @fig-c.");
  assert.deepEqual(set.citations, []);
});

test("embedSetDiff of equal sets is empty", () => {
  const set = scanEmbeds(PAPER);
  assert.deepEqual(embedSetDiff(set, scanEmbeds(PAPER)), []);
});

test("embedSetDiff names a dropped citation with its counts", () => {
  const dropped = PAPER.replace("[@smith2020] and ", "");
  assert.deepEqual(embedSetDiff(scanEmbeds(PAPER), scanEmbeds(dropped)), ["citation @smith2020: 1 before, 0 after"]);
});

test("embedSetDiff counts a repeated variable, so one dropped copy is a difference", () => {
  const once = PAPER.replace("again {{< var n_pages >}}", "again");
  assert.deepEqual(embedSetDiff(scanEmbeds(PAPER), scanEmbeds(once)), ["variable n_pages: 2 before, 1 after"]);
});

test("embedSetDiff reads a rewording that keeps every embed as no difference", () => {
  const reworded = PAPER.replace("The share is", "Put plainly, the share is").replace("agrees;", "agrees, and so on;");
  assert.deepEqual(embedSetDiff(scanEmbeds(PAPER), scanEmbeds(reworded)), []);
});
