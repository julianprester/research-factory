import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import { prepareExploration } from "../analysis/run.ts";
import { escapeQuoteLine, headerSource, quoteSource, verifyQuotes } from "../paper/quotes.ts";
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

test("a verbatim slice yields an escaped block quotation with a blank line and its source line", (t) => {
  const { run, paper, exploration } = fixture(t);
  const result = quoteSource(run, paper, { path: "handbook/rules.md", start: 1, end: 4 });
  assert.deepEqual(result, { id: "Q01", embed: "{{< include embeds/quotes/Q01.qmd >}}" });

  const text = fragment(paper, "Q01");
  const sha = sha256(readFileSync(path.join(exploration, "handbook", "rules.md")));
  assert.equal(
    text,
    [
      `<!-- quote Q01 source=handbook/rules.md lines=1-4 sha256=${sha} -->`,
      "> \\# Rules",
      ">",
      "> Be patient\\.",
      "> &#32;&#32;Wait your turn\\.",
      "",
      "— handbook\\/rules\\.md, lines 1–4",
      "",
    ].join("\n"),
  );
  assert.equal(text.includes("\r"), false, "LF endings");
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

/** The reason a host tool cannot run here, or undefined when it can (a skip reason for the tests that need it). */
function missingTool(command: string): string | undefined {
  const probe = spawnSync(command, ["--version"], { encoding: "utf8" });
  return probe.status === 0 ? undefined : `${command} is not runnable on this host`;
}

const PANDOC_SKIP = missingTool("pandoc");
const QUARTO_SKIP = missingTool("quarto");
const BOTH_SKIP = [PANDOC_SKIP, QUARTO_SKIP].filter((reason) => reason !== undefined).join("; ") || undefined;

/** The text a quotation of `lines` renders to: paragraphs split at empty lines, a line break inside a paragraph as a space. */
function renderedParagraphs(lines: string[]): string[] {
  const paragraphs: string[][] = [[]];
  for (const line of lines) {
    if (line === "") paragraphs.push([]);
    else paragraphs[paragraphs.length - 1]?.push(line);
  }
  return paragraphs.filter((paragraph) => paragraph.length > 0).map((paragraph) => paragraph.join(" "));
}

/** The non-empty lines a fragment of `lines` from `source` must print as: each paragraph under pandoc's two-space quotation indent, then the source line. */
function expectedPrint(lines: string[], source: string, start: number, end: number): string[] {
  return [...renderedParagraphs(lines).map((paragraph) => `  ${paragraph}`), `— ${source}, lines ${start}–${end}`];
}

/**
 * A bibliography with one unrelated entry. The paper has one, so an unescaped `@word` is a
 * citation that does not resolve (it prints `(word?)` and logs a warning) rather than text.
 */
const BIBLIOGRAPHY = "@article{other,\n  title = {Unrelated},\n  author = {Doe, Ann},\n  year = {2020}\n}\n";

/** Pandoc's plain text of one markdown document, with citations processed against the bibliography. */
function pandocPrint(t: TestContext, markdown: string): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), "ctc-pandoc-quotes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bib = path.join(dir, "refs.bib");
  writeFileSync(bib, BIBLIOGRAPHY);
  const result = spawnSync(
    "pandoc",
    ["-f", "markdown", "-t", "plain", "--wrap=none", "--citeproc", "--bibliography", bib],
    { input: markdown, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /WARNING/, "pandoc logs no warning");
  return result.stdout.split("\n").filter((line) => line !== "");
}

/**
 * Quarto's plain text of many fragments, one render: each fragment is included in a minimal
 * paper between marker paragraphs, and the text is cut at the markers. Returns the non-empty
 * lines of each fragment's part, in order.
 */
function quartoPrintEach(t: TestContext, fragments: string[]): string[][] {
  const dir = mkdtempSync(path.join(tmpdir(), "ctc-quarto-quotes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Quarto's plain writer wraps at 72 columns unless told not to; the line breaks are not part of the text.
  const parts = ["---", "title: round trip", "bibliography: refs.bib", "format:", "  plain:", "    wrap: none", "---", ""];
  put(path.join(dir, "refs.bib"), BIBLIOGRAPHY);
  fragments.forEach((fragment, index) => {
    const name = `Q${String(index + 1).padStart(3, "0")}.qmd`;
    put(path.join(dir, "embeds", "quotes", name), fragment);
    parts.push(`ZMARK${String(index).padStart(3, "0")}ZMARK`, "", `{{< include embeds/quotes/${name} >}}`, "");
  });
  parts.push("ZMARKEND", "");
  writeFileSync(path.join(dir, "paper.qmd"), parts.join("\n"));

  const result = spawnSync("quarto", ["render", "paper.qmd", "--to", "plain"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /WARNING/, "quarto logs no warning");
  const segments = readFileSync(path.join(dir, "paper.txt"), "utf8").split(/ZMARK\d{3}ZMARK|ZMARKEND/);
  assert.equal(segments.length, fragments.length + 2, "one part per marker, plus the title and the end");
  return segments.slice(1, fragments.length + 1).map((segment) => segment.split("\n").filter((line) => line !== ""));
}

/**
 * A fresh run whose exploration copy holds `file` (one line per entry of `lines`) and whose paper
 * is W01. Each line is quoted on its own through quoteSource; returns the fragments in order.
 */
function corpusPaper(t: TestContext, files: Map<string, string>): { run: string; paper: string } {
  const dataset = mkdtempSync(path.join(tmpdir(), "ctc-quote-corpus-"));
  t.after(() => rmSync(dataset, { recursive: true, force: true }));
  for (const [file, text] of files) put(path.join(dataset, file), text);
  const run = mkdtempSync(path.join(tmpdir(), "ctc-quote-corpus-run-"));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  initRun(run, dataset, "interest");
  createChild(run, "D01", "Self Presentation", "owner-p1");
  createChild(run, "T01", "status quo: crowd", "owner-p2");
  createChild(run, "P01", "Explanation of crowd", "owner-p3", [], "explanation");
  updateNode(run, "E01", { phase: 3, status: "active" }, "owner-p3");
  updateNode(run, "E01", { phase: 4, status: "ready" }, "owner-p3");
  createChild(run, "E01", "Paper of crowd", "owner-p4", [], "paper");
  const split = path.join(run, "prep", "Z01-profile", "workspace", "split");
  put(path.join(split, "exploration.txt"), `${[...files.keys()].join("\n")}\n`);
  put(path.join(split, "holdout.txt"), "");
  prepareExploration(run);
  return { run, paper: findNode(run, "W01").dir };
}

function quoteEveryLine(t: TestContext, file: string, lines: string[]): Array<{ fragment: string; lines: string[] }> {
  const { run, paper } = corpusPaper(t, new Map([[file, `${lines.join("\n")}\n`]]));
  return lines.map((line, index) => {
    const start = index + 1;
    quoteSource(run, paper, { path: file, start, end: start });
    const id = `Q${String(index + 1).padStart(2, "0")}`;
    return { fragment: fragment(paper, id), lines: [line] };
  });
}

/** Each line is quoted on its own; its fragment must print exactly as the line, through pandoc and through Quarto. */
function assertRoundTrip(t: TestContext, file: string, lines: string[]): void {
  const quoted = quoteEveryLine(t, file, lines);
  const quartoOut = quartoPrintEach(t, quoted.map((q) => q.fragment));
  quoted.forEach((q, index) => {
    const expected = expectedPrint(q.lines, file, index + 1, index + 1);
    assert.deepEqual(pandocPrint(t, q.fragment), expected, `pandoc renders ${JSON.stringify(q.lines[0])}`);
    assert.deepEqual(quartoOut[index], expected, `quarto renders ${JSON.stringify(q.lines[0])}`);
  });
}

/** The nasty lines of the brief, each of which markdown or Quarto would read as markup. */
const NASTY = [
  "{{< section-inline-toc >}}",
  "{{% note %}}",
  "@jane and @team",
  "$5 and $10 costs",
  "*bold* _it_ `code`",
  "[link](http://x)",
  "- not a bullet",
  "1. not a list",
  "# not a heading",
  "> not a quote",
  "<div>",
  "&amp;",
  "a \\ backslash",
  "|a|b|",
  "~~x~~",
  "x^2^",
  "---",
  "a  b   c",
  "  leading spaces",
  "\ttab inside",
  "\"double\" and 'single' quotes",
  "a -- b --- c",
  "{{< a *b* -- \"c\" >}} and {{<pagebreak>}}",
  "trailing backslash \\",
];

/** Ten lines of the same shapes as the handbook's (shortcodes, Hugo panels, handles and code), for when the run's data is absent. */
const FIXTURE_LINES = [
  "{{< handbook-counts site=\"about\" >}}",
  "{{% alert title=\"Note\" color=\"info\" %}}",
  "Email `ar@gitlab.com` with the receipt.",
  "- Add your handle without the leading `@`.",
  "{{< youtube Kfdf2VAk9sM >}}",
  "If in doubt, contact [Corporate Development](mailto:acquisitions@gitlab.com).",
  "{{% panel header=\"**NOTES**\" header-bg=\"info\" %}}",
  "> @here, the plan has been invoked for @team.",
  "| Keep pipeline green | [`@gitlab-com/content-sites`](https://gitlab.com) |",
  "Fees are $5 and $10, paid by {{ user }}.",
];

/** Ten real lines from the run's exploration copy that hold a `{{` or an `@`, in folder order, when the run is present. */
function realLines(): string[] | undefined {
  const root = fileURLToPath(new URL("../../runs/gl1/analysis-data/exploration", import.meta.url));
  if (!existsSync(root)) return undefined;
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (found.length >= 10) return;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        for (const line of readFileSync(file, "utf8").split("\n")) {
          if (found.length >= 10) return;
          if (line.trim() === "" || line.length > 400 || !/\{\{|@/.test(line) || found.includes(line)) continue;
          if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(line)) continue;
          found.push(line.replace(/\r$/, "").trimEnd());
        }
      }
    }
  };
  walk(root);
  return found.length === 10 ? found : undefined;
}

/** Seeded pseudo-random lines of markup and text, so the same lines run every time. */
function randomLines(count: number): string[] {
  const tokens = ["{{<", ">}}", "{{%", "%}}", "{{{", "}}}", "@", "$", "*", "_", "`", "\\", "&amp;", "&#32;", "<div>", "# ", "- ", "1. ", "> ", "|", "~~", "^", "[", "](", "---", "--", "\"", "'", "–", "—", "é", "word", "a", " ", "  ", "\t", "{", "}", "%", "+", "=", ":", "!"];
  let seed = 20261026;
  const next = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const lines: string[] = [];
  while (lines.length < count) {
    let line = "";
    for (let i = 1 + next(12); i > 0; i -= 1) line += tokens[next(tokens.length)];
    if (line.trim() !== "") lines.push(line.replace(/\s+$/, ""));
  }
  return lines;
}

test("the escape backslashes a shortcode's braces and angle brackets, and punctuation generally", () => {
  assert.equal(escapeQuoteLine("{{< pagebreak >}}"), "\\{\\{\\< pagebreak \\>\\}\\}");
  assert.equal(escapeQuoteLine("{{% note %}}"), "\\{\\{\\% note \\%\\}\\}");
  assert.equal(escapeQuoteLine("a.b/c"), "a\\.b\\/c");
  assert.equal(escapeQuoteLine("a  b"), "a &#32;b", "a space after a space is an entity");
  assert.equal(escapeQuoteLine("\tx"), "&#9;x");
  assert.equal(escapeQuoteLine("café — “ok”"), "café — “ok”", "non-ASCII text is not escaped");
});

test("pandoc prints the nasty lines exactly as quoted", { skip: PANDOC_SKIP }, (t) => {
  for (const line of NASTY) {
    const printed = pandocPrint(t, `> ${escapeQuoteLine(line)}\n`);
    assert.deepEqual(printed, [`  ${line}`], JSON.stringify(line));
  }
});

test("quarto and pandoc print the nasty lines exactly as quoted, from real quotation fragments", { skip: BOTH_SKIP }, (t) => {
  assertRoundTrip(t, "nasty.md", NASTY);
});

test("quarto and pandoc print the handbook's lines exactly as quoted", { skip: BOTH_SKIP }, (t) => {
  const lines = realLines();
  if (lines === undefined) {
    t.diagnostic("runs/gl1 is absent: the fixture lines stand in for the handbook's");
    assertRoundTrip(t, "handbook.md", FIXTURE_LINES);
    return;
  }
  assertRoundTrip(t, "handbook.md", lines);
});

test("quarto and pandoc print seeded random markup exactly as quoted", { skip: BOTH_SKIP }, (t) => {
  assertRoundTrip(t, "random.md", randomLines(150));
});

test("verifyQuotes flags a raw fragment, one whose lines are not escaped", (t) => {
  const { run, paper, quotesDir } = fixture(t);
  quoteSource(run, paper, { path: "handbook/rules.md", start: 1, end: 4 });
  const file = path.join(quotesDir, "Q01.qmd");
  const raw = readFileSync(file, "utf8").replace("> \\# Rules", "> # Rules");
  writeFileSync(file, raw);
  const problems = verifyQuotes(run, paper);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /^Q01: .*escaped form/);
});

test("verifyQuotes flags an edit of one escaped character", (t) => {
  const { run, paper, quotesDir } = fixture(t);
  quoteSource(run, paper, { path: "handbook/rules.md", start: 1, end: 4 });
  const file = path.join(quotesDir, "Q01.qmd");
  writeFileSync(file, readFileSync(file, "utf8").replace("Be patient\\.", "Be patient\\!"));
  const problems = verifyQuotes(run, paper);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /^Q01: /);
});

test("quote_source refuses a line with a control character and writes nothing", (t) => {
  const { run, paper, exploration, quotesDir } = fixture(t);
  writeFileSync(path.join(exploration, "handbook", "ctrl.md"), "fine\nbad\u000cline\n");
  assert.throws(() => quoteSource(run, paper, { path: "handbook/ctrl.md", start: 2, end: 2 }), /control character/);
  assert.equal(existsSync(quotesDir), false, "nothing was written");
});

/** Names whose raw form would break an HTML comment, open a shortcode or carry markup into the header. */
const HOSTILE_NAMES = [
  "handbook/bad--!>name.md",
  "handbook/a -- > b.md",
  "handbook/x--{{< meta title >}} *y*.md",
  "handbook/tick`s.md",
  "handbook/sp ace.md",
  "handbook/café.md",
  "handbook/a--b.md",
  "handbook/{{<meta>}}.md",
];
const HOSTILE_LINE = "bang *y* {{< meta title >}}";

test("headerSource leaves ordinary names as they are and percent-encodes everything else", () => {
  assert.equal(headerSource("handbook/rules.md"), "handbook/rules.md");
  assert.equal(headerSource("handbook/a-b_c~d.md"), "handbook/a-b_c~d.md");
  assert.equal(headerSource("handbook/a--b.md"), "handbook/a-%2Db.md", "a dash that follows a dash is %2D");
  assert.equal(headerSource("handbook/---x"), "handbook/-%2D-x", "the third dash follows an encoded one, so it stays");
  assert.equal(headerSource("handbook/bad--!>name.md"), "handbook/bad-%2D%21%3Ename.md");
  assert.equal(headerSource("handbook/a -- > b.md"), "handbook/a%20-%2D%20%3E%20b.md");
  assert.equal(headerSource("handbook/{{< meta title >}} *y*.md"), "handbook/%7B%7B%3C%20meta%20title%20%3E%7D%7D%20%2Ay%2A.md");
  assert.equal(headerSource("handbook/tick`s.md"), "handbook/tick%60s.md");
  assert.equal(headerSource("handbook/café.md"), "handbook/caf%C3%A9.md", "UTF-8 bytes, uppercase hex");
  assert.equal(headerSource("handbook/a%b.md"), "handbook/a%25b.md");
});

test("headerSource output holds no double hyphen and no character that could close or open markup", () => {
  for (const name of [...HOSTILE_NAMES, "a--->b", "--!>", "-- >", "{{{<x>}}}", "<!-- x -->"]) {
    assert.doesNotMatch(headerSource(name), /--|[<>!{}` ]/, JSON.stringify(name));
  }
});

test("quote_source refuses a name containing -->, which cannot be made safe in a header", (t) => {
  const { run, paper } = corpusPaper(t, new Map([["handbook/a-->b.md", "text\n"]]));
  assert.throws(() => quoteSource(run, paper, { path: "handbook/a-->b.md", start: 1, end: 1 }), /-->/);
  assert.equal(existsSync(path.join(paper, "workspace", "embeds", "quotes")), false, "nothing was written");
});

test("hostile names quote into fragments whose pandoc and Quarto text is only the quotation and its source line", { skip: BOTH_SKIP }, (t) => {
  const { run, paper } = corpusPaper(t, new Map(HOSTILE_NAMES.map((name) => [name, `${HOSTILE_LINE}\n`])));
  const quoted = HOSTILE_NAMES.map((name, index) => {
    quoteSource(run, paper, { path: name, start: 1, end: 1 });
    return { name, fragment: fragment(paper, `Q${String(index + 1).padStart(2, "0")}`) };
  });
  const quartoOut = quartoPrintEach(t, quoted.map((q) => q.fragment));
  quoted.forEach((q, index) => {
    const expected = expectedPrint([HOSTILE_LINE], q.name, 1, 1);
    const printed = pandocPrint(t, q.fragment);
    assert.doesNotMatch(printed.join("\n"), /quote Q|<!--/, `pandoc shows no header text for ${q.name}`);
    assert.deepEqual(printed, expected, `pandoc renders ${q.name}`);
    assert.deepEqual(quartoOut[index], expected, `quarto renders ${q.name}`);
  });
  assert.deepEqual(verifyQuotes(run, paper), [], "every hostile fragment verifies clean");
});

test("a fragment whose header was edited is a problem, even when the quoted text is unchanged", (t) => {
  const { run, paper } = corpusPaper(t, new Map([["handbook/a--b.md", `${HOSTILE_LINE}\n`]]));
  quoteSource(run, paper, { path: "handbook/a--b.md", start: 1, end: 1 });
  assert.deepEqual(verifyQuotes(run, paper), []);
  const file = path.join(paper, "workspace", "embeds", "quotes", "Q01.qmd");
  const header = readFileSync(file, "utf8").split("\n")[0] as string;
  assert.ok(header.includes("source=handbook/a-%2Db.md"), "the header carries the encoded name");
  writeFileSync(file, readFileSync(file, "utf8").replace(header, header.replace("a-%2Db.md", "a--b.md")));
  const problems = verifyQuotes(run, paper);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /^Q01: /);
});

test("verifyQuotes names every entry when the hold-out list cannot be read", (t) => {
  const { run, paper, quotesDir } = fixture(t);
  quoteSource(run, paper, { path: "handbook/rules.md", start: 1, end: 4 });
  quoteSource(run, paper, { path: "handbook/crlf.md", start: 1, end: 2 });
  unlinkSync(path.join(run, "prep", "Z01-profile", "workspace", "split", "holdout.txt"));
  const problems = verifyQuotes(run, paper);
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.match(problems[0] ?? "", /^Q01: .*holdout\.txt is missing/);
  assert.match(problems[1] ?? "", /^Q02: .*holdout\.txt is missing/);
  assert.equal(existsSync(quotesDir), true);
});

test("verifyQuotes reports a quotes folder that is a link once, not once per entry", (t) => {
  const { run, paper, quotesDir } = fixture(t);
  quoteSource(run, paper, { path: "handbook/rules.md", start: 1, end: 4 });
  const moved = `${quotesDir}-moved`;
  renameSync(quotesDir, moved);
  symlinkSync(moved, quotesDir);
  const problems = verifyQuotes(run, paper);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /is a link/);
});
