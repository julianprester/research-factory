// The Phase 2 rubric is Tavory & Timmermans' three criteria, so the reviewer and
// the judge have to read the book's words, not a paraphrase of them. These tests
// read the criteria file and check every passage it quotes against the book in
// `docs/abduction.md`. The book is an EPUB conversion, so both sides are
// normalised before comparing: curly quotes to ASCII, any run of whitespace to
// one space. The criteria file keeps the book's own spelling and punctuation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCriteria } from "../tournament/criteria.ts";

const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CRITERIA = "harness/skills/criteria/tavory-timmermans.md";
const BOOK = "docs/abduction.md";

/** The passages the plan requires: the three questions and their book detail. */
const REQUIRED_QUOTES = [
  "Are the theoretical claims supported by the empirical materials?",
  "follows from the presented evidence and at the same time transcends the immediacy of the observations",
  "An empirical restatement of the data would have a perfect fit but add little analytical purchase.",
  "Are the theoretical claims stronger than competing theories?",
  "Do the theorizations matter in the broader intellectual community?",
  "no clear methodological guidelines",
];

const HEADINGS = ["## Fit", "## Plausibility", "## Relevance"];

function read(relative: string): string {
  return readFileSync(path.join(HARNESS_ROOT, relative), "utf8");
}

/** Curly quotes to ASCII, any run of whitespace to one space. */
function normalise(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Every `"…"` span of 20 characters or more on a blockquote line. */
function quotedSpans(markdown: string): string[] {
  const spans: string[] = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith(">")) continue;
    for (const match of line.matchAll(/"([^"]{20,})"/g)) spans.push(match[1] as string);
  }
  return spans;
}

test("every passage the criteria file quotes appears verbatim in the book", () => {
  const file = read(CRITERIA);
  // Every blockquote line is one whole book quote on one line: a curly-delimited
  // or wrapped quote would otherwise slip past the span check below unchecked.
  for (const line of file.split("\n")) {
    if (!line.startsWith(">")) continue;
    assert.match(line, /^> "[^"]+"$/, `a quoted line is one whole quote between straight double quotes: ${line}`);
  }
  const spans = quotedSpans(file);
  assert.ok(
    spans.length >= REQUIRED_QUOTES.length,
    `the criteria file quotes at least ${REQUIRED_QUOTES.length} passages, on lines starting "> "`,
  );
  const book = normalise(read(BOOK));
  for (const span of spans) {
    assert.ok(book.includes(normalise(span)), `the book contains this quoted passage verbatim: ${span}`);
  }
});

test("the criteria file carries the three questions and the book's detail for each", () => {
  const criteria = normalise(read(CRITERIA));
  for (const quote of REQUIRED_QUOTES) {
    assert.ok(criteria.includes(normalise(quote)), `the criteria file quotes: ${quote}`);
  }
});

test("loadCriteria returns the criteria file with its three headings", () => {
  const text = loadCriteria();
  for (const heading of HEADINGS) assert.ok(text.includes(heading), `loadCriteria carries ${heading}`);
  assert.equal(normalise(text), normalise(read(CRITERIA)), "loadCriteria returns the file's text");
});

test("fit is judged against Phase 1's evidence and forbids new analysis", () => {
  const file = read(CRITERIA);
  const fit = file.slice(file.indexOf("## Fit"), file.indexOf("## Plausibility")).replace(/\s+/g, " ");
  assert.match(fit, /Phase 1's evidence/, "the fit section names Phase 1's evidence as its materials");
  assert.match(fit, /no new analysis/i, "the fit section says Phase 2 runs no new analysis for fit");
});
