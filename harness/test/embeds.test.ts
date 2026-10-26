// `scanEmbeds` reads the embeds a paper names from the raw text: its variables, includes, images and
// citation keys. Nothing is masked: Quarto and pandoc render code spans, comments and fences too, so an
// embed in any of them is an embed. `embedSetDiff` says how two scans differ, so a style pass that adds
// or drops an embed is caught by counts.
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
].join("\n");

test("every embed form is found, with repeats kept and cross-references left out", () => {
  assert.deepEqual(scanEmbeds(PAPER), {
    vars: ["m1_or_lspec", "n_pages", "n_pages"],
    includes: ["embeds/quotes/Q01.qmd", "embeds/tables/T1.qmd"],
    images: ["embeds/figures/F1.png"],
    quotes: ["embeds/quotes/Q01.qmd"],
    citations: ["jones2019", "lee2021", "smith2020"],
  });
});

test("a variable in inline code is still a variable", () => {
  assert.deepEqual(scanEmbeds("`x {{< var v >}}`").vars, ["v"]);
});

test("a variable in a fence with an invalid opener is still a variable", () => {
  assert.deepEqual(scanEmbeds("``` a`b\n{{< var v >}}\n").vars, ["v"]);
});

test("a citation in inline code is still a citation", () => {
  assert.deepEqual(scanEmbeds("`x [@smith2020]`").citations, ["smith2020"]);
});

test("an image in inline code is still an image", () => {
  assert.deepEqual(scanEmbeds("`x ![i](embeds/figures/evil.png)`").images, ["embeds/figures/evil.png"]);
});

test("the var shortcode is found without the spacing Quarto also accepts", () => {
  assert.deepEqual(scanEmbeds("{{<var a>}} {{< var  b >}} {{< var\nc >}}").vars, ["a", "b", "c"]);
});

test("an include in quotation marks is an include, with its path unquoted", () => {
  const set = scanEmbeds('{{< include "embeds/tables/T1.qmd" >}}');
  assert.deepEqual(set.includes, ["embeds/tables/T1.qmd"]);
  assert.deepEqual(set.quotes, []);
});

test("an include outside embeds/quotes/ is not a quotation", () => {
  assert.deepEqual(scanEmbeds("{{< include embeds/tables/T1.qmd >}}").quotes, []);
});

test("a citation key with a cross-reference prefix is not a citation", () => {
  const set = scanEmbeds("See [@fig-theory], [@tbl-counts], [@sec-a], [@eq-b] and @fig-c.");
  assert.deepEqual(set.citations, []);
});

test("an @ inside a URL or an email is not a citation", () => {
  assert.deepEqual(scanEmbeds("See https://x.org/@user and foo@bar.com.").citations, []);
});

test("a citation key may hold Unicode letters", () => {
  assert.deepEqual(scanEmbeds("As [@müller2020] shows.").citations, ["müller2020"]);
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

test("embedSetDiff sees a hidden variable added by a style pass", () => {
  assert.deepEqual(embedSetDiff(scanEmbeds("Text"), scanEmbeds("Text `{{< var v >}}`")), ["variable v: 0 before, 1 after"]);
});

test("embedSetDiff reads a rewording that keeps every embed as no difference", () => {
  const reworded = PAPER.replace("The share is", "Put plainly, the share is").replace("agrees;", "agrees, and so on;");
  assert.deepEqual(embedSetDiff(scanEmbeds(PAPER), scanEmbeds(reworded)), []);
});
