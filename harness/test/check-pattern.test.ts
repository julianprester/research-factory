import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { checkPattern } from "../tools/check-pattern.ts";
import { commitFile, createChild, initRun } from "../tree.ts";

const CHECK_PATTERN = fileURLToPath(new URL("../tools/check-pattern.ts", import.meta.url));

const MEASURE = "# Measure\n\nE03 — the share of pages that mention etiquette.\n";

const CARD_HEADINGS = ["## Measure", "## Result", "## Verdict", "## Robustness", "## Worst fits", "## Deviations"];

function card(verdict = "held"): string {
  return [
    "## Measure",
    "The share of pages that mention etiquette.",
    "",
    "## Result",
    "12 of 40 pages (30%).",
    "",
    "## Verdict",
    verdict,
    "The predicted direction held in every slice.",
    "",
    "## Robustness",
    "The same ordering holds at depth 2.",
    "",
    "## Worst fits",
    "- teamops/people-group.md",
    "",
    "## Deviations",
    "none",
    "",
  ].join("\n");
}

function handoff(verdict = "held"): string {
  return [
    "Status: DONE",
    "Summary: measured 40 pages",
    `Verdict: ${verdict}`,
    "",
    "Evidence: workspace/pattern.md, workspace/results/counts.csv",
    "",
  ].join("\n");
}

function makeRun(t: TestContext): string {
  const runDir = mkdtempSync(path.join(tmpdir(), "ctc-check-pattern-"));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  return runDir;
}

function git(runDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", runDir, ...args], { encoding: "utf8" }).trim();
}

/** Commit exactly `paths` as some other actor (a worker writing a card). */
function commitPaths(runDir: string, ...paths: string[]): void {
  git(runDir, "add", "--", ...paths);
  execFileSync(
    "git",
    ["-C", runDir, "-c", "user.name=worker", "-c", "user.email=worker@ctc.local", "commit", "-m", "write", "--", ...paths],
    { encoding: "utf8" },
  );
}

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

interface Fixture {
  run: string;
  nodeDir: string;
  relMeasure: string;
  relPattern: string;
  relHandoff: string;
}

interface FixtureOptions {
  cardVerdict?: string;
  handoffVerdict?: string;
  /** Leave workspace/pattern.md uncommitted (the brief only orders it when it is committed). */
  commitPattern?: boolean;
}

/** A pattern node that is pre-registered, ordered and complete: the check must pass. */
function patternNode(t: TestContext, opts: FixtureOptions = {}): Fixture {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  const node = createChild(run, "D01", "E03 Etiquette", "owner-p1");
  const nodeDir = node.dir;
  const rel = (relPath: string): string => `patterns/${path.basename(nodeDir)}/${relPath}`;
  const relMeasure = rel("workspace/measure.md");
  const relPattern = rel("workspace/pattern.md");
  const relHandoff = rel("handoff.md");

  write(path.join(nodeDir, "workspace", "measure.md"), MEASURE);
  commitFile(run, relMeasure, "worker-T01", "[P1:preregister] T01 — measure.md");
  write(path.join(nodeDir, "workspace", "pattern.md"), card(opts.cardVerdict));
  write(path.join(nodeDir, "handoff.md"), handoff(opts.handoffVerdict));
  if (opts.commitPattern !== false) commitPaths(run, relPattern);
  return { run, nodeDir, relMeasure, relPattern, relHandoff };
}

test("a complete, correctly ordered node has no problems", (t) => {
  const { run, nodeDir } = patternNode(t);
  assert.deepEqual(checkPattern(run, nodeDir), { problems: [] });
});

test("a blind node may report open, and a non-blind one may not", (t) => {
  const blind = patternNode(t, { cardVerdict: "open", handoffVerdict: "open" });
  assert.deepEqual(checkPattern(blind.run, blind.nodeDir, { blind: true }), { problems: [] });

  const { problems } = checkPattern(blind.run, blind.nodeDir);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /open is only for blind scanners/);
});

test("a missing measure.md is a problem", (t) => {
  const { run, nodeDir } = patternNode(t);
  rmSync(path.join(nodeDir, "workspace", "measure.md"));
  const { problems } = checkPattern(run, nodeDir);
  assert.ok(problems.some((problem) => /workspace\/measure\.md is missing/.test(problem)), problems.join("\n"));
});

test("a measure.md with no [P1:preregister] commit is a problem", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  const node = createChild(run, "D01", "E03 Etiquette", "owner-p1");
  const relMeasure = `patterns/${path.basename(node.dir)}/workspace/measure.md`;
  write(path.join(node.dir, "workspace", "measure.md"), MEASURE);
  commitPaths(run, relMeasure); // committed, but never pre-registered
  write(path.join(node.dir, "workspace", "pattern.md"), card());
  write(path.join(node.dir, "handoff.md"), handoff());

  const { problems } = checkPattern(run, node.dir);
  assert.ok(problems.some((problem) => /no \[P1:preregister\] T01 commit/.test(problem)), problems.join("\n"));
});

test("a measure.md edited after pre-registration is a problem", (t) => {
  const { run, nodeDir } = patternNode(t);
  writeFileSync(path.join(nodeDir, "workspace", "measure.md"), `${MEASURE}\nAnd a threshold added later.\n`);
  const { problems } = checkPattern(run, nodeDir);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /workspace\/measure\.md changed after pre-registration at [0-9a-f]{7,}/);
});

test("a measure.md swept into an earlier commit is still pre-registerable unchanged", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  const node = createChild(run, "D01", "E03 Etiquette", "owner-p1");
  const relMeasure = `patterns/${path.basename(node.dir)}/workspace/measure.md`;
  write(path.join(node.dir, "workspace", "measure.md"), MEASURE);
  // An owner tree operation commits with `git add -A` and sweeps the file in.
  createChild(run, "D01", "Another", "owner-p1");
  assert.equal(git(run, "status", "--porcelain"), "", "the file was swept into the tree operation's commit");
  const before = Number(git(run, "rev-list", "--count", "HEAD"));

  commitFile(run, relMeasure, "worker-T01", "[P1:preregister] T01 — measure.md");
  assert.equal(Number(git(run, "rev-list", "--count", "HEAD")), before + 1, "an unchanged file still gets a marker commit");

  write(path.join(node.dir, "workspace", "pattern.md"), card());
  write(path.join(node.dir, "handoff.md"), handoff());
  commitPaths(run, `patterns/${path.basename(node.dir)}/workspace/pattern.md`);
  assert.deepEqual(checkPattern(run, node.dir), { problems: [] });
});

test("measurement files in the pre-registration commit's tree are flagged", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  const node = createChild(run, "D01", "E03 Etiquette", "owner-p1");
  const base = `patterns/${path.basename(node.dir)}`;
  write(path.join(node.dir, "workspace", "measure.md"), MEASURE);
  write(path.join(node.dir, "workspace", "scripts", "scan.py"), "print('measured')\n");
  write(path.join(node.dir, "workspace", "results", "counts.csv"), "slice,n\n");
  // A tree operation's `git add -A` commits the half-finished measurement
  // before the worker ever registers the measure.
  commitPaths(run, `${base}/workspace/scripts`, `${base}/workspace/results`);
  commitFile(run, `${base}/workspace/measure.md`, "worker-T01", "[P1:preregister] T01 — measure.md");
  write(path.join(node.dir, "workspace", "pattern.md"), card());
  write(path.join(node.dir, "handoff.md"), handoff());
  commitPaths(run, `${base}/workspace/pattern.md`);

  const { problems } = checkPattern(run, node.dir);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.equal(
    problems[0],
    "measurement files existed at pre-registration: workspace/results/counts.csv, workspace/scripts/scan.py",
  );
});

test("measurement files written after pre-registration are fine", (t) => {
  const { run, nodeDir } = patternNode(t);
  write(path.join(nodeDir, "workspace", "scripts", "scan.py"), "print('after')\n");
  write(path.join(nodeDir, "workspace", "results", "counts.csv"), "slice,n\n");
  assert.deepEqual(checkPattern(run, nodeDir), { problems: [] });
});

test("pattern.md committed before pre-registration is a problem", (t) => {
  const run = makeRun(t);
  initRun(run, "data", "interest");
  const node = createChild(run, "D01", "E03 Etiquette", "owner-p1");
  const relMeasure = `patterns/${path.basename(node.dir)}/workspace/measure.md`;
  const relPattern = `patterns/${path.basename(node.dir)}/workspace/pattern.md`;
  write(path.join(node.dir, "workspace", "measure.md"), MEASURE);
  write(path.join(node.dir, "workspace", "pattern.md"), card());
  write(path.join(node.dir, "handoff.md"), handoff());
  commitPaths(run, relPattern); // the card got in first
  commitFile(run, relMeasure, "worker-T01", "[P1:preregister] T01 — measure.md");

  // A card committed before the marker is two findings: it was in the marker's
  // tree, and its first commit is not a descendant of the marker.
  const { problems } = checkPattern(run, node.dir);
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.match(problems[0] ?? "", /measurement files existed at pre-registration: workspace\/pattern\.md/);
  assert.match(problems[1] ?? "", /workspace\/pattern\.md's first commit [0-9a-f]{7,} is not after pre-registration/);
});

test("pattern.md that is not committed at all is not an ordering problem", (t) => {
  const { run, nodeDir } = patternNode(t, { commitPattern: false });
  assert.deepEqual(checkPattern(run, nodeDir), { problems: [] });
});

test("a missing pattern.md heading is a problem", (t) => {
  const { run, nodeDir } = patternNode(t);
  writeFileSync(path.join(nodeDir, "workspace", "pattern.md"), card().replace("## Worst fits", "Worst fits"));
  const { problems } = checkPattern(run, nodeDir);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /workspace\/pattern\.md lacks the heading "## Worst fits"/);

  writeFileSync(path.join(nodeDir, "workspace", "pattern.md"), ["## Measure", "## Result"].join("\n"));
  const missing = checkPattern(run, nodeDir).problems;
  for (const heading of CARD_HEADINGS.slice(2)) {
    assert.ok(
      missing.some((problem) => problem.includes(`lacks the heading "${heading}"`)),
      `${heading} is reported: ${missing.join("\n")}`,
    );
  }
});

test("a handoff verdict that differs from pattern.md's verdict is a problem", (t) => {
  const { run, nodeDir } = patternNode(t, { cardVerdict: "held", handoffVerdict: "violated" });
  const { problems } = checkPattern(run, nodeDir);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /handoff verdict "violated" differs from pattern\.md's verdict "held"/);
});

test("handoff.md line 3 must be a valid Verdict", (t) => {
  const { run, nodeDir } = patternNode(t);
  writeFileSync(path.join(nodeDir, "handoff.md"), "Status: DONE\nSummary: measured\n\nVerdict: held\n");

  const { problems } = checkPattern(run, nodeDir);
  assert.ok(
    problems.some((problem) => /handoff\.md line 3 is not a Verdict: line/.test(problem)),
    problems.join("\n"),
  );

  writeFileSync(path.join(nodeDir, "handoff.md"), "Status: DONE\nSummary: measured\nVerdict: maybe\n");
  const bad = checkPattern(run, nodeDir).problems;
  assert.ok(
    bad.some((problem) => /invalid verdict "maybe"/.test(problem)),
    bad.join("\n"),
  );
});

test("a script under workspace/scripts mentioning the hold-out is a problem", (t) => {
  const mentions = ["holdout", "HOLDOUT", "hold_out", "hold out", "Hold-Out"];
  for (const mention of mentions) {
    const { run, nodeDir } = patternNode(t);
    write(
      path.join(nodeDir, "workspace", "scripts", "scan.py"),
      `# reads ${mention}.txt\nprint("counted")\n`,
    );
    const { problems } = checkPattern(run, nodeDir);
    assert.equal(problems.length, 1, `${mention}: ${problems.join("\n")}`);
    assert.match(problems[0] ?? "", /workspace\/scripts\/scan\.py mentions the hold-out/);
  }
});

test("a script that does not mention the hold-out is fine", (t) => {
  const { run, nodeDir } = patternNode(t);
  write(path.join(nodeDir, "workspace", "scripts", "scan.py"), "# reads exploration.txt\nprint('ok')\n");
  assert.deepEqual(checkPattern(run, nodeDir), { problems: [] });
});

test("the CLI prints ok and exits 0 for a good node", (t) => {
  const { nodeDir } = patternNode(t);
  const result = spawnSync(process.execPath, [CHECK_PATTERN, nodeDir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), ["ok"]);
});

test("the CLI prints one problem per line and exits 1 for a bad node", (t) => {
  const { run, nodeDir } = patternNode(t);
  writeFileSync(path.join(nodeDir, "workspace", "measure.md"), `${MEASURE}\nlate edit\n`);
  write(path.join(nodeDir, "workspace", "scripts", "scan.py"), "# reads holdout.txt\n");
  assert.equal(checkPattern(run, nodeDir).problems.length, 2, "two independent problems");

  const result = spawnSync(process.execPath, [CHECK_PATTERN, nodeDir], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 2, result.stdout);
  assert.match(lines[0] ?? "", /changed after pre-registration/);
  assert.match(lines[1] ?? "", /mentions the hold-out/);
});

test("the CLI accepts --blind and rejects a bad invocation", (t) => {
  const blind = patternNode(t, { cardVerdict: "open", handoffVerdict: "open" });
  const ok = spawnSync(process.execPath, [CHECK_PATTERN, blind.nodeDir, "--blind"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), "ok");

  const usage = spawnSync(process.execPath, [CHECK_PATTERN], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  const unknown = spawnSync(process.execPath, [CHECK_PATTERN, blind.nodeDir, "--nope"], { encoding: "utf8" });
  assert.equal(unknown.status, 2);
});
