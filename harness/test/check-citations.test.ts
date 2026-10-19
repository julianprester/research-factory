import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
