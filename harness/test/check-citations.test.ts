import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkCitations,
  checkQuotes,
  extractChunkIds,
  extractQuotedCitations,
  normaliseForQuote,
} from "../tools/check-citations.ts";

const CHECK = fileURLToPath(new URL("../tools/check-citations.ts", import.meta.url));

function makeTempDir(t: TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ctc-citations-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A stub `deepis` for the end-to-end tests. It answers `metadata <ids> -f json`
 * exactly like the real one (known ids in `papers[].chunk_ids`, unknown ones
 * omitted, always exit 0) and `context <id> --before N --after N -f json` with
 * `{chunks: [{chunk_id, target, content}]}`: the target chunk from `STUB_CONTEXT`
 * when `--before 0 --after 0`, plus neighbours from `STUB_NEIGHBOURS` when the
 * window is wider. Every metadata batch size is appended to `STUB_LOG`, and so is
 * every context id, prefixed `context `.
 */
const STUB_DEEPIS = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const log = (line) => {
  if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, line + "\\n");
};
if (args[0] === "metadata") {
  const known = new Set((process.env.STUB_KNOWN || "").split(",").filter((id) => id.length > 0));
  const ids = (args[1] || "").split(",").filter((id) => id.length > 0);
  log(String(ids.length));
  const found = ids.filter((id) => known.has(id));
  const papers = found.length > 0 ? [{ chunk_ids: found.map(Number) }] : [];
  process.stdout.write(JSON.stringify({ papers }) + "\\n");
  process.exit(0);
}
if (args[0] === "context") {
  const id = args[1];
  const before = Number(args[args.indexOf("--before") + 1] || 0);
  const after = Number(args[args.indexOf("--after") + 1] || 0);
  log("context " + id);
  const contents = JSON.parse(process.env.STUB_CONTEXT || "{}");
  const neighbours = JSON.parse(process.env.STUB_NEIGHBOURS || "{}");
  const chunks = [];
  if (contents[id] !== undefined) {
    chunks.push({ chunk_id: Number(id), target: true, content: contents[id] });
  }
  if (before > 0 || after > 0) {
    for (const neighbour of neighbours[id] || []) {
      chunks.push({ chunk_id: Number(neighbour[0]), target: false, content: neighbour[1] });
    }
  }
  process.stdout.write(JSON.stringify({ chunks }) + "\\n");
  process.exit(0);
}
console.error("stub deepis: unsupported command " + args[0]);
process.exit(2);
`;

interface Stub {
  env: NodeJS.ProcessEnv;
  calls: () => number[];
}

interface StubOptions {
  context?: Record<string, string>;
  neighbours?: Record<string, [string, string][]>;
}

/** Put a stub `deepis` first on PATH and expose the batch sizes it was called with. */
function stubDeepis(t: TestContext, known: string[], options: StubOptions = {}): Stub {
  const root = makeTempDir(t);
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "deepis"), STUB_DEEPIS, { mode: 0o755 });
  const log = path.join(root, "calls.log");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    STUB_KNOWN: known.join(","),
    STUB_LOG: log,
    STUB_CONTEXT: JSON.stringify(options.context ?? {}),
    STUB_NEIGHBOURS: JSON.stringify(options.neighbours ?? {}),
  };
  return {
    env,
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => /^\d+$/.test(line))
        .map(Number),
  };
}

test("the CLI exits 0 and says ok when every citation resolves", (t) => {
  const root = makeTempDir(t);
  const file = path.join(root, "paper.md");
  writeFileSync(file, "Real [@111], also real [@222;@111] and paged [-@222, p. 4].\n");
  const stub = stubDeepis(t, ["111", "222"]);

  const result = spawnSync(process.execPath, [CHECK, file], { encoding: "utf8", env: stub.env });

  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /ok 2 citations/);
  assert.equal(result.stderr, "");
  assert.deepEqual(stub.calls(), [2], "one batch of the two unique ids");
});

test("the CLI exits 1 and names the unknown id", (t) => {
  const root = makeTempDir(t);
  const file = path.join(root, "paper.md");
  writeFileSync(file, "Known [@111] and fake [@999999999].\n");
  const stub = stubDeepis(t, ["111"]);

  const result = spawnSync(process.execPath, [CHECK, file], { encoding: "utf8", env: stub.env });

  assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /999999999/);
  assert.match(result.stderr, /missing chunk id 999999999/);
  assert.doesNotMatch(result.stdout, /ok/);
});

test("the CLI resolves 120 ids in batches of at most 50", (t) => {
  const root = makeTempDir(t);
  const file = path.join(root, "paper.md");
  const ids = Array.from({ length: 120 }, (_, i) => String(10_000 + i));
  writeFileSync(file, `${ids.map((id) => `[@${id}]`).join(" ")}\n`);
  const stub = stubDeepis(t, ids);

  const result = spawnSync(process.execPath, [CHECK, file], { encoding: "utf8", env: stub.env });

  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /ok 120 citations/);
  const calls = stub.calls();
  assert.deepEqual(calls, [50, 50, 20], "three batches, none over the limit");
  assert.ok(
    calls.every((size) => size <= 50),
    `every deepis call must stay at or below 50 ids, got ${calls.join(", ")}`,
  );
});

test("extractChunkIds reads single, multiple and paged citation forms", () => {
  const markdown = [
    "Organizational control is central [@123].",
    "Two at once [@1;@2], and a page reference [-@3, p. 4].",
  ].join("\n");

  assert.deepEqual(extractChunkIds(markdown), ["123", "1", "2", "3"]);
});

test("extractChunkIds deduplicates and keeps first-seen order", () => {
  assert.deepEqual(extractChunkIds("[@5] then [@5;@6] then [-@5]"), ["5", "6"]);
});

test("extractChunkIds ignores emails and brackets that are not citations", () => {
  const markdown = "Mail foo@123.com, see [the handbook] and [contact foo@456.com], but cite [@7].";

  assert.deepEqual(extractChunkIds(markdown), ["7"]);
});

test("extractChunkIds returns nothing for prose without citations", () => {
  assert.deepEqual(extractChunkIds("No citations here. [see above]"), []);
});

test("checkCitations returns exactly the ids the resolver does not know", () => {
  const seen: string[][] = [];
  const resolve = (ids: string[]): Set<string> => {
    seen.push(ids);
    return new Set(["11", "33"]);
  };

  assert.deepEqual(checkCitations(["11", "22", "33"], resolve), { missing: ["22"] });
  assert.deepEqual(seen, [["11", "22", "33"]]);
});

test("checkCitations reports nothing missing when every id resolves", () => {
  assert.deepEqual(checkCitations(["1", "2"], () => new Set(["1", "2"])), { missing: [] });
});

test("checkCitations reports everything missing when the resolver knows nothing", () => {
  assert.deepEqual(checkCitations(["1", "2"], () => new Set()), { missing: ["1", "2"] });
});

test("the CLI says ok and exits 0 for a file without citations", (t) => {
  const root = makeTempDir(t);
  const file = path.join(root, "paper.md");
  writeFileSync(file, "Plain prose, no citations [@].\n");

  // An empty PATH makes `deepis` unresolvable; a citation-free file must not shell out at all.
  const result = spawnSync(process.execPath, [CHECK, file], {
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok 0 citations/);
});

test("the CLI exits 2 with a clear message when deepis is unreachable", (t) => {
  const root = makeTempDir(t);
  const file = path.join(root, "paper.md");
  writeFileSync(file, "A real-looking citation [@123].\n");

  const result = spawnSync(process.execPath, [CHECK, file], {
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
  });

  assert.equal(result.status, 2, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /deepis/i);
});

// --- verbatim quote check -------------------------------------------------

test("normaliseForQuote unifies case, whitespace, quote marks, dashes and trailing punctuation", () => {
  assert.equal(
    normaliseForQuote("  The \u201cRule\u201d  Is\u2014Stated\u2026.  "),
    'the "rule" is-stated\u2026',
  );
  assert.equal(normaliseForQuote("The organisation\u2019s rule, filed. "), 'the organisation"s rule, filed');
  assert.equal(
    normaliseForQuote("what the organization \u2018is\u2019 means"),
    'what the organization "is" means',
  );
});

test("extractQuotedCitations pairs a quote with the citation that follows it", () => {
  const markdown = 'Theory says "a rule is written down and filed" [@123] and more.';

  assert.deepEqual(extractQuotedCitations(markdown), [
    { quote: "a rule is written down and filed", ids: ["123"], line: 1 },
  ]);
});

test("extractQuotedCitations reads curly quotes and several ids in one bracket", () => {
  const markdown = 'States \u201ca rule is written down and filed here\u201d [@1;@2].';

  assert.deepEqual(extractQuotedCitations(markdown), [
    { quote: "a rule is written down and filed here", ids: ["1", "2"], line: 1 },
  ]);
});

test("extractQuotedCitations reports the line the quote starts on", () => {
  const markdown = ['# Heading', '', 'Prose "a rule is written down and filed" [@7].'].join("\n");

  assert.equal(extractQuotedCitations(markdown)[0]?.line, 3);
});

test("extractQuotedCitations ignores a quote whose citation is more than 60 characters away", () => {
  const markdown = `A "rule written down and filed for the record" is discussed at length, over ${"many ".repeat(12)}words, before [@123].`;

  assert.deepEqual(extractQuotedCitations(markdown), []);
});

test("extractQuotedCitations ignores a quote with no following citation at all", () => {
  assert.deepEqual(extractQuotedCitations('He said "this is plainly a long quotation" to the room.'), []);
});

test("extractQuotedCitations ignores quotes inside fenced code blocks", () => {
  const markdown = ["```", '"a rule written down and filed for the record" [@123]', "```"].join("\n");

  assert.deepEqual(extractQuotedCitations(markdown), []);
});

test("extractQuotedCitations does not mispair quotes around a shorter quotation", () => {
  // A naive any-two-quotes scan pairs the closing quote of the short span with
  // the opening quote of the long one and loses both real spans.
  const markdown =
    'bots perform "short roles" and supervisory bots weaken "the centrality of human participants" [@9].';
  const found = extractQuotedCitations(markdown);

  assert.deepEqual(found, [
    { quote: "the centrality of human participants", ids: ["9"], line: 1 },
  ]);
});

type Fetcher = (id: string) => string | null;

function chunkFetcher(texts: Record<string, string>): Fetcher {
  return (id) => texts[id] ?? null;
}

const noNeighbours = (): { id: string; text: string }[] => [];

test("checkQuotes passes a quote that is verbatim in a cited chunk", () => {
  const items = [{ quote: "a rule is written down and filed", ids: ["1"], line: 1 }];
  const { bad } = checkQuotes(
    items,
    chunkFetcher({ "1": "The rule: a rule is written down and filed, exactly." }),
    noNeighbours,
  );

  assert.deepEqual(bad, []);
});

test("checkQuotes passes a quote that differs only in spacing and case", () => {
  const items = [{ quote: "A  Rule is written DOWN and filed", ids: ["1"], line: 1 }];
  const { bad } = checkQuotes(items, chunkFetcher({ "1": "a rule is written down and filed." }), noNeighbours);

  assert.deepEqual(bad, []);
});

test("checkQuotes passes a quote whose curly apostrophe differs from the chunk's straight one", () => {
  const items = [{ quote: "the organisation\u2019s written rule", ids: ["1"], line: 1 }];
  const { bad } = checkQuotes(items, chunkFetcher({ "1": "the organisation's written rule" }), noNeighbours);

  assert.deepEqual(bad, []);
});

test("checkQuotes passes a quote whose inner quote marks differ from the source's", () => {
  const items = [
    { quote: "organizational elites would like outsiders to see", ids: ["1"], line: 1 },
  ];
  const { bad } = checkQuotes(
    items,
    chunkFetcher({ "1": 'the way "organizational elites" would like outsiders to see the organization' }),
    noNeighbours,
  );

  assert.deepEqual(bad, []);
});

test("checkQuotes passes a quote with an ellipsis when both fragments occur", () => {
  const items = [
    { quote: "the first fragment is here \u2026 and the second fragment follows", ids: ["1"], line: 1 },
  ];
  const { bad } = checkQuotes(
    items,
    chunkFetcher({ "1": "the first fragment is here. Later, and the second fragment follows." }),
    noNeighbours,
  );

  assert.deepEqual(bad, []);
});

test("checkQuotes reports a quote that is only in a neighbour with foundIn set to that neighbour", () => {
  const items = [{ quote: "a rule that is written down and filed", ids: ["1"], line: 4 }];
  const { bad } = checkQuotes(
    items,
    chunkFetcher({ "1": "unrelated text entirely" }),
    (id) => (id === "1" ? [{ id: "2", text: "elsewhere: a rule that is written down and filed." }] : []),
  );

  assert.deepEqual(bad, [
    { quote: "a rule that is written down and filed", ids: ["1"], line: 4, foundIn: "2" },
  ]);
});

test("checkQuotes reports foundIn null when the quote is nowhere", () => {
  const items = [{ quote: "a rule that is written down and filed", ids: ["1"], line: 2 }];
  const { bad } = checkQuotes(items, chunkFetcher({ "1": "unrelated text entirely" }), noNeighbours);

  assert.deepEqual(bad, [
    { quote: "a rule that is written down and filed", ids: ["1"], line: 2, foundIn: null },
  ]);
});

test("the CLI exits 1 and points at the neighbour chunk that holds a misattributed quote", (t) => {
  const root = makeTempDir(t);
  const file = path.join(root, "paper.md");
  writeFileSync(
    file,
    'A verbatim quote "alpha beta gamma delta epsilon" [@111], and a neighbour quote "zeta eta theta iota kappa" [@222].\n',
  );
  const stub = stubDeepis(t, ["111", "222"], {
    context: {
      "111": "here alpha beta gamma delta epsilon appears.",
      "222": "nothing of the sort appears in this chunk.",
    },
    neighbours: { "222": [["223", "and zeta eta theta iota kappa appears next door."]] },
  });

  const result = spawnSync(process.execPath, [CHECK, file], { encoding: "utf8", env: stub.env });

  assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /quote not in cited chunk 222/);
  assert.match(result.stderr, /found in chunk 223/);
  assert.doesNotMatch(result.stdout, /ok/);
});
