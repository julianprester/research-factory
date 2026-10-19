import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { checkCitations, extractChunkIds } from "../tools/check-citations.ts";

const CHECK = fileURLToPath(new URL("../tools/check-citations.ts", import.meta.url));

function makeTempDir(t: TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ctc-citations-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A stub `deepis` for the end-to-end tests: it answers `metadata <ids> -f json`
 * exactly like the real one (known ids in `papers[].chunk_ids`, unknown ones
 * omitted, always exit 0) and appends the size of every batch it resolves to a
 * log file. `STUB_KNOWN` lists the ids it knows, `STUB_LOG` the log path.
 */
const STUB_DEEPIS = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "metadata") {
  console.error("stub deepis: unsupported command " + args[0]);
  process.exit(2);
}
const known = new Set((process.env.STUB_KNOWN || "").split(",").filter((id) => id.length > 0));
const ids = (args[1] || "").split(",").filter((id) => id.length > 0);
if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, ids.length + "\\n");
const found = ids.filter((id) => known.has(id));
const papers = found.length > 0 ? [{ chunk_ids: found.map(Number) }] : [];
process.stdout.write(JSON.stringify({ papers }) + "\\n");
`;

interface Stub {
  env: NodeJS.ProcessEnv;
  calls: () => number[];
}

/** Put a stub `deepis` first on PATH and expose the batch sizes it was called with. */
function stubDeepis(t: TestContext, known: string[]): Stub {
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
  };
  return {
    env,
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
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
