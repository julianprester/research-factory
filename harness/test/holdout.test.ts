import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { splitHoldout } from "../tools/holdout.ts";

const HOLDOUT = fileURLToPath(new URL("../tools/holdout.ts", import.meta.url));

const FRACTION = 0.2;
const SEED = 1;

/** Stratum as the tool defines it: first path segment, or "." for a top-level file. */
function stratumOf(file: string): string {
  const parts = file.split("/");
  return parts.length === 1 ? "." : (parts[0] ?? ".");
}

/**
 * A fixture with the shape of the smoke dataset: three multi-file strata, a
 * one-file stratum, and two top-level files (one stratum "."), plus paths in
 * deliberately unsorted order.
 */
function fixture(): string[] {
  const files: string[] = [];
  for (let i = 10; i >= 1; i--) files.push(`handbook/f${String(i).padStart(2, "0")}.md`);
  for (let i = 7; i >= 1; i--) files.push(`job-description-library/j${i}.md`);
  for (let i = 3; i >= 1; i--) files.push(`teamops/t${i}.md`);
  files.push("solo/only.md", "README.md", "teamops-loose.md");
  return files;
}

function counts(files: string[]): Map<string, { total: number; holdout: number }> {
  const byStratum = new Map<string, { total: number; holdout: number }>();
  for (const file of files) {
    const stratum = stratumOf(file);
    const entry = byStratum.get(stratum) ?? { total: 0, holdout: 0 };
    entry.total += 1;
    byStratum.set(stratum, entry);
  }
  return byStratum;
}

function makeTempDir(t: TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ctc-holdout-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function lines(file: string): string[] {
  return readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
}

test("same files and seed give an identical split, whatever the input order", () => {
  const files = fixture();
  const first = splitHoldout(files, { fraction: FRACTION, seed: SEED });
  const second = splitHoldout(files, { fraction: FRACTION, seed: SEED });
  const reversed = splitHoldout([...files].reverse(), { fraction: FRACTION, seed: SEED });

  assert.deepEqual(first, second);
  assert.deepEqual(first, reversed);
  assert.ok(first.holdout.length > 0, "fixture should produce a non-empty holdout");
});

test("a different seed gives a different split", () => {
  const files = fixture();
  const one = splitHoldout(files, { fraction: 0.5, seed: 1 });
  const two = splitHoldout(files, { fraction: 0.5, seed: 2 });

  assert.notDeepEqual(one, two);
});

test("the holdout is round(n x fraction) within one per stratum", () => {
  const files = fixture();
  const { holdout, exploration } = splitHoldout(files, { fraction: FRACTION, seed: SEED });

  // The split is a partition: no path is lost or duplicated.
  assert.deepEqual([...holdout, ...exploration].sort(), [...files].sort());
  assert.equal(new Set(holdout).size, holdout.length);

  const expected = counts(files);
  for (const file of holdout) {
    const entry = expected.get(stratumOf(file));
    assert.ok(entry, `holdout file ${file} belongs to a known stratum`);
    entry.holdout += 1;
  }
  for (const [stratum, { total, holdout: taken }] of expected) {
    const target = Math.round(total * FRACTION);
    assert.ok(
      Math.abs(taken - target) <= 1,
      `stratum ${stratum}: ${taken} holdout of ${total}, expected ${target} +/- 1`,
    );
    assert.equal(taken, Math.min(target, Math.max(total - 1, 0)), `stratum ${stratum}: exact count`);
  }
});

test("both halves are sorted, so a split is a stable list", () => {
  const { holdout, exploration } = splitHoldout(fixture(), { fraction: FRACTION, seed: SEED });

  assert.deepEqual(holdout, [...holdout].sort());
  assert.deepEqual(exploration, [...exploration].sort());
  assert.equal(new Set([...holdout, ...exploration]).size, fixture().length);
});

test("a one-file stratum stays in exploration", () => {
  const { holdout, exploration } = splitHoldout(fixture(), { fraction: FRACTION, seed: SEED });

  assert.ok(exploration.includes("solo/only.md"));
  assert.ok(!holdout.includes("solo/only.md"));
});

test("a stratum is never entirely held out, even at fraction 1", () => {
  const files = ["handbook/a.md", "handbook/b.md", "handbook/c.md", "README.md"];
  const { holdout, exploration } = splitHoldout(files, { fraction: 1, seed: 4 });

  assert.equal(exploration.length, 2, "one exploration file per stratum");
  assert.equal(holdout.length, 2);
  assert.ok(exploration.includes("README.md"));
});

test("holdout.ts collects the dataset by extension, writes sorted lists and prints a table", (t) => {
  const root = makeTempDir(t);
  const dataset = path.join(root, "dataset");
  const outDir = path.join(root, "out");
  const markdown = [
    "alpha/a1.md",
    "alpha/a2.md",
    "alpha/a3.md",
    "alpha/a4.md",
    "beta/b1.md",
    "beta/b2.md",
    "notes.md",
  ];
  for (const relative of markdown) {
    mkdirSync(path.dirname(path.join(dataset, relative)), { recursive: true });
    writeFileSync(path.join(dataset, relative), "# doc\n");
  }
  writeFileSync(path.join(dataset, "skip.txt"), "not markdown\n");

  const result = spawnSync(
    process.execPath,
    [HOLDOUT, dataset, outDir, "--fraction", "0.5", "--seed", "7"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);

  const holdout = lines(path.join(outDir, "holdout.txt"));
  const exploration = lines(path.join(outDir, "exploration.txt"));
  assert.deepEqual([...holdout, ...exploration].sort(), [
    "alpha/a1.md",
    "alpha/a2.md",
    "alpha/a3.md",
    "alpha/a4.md",
    "beta/b1.md",
    "beta/b2.md",
    "notes.md",
  ]);
  assert.deepEqual(holdout, [...holdout].sort());
  assert.deepEqual(exploration, [...exploration].sort());

  const table = new Map(
    result.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((cells) => cells.length === 3)
      .map((cells) => [cells[0], `${cells[1]} ${cells[2]}`]),
  );
  assert.equal(table.get("alpha"), "4 2");
  assert.equal(table.get("beta"), "2 1");
  assert.equal(table.get("."), "1 0");
});
