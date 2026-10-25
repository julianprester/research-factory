import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { prepareExploration } from "../analysis/run.ts";
import { quoteSource, verifyQuotes } from "../paper/quotes.ts";
import { createChild, findNode, initRun, updateNode } from "../tree.ts";

const RULES = ["# Rules", "", "Be patient.   ", "  Wait your turn.", "", "Never interrupt.", "   ", "Last line"].join("\n") + "\n";

function put(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Fixture {
  run: string;
  paper: string;
  dataset: string;
  exploration: string;
  quotesDir: string;
  holdout: string;
}

/**
 * A run with a paper W01 under an explanation in phase 4, a dataset with handbook files, and an
 * exploration copy made by prepareExploration. The exploration copy also holds planted refusal
 * cases: a hold-out copy by name, a link to a hold-out file, a hard link to one, and links to
 * ordinary files and folders.
 */
function fixture(t: TestContext): Fixture {
  const dataset = mkdtempSync(path.join(tmpdir(), "ctc-quote-dataset-"));
  t.after(() => rmSync(dataset, { recursive: true, force: true }));
  put(path.join(dataset, "handbook", "rules.md"), RULES);
  put(path.join(dataset, "handbook", "crlf.md"), "one\r\ntwo  \r\nthree\r\n");
  put(path.join(dataset, "handbook", "held.md"), "held back\nthe answer\n");
  put(path.join(dataset, "handbook", "long.md"), `${Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
  put(path.join(dataset, "handbook", "blank.md"), "text\n   \n\t\n");

  const run = mkdtempSync(path.join(tmpdir(), "ctc-quote-run-"));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  initRun(run, dataset, "interest");
  createChild(run, "D01", "Self Presentation", "owner-p1");
  createChild(run, "T01", "status quo: crowd", "owner-p2");
  createChild(run, "P01", "Explanation of crowd", "owner-p3", [], "explanation");
  updateNode(run, "E01", { phase: 3, status: "active" }, "owner-p3");
  updateNode(run, "E01", { phase: 4, status: "ready" }, "owner-p3");
  createChild(run, "E01", "Paper of crowd", "owner-p4", [], "paper");

  const split = path.join(run, "prep", "Z01-profile", "workspace", "split");
  put(path.join(split, "exploration.txt"), "handbook/rules.md\nhandbook/crlf.md\nhandbook/long.md\nhandbook/blank.md\n");
  put(path.join(split, "holdout.txt"), "handbook/held.md\n");
  prepareExploration(run);

  const exploration = path.join(run, "analysis-data", "exploration");
  put(path.join(exploration, "handbook", "held.md"), "held back\nthe answer\n");
  symlinkSync(path.join(dataset, "handbook", "held.md"), path.join(exploration, "handbook", "alias.md"));
  linkSync(path.join(dataset, "handbook", "held.md"), path.join(exploration, "handbook", "hardlink.md"));
  symlinkSync(path.join(exploration, "handbook", "rules.md"), path.join(exploration, "handbook", "link.md"));
  symlinkSync(path.join(exploration, "handbook"), path.join(exploration, "linked-folder"));

  const paper = findNode(run, "W01").dir;
  return { run, paper, dataset, exploration, quotesDir: path.join(paper, "workspace", "embeds", "quotes"), holdout: path.join(split, "holdout.txt") };
}

function fragment(paper: string, id: string): string {
  return readFileSync(path.join(paper, "workspace", "embeds", "quotes", `${id}.qmd`), "utf8");
}

function index(paper: string): { quotes: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(path.join(paper, "workspace", "embeds", "quotes", "quotes.json"), "utf8"));
}

test("a verbatim slice yields a block quotation whose text is the file's lines, with its source line", (t) => {
  const { run, paper, exploration } = fixture(t);
  const result = quoteSource(run, paper, { path: "handbook/rules.md", start: 1, end: 4 });
  assert.deepEqual(result, { id: "Q01", embed: "{{< include embeds/quotes/Q01.qmd >}}" });

  const text = fragment(paper, "Q01");
  const sha = sha256(readFileSync(path.join(exploration, "handbook", "rules.md")));
  const lines = text.split("\n");
  assert.equal(lines[0], `<!-- quote Q01 source=handbook/rules.md lines=1-4 sha256=${sha} -->`);
  assert.deepEqual(lines.slice(1, 5), ["> # Rules", ">", "> Be patient.", ">   Wait your turn."], "an empty line becomes >, trailing whitespace is trimmed");
  assert.equal(lines[5], "— handbook/rules.md, lines 1–4", "the source line, with an em dash and an en dash");
  assert.equal(lines.length, 7, "nothing after the source line but the final newline");
  assert.equal(text.endsWith("\n"), true);
  assert.equal(text.includes("\r"), false, "LF endings");
  assert.deepEqual(
    lines.slice(1, 5).map((line) => line.replace(/^> ?/, "")),
    ["# Rules", "", "Be patient.", "  Wait your turn."],
    "the block text is the file's lines",
  );
});

test("CRLF endings and trailing whitespace are folded in the stored text and the fragment", (t) => {
  const { run, paper } = fixture(t);
  quoteSource(run, paper, { path: "handbook/crlf.md", start: 1, end: 2 });
  assert.deepEqual(fragment(paper, "Q01").split("\n").slice(1, 3), ["> one", "> two"]);
  assert.equal(index(paper).quotes[0]?.text, "one\ntwo");
});

test("the index entry holds the id, source, lines, the file's sha256 and the text", (t) => {
  const { run, paper, exploration } = fixture(t);
  quoteSource(run, paper, { path: "./handbook/rules.md", start: 3, end: 4 });
  assert.deepEqual(index(paper), {
    quotes: [
      {
        id: "Q01",
        source: "handbook/rules.md",
        start: 3,
        end: 4,
        fileSha256: sha256(readFileSync(path.join(exploration, "handbook", "rules.md"))),
        text: "Be patient.\n  Wait your turn.",
      },
    ],
  });
});

test("the same slice twice gives one id and writes nothing new; another slice takes the next id", (t) => {
  const { run, paper, quotesDir } = fixture(t);
  const first = quoteSource(run, paper, { path: "handbook/rules.md", start: 1, end: 4 });
  const before = readFileSync(path.join(quotesDir, "quotes.json"));
  const second = quoteSource(run, paper, { path: "handbook/rules.md", start: 1, end: 4 });
  assert.deepEqual(second, first, "the existing id and embed");
  assert.deepEqual(readFileSync(path.join(quotesDir, "quotes.json")), before, "the index is unchanged");
  assert.deepEqual(readdirSync(quotesDir).sort(), ["Q01.qmd", "quotes.json"]);

  assert.equal(quoteSource(run, paper, { path: "handbook/rules.md", start: 6, end: 6 }).id, "Q02");
});

test("paths that are absolute, climb with .., have empty segments or NUL, or name no file are refused and write nothing", (t) => {
  const { run, paper, exploration, quotesDir, dataset } = fixture(t);
  const bad = [
    path.join(exploration, "handbook", "rules.md"),
    path.join(dataset, "handbook", "rules.md"),
    "../rules.md",
    "handbook/../rules.md",
    "handbook/../../dataset/handbook/rules.md",
    "handbook//rules.md",
    "handbook/",
    "handbook/rules.md\u0000",
    "",
    "./",
  ];
  for (const filePath of bad) {
    assert.throws(() => quoteSource(run, paper, { path: filePath, start: 1, end: 2 }), Error, JSON.stringify(filePath));
  }
  assert.equal(existsSync(quotesDir), false, "nothing was written");
});

test("a symlinked file, a path through a symlinked folder, a folder, and a missing file are refused and write nothing", (t) => {
  const { run, paper, quotesDir } = fixture(t);
  for (const filePath of ["handbook/link.md", "linked-folder/rules.md", "handbook", "handbook/missing.md"]) {
    assert.throws(() => quoteSource(run, paper, { path: filePath, start: 1, end: 2 }), Error, filePath);
  }
  assert.equal(existsSync(quotesDir), false, "nothing was written");
});

test("a hold-out file is refused by name, by a link to it, and by a hard link to it, and writes nothing", (t) => {
  const { run, paper, quotesDir } = fixture(t);
  assert.throws(() => quoteSource(run, paper, { path: "handbook/held.md", start: 1, end: 2 }), /hold-out/, "the copy listed by name");
  assert.throws(() => quoteSource(run, paper, { path: "./handbook/held.md", start: 1, end: 2 }), /hold-out/, "the same name with ./");
  assert.throws(() => quoteSource(run, paper, { path: "handbook/alias.md", start: 1, end: 2 }), /hold-out/, "a symlink to the hold-out file");
  assert.throws(() => quoteSource(run, paper, { path: "handbook/hardlink.md", start: 1, end: 2 }), /hold-out/, "a hard link to the hold-out file");
  assert.equal(existsSync(quotesDir), false, "nothing was written");
});

test("a listed name is refused by name even when the copy at that name is a dangling link", (t) => {
  const { run, paper, exploration, quotesDir } = fixture(t);
  unlinkSync(path.join(exploration, "handbook", "held.md"));
  symlinkSync(path.join(exploration, "handbook", "nowhere.md"), path.join(exploration, "handbook", "held.md"));
  assert.throws(() => quoteSource(run, paper, { path: "handbook/held.md", start: 1, end: 2 }), /hold-out list/);
  assert.equal(existsSync(quotesDir), false, "nothing was written");
});

test("without a hold-out list every quotation is refused, so the check fails closed", (t) => {
  const { run, paper, quotesDir, holdout } = fixture(t);
  unlinkSync(holdout);
  assert.throws(() => quoteSource(run, paper, { path: "handbook/rules.md", start: 1, end: 2 }), /hold-out list/);
  assert.equal(existsSync(quotesDir), false, "nothing was written");
});

test("21 lines are refused and 20 are accepted", (t) => {
  const { run, paper, quotesDir } = fixture(t);
  assert.throws(() => quoteSource(run, paper, { path: "handbook/long.md", start: 1, end: 21 }), /at most 20/);
  assert.equal(existsSync(quotesDir), false, "nothing was written");
  const result = quoteSource(run, paper, { path: "handbook/long.md", start: 1, end: 20 });
  assert.equal(result.id, "Q01");
  assert.equal(fragment(paper, "Q01").split("\n").filter((line) => line.startsWith("> ")).length, 20);
});

test("ranges that are not whole, 1-based and ordered are refused, as are slices past the end and blank slices", (t) => {
  const { run, paper, quotesDir } = fixture(t);
  const bad: Array<[string, number, number]> = [
    ["handbook/rules.md", 0, 2],
    ["handbook/rules.md", 3, 2],
    ["handbook/rules.md", 1.5, 2],
    ["handbook/rules.md", Number.NaN, 2],
    ["handbook/rules.md", 1, 9],
    ["handbook/blank.md", 2, 3],
  ];
  for (const [filePath, start, end] of bad) {
    assert.throws(() => quoteSource(run, paper, { path: filePath, start, end }), Error, `${filePath} ${start}-${end}`);
  }
  assert.equal(existsSync(quotesDir), false, "nothing was written");
});

test("verifyQuotes is clean on a node with no quotes and on fresh output", (t) => {
  const { run, paper } = fixture(t);
  assert.deepEqual(verifyQuotes(run, paper), []);
  quoteSource(run, paper, { path: "handbook/rules.md", start: 1, end: 4 });
  quoteSource(run, paper, { path: "handbook/crlf.md", start: 1, end: 2 });
  assert.deepEqual(verifyQuotes(run, paper), []);
});

test("verifyQuotes flags a fragment edited by one character", (t) => {
  const { run, paper, quotesDir } = fixture(t);
  quoteSource(run, paper, { path: "handbook/rules.md", start: 1, end: 4 });
  const file = path.join(quotesDir, "Q01.qmd");
  writeFileSync(file, readFileSync(file, "utf8").replace("Wait", "wait"));
  const problems = verifyQuotes(run, paper);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /^Q01: /);
});

test("verifyQuotes flags a file changed after quoting, by its sha256", (t) => {
  const { run, paper, exploration } = fixture(t);
  quoteSource(run, paper, { path: "handbook/rules.md", start: 1, end: 4 });
  appendFileSync(path.join(exploration, "handbook", "rules.md"), "Added after quoting.\n");
  const problems = verifyQuotes(run, paper);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /^Q01: .*sha256/);
});

test("verifyQuotes flags a fragment that is not in quotes.json", (t) => {
  const { run, paper, quotesDir } = fixture(t);
  quoteSource(run, paper, { path: "handbook/rules.md", start: 1, end: 4 });
  writeFileSync(path.join(quotesDir, "Q09.qmd"), "written by hand\n");
  const problems = verifyQuotes(run, paper);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /^Q09: .*not in quotes\.json/);
});

test("verifyQuotes flags an entry whose source became a hold-out file", (t) => {
  const { run, paper, holdout } = fixture(t);
  quoteSource(run, paper, { path: "handbook/rules.md", start: 1, end: 4 });
  writeFileSync(holdout, "handbook/held.md\nhandbook/rules.md\n");
  const problems = verifyQuotes(run, paper);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /^Q01: .*hold-out/);
});

test("verifyQuotes flags an entry whose fragment is missing or is replaced by a link", (t) => {
  const { run, paper, quotesDir } = fixture(t);
  quoteSource(run, paper, { path: "handbook/rules.md", start: 1, end: 4 });
  const file = path.join(quotesDir, "Q01.qmd");
  unlinkSync(file);
  let problems = verifyQuotes(run, paper);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /^Q01: .*missing/);

  symlinkSync(path.join(run, "analysis-data", "exploration", "handbook", "rules.md"), file);
  problems = verifyQuotes(run, paper);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /^Q01: /);
});

test("verifyQuotes flags an entry whose text was edited in quotes.json", (t) => {
  const { run, paper, quotesDir } = fixture(t);
  quoteSource(run, paper, { path: "handbook/rules.md", start: 1, end: 4 });
  const file = path.join(quotesDir, "quotes.json");
  const json = JSON.parse(readFileSync(file, "utf8")) as { quotes: Array<{ text: string }> };
  json.quotes[0]!.text = json.quotes[0]!.text.replace("patient", "patience");
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  const problems = verifyQuotes(run, paper);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /^Q01: .*text/);
});
