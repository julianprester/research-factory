// The shared fixture of the Phase 3 owner-tool tests: a real temp run with a puzzle in
// Phase 3 (its snapshot sources written), an explanation node under it, a fake `Exec`
// for the container, and the pieces of a finished node (argument, reports, review).
// `explain-tools.test.ts` tests each tool against it; `phase3-e2e.test.ts` drives the
// whole chain through it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext } from "node:test";

import type { Exec } from "../analysis/run.ts";
import { closeRound, openRound } from "../explain/tools.ts";
import ownerExtension from "../owner-extension.ts";
import { createChild, initRun, updateNode } from "../tree.ts";

export function tempDir(t: TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ctc-explain-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export async function rejectMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("expected the call to be refused");
}

export function git(run: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@ctc.local", ...args], { cwd: run, encoding: "utf8" });
}

/** Commit whatever the fixture or a "worker" wrote, so the next tool's own commits are what `status` shows. */
export function settle(run: string): void {
  git(run, "add", "-A");
  git(run, "commit", "--allow-empty", "-q", "-m", "fixture");
}

export const subjects = (run: string) => git(run, "log", "--format=%s").trim().split("\n");
export const lastFiles = (run: string) => git(run, "show", "--name-status", "--format=", "HEAD").trim().split("\n").sort();

export function plan(...letters: string[]): string {
  return [
    "# Plan",
    "",
    "## Questions",
    "- Does the ordering hold at depth 2?",
    "",
    "## Tasks",
    "",
    ...letters.flatMap((letter) => [`### Task ${letter}: aim of ${letter}`, "Definition of done: a registry.", ""]),
  ].join("\n");
}

export const MERGED = [
  "# Merged review",
  "",
  "## Findings",
  "",
  "None.",
  "",
  "## Phase 3 must check",
  "",
  "- whether the handbook's silence is a rule or an omission",
  "",
  "## Something after",
  "",
  "- not a must-check question",
  "",
].join("\n");

export interface Fixture {
  run: string;
  /** The explanation node `E01`. */
  node: string;
  puzzle: string;
}

export function config(run: string, extra: Record<string, unknown> = {}): void {
  write(path.join(run, "config.json"), JSON.stringify({ model: "m", phases: {}, ...extra }));
}

/** A run with a puzzle `P01` in Phase 3 (with its snapshot sources) and no explanation node yet. */
export function puzzleRun(t: TestContext, extra: Record<string, unknown> = {}): { run: string; puzzle: string } {
  const run = tempDir(t);
  // A real dataset and split lists, so `reproduce` can mount an exploration split.
  const dataset = tempDir(t);
  write(path.join(dataset, "a.csv"), "a,1\n");
  initRun(run, dataset, "interest");
  write(path.join(run, "prep", "Z01-profile", "workspace", "split", "exploration.txt"), "a.csv\n");
  write(path.join(run, "prep", "Z01-profile", "workspace", "split", "holdout.txt"), "");
  createChild(run, "D01", "Etiquette", "owner-p1");
  const puzzle = createChild(run, "T01", "Rules by example", "owner-p2");
  updateNode(run, puzzle.id, { phase: 3 }, "owner-p2");
  write(path.join(puzzle.dir, "workspace", "puzzle.md"), "# The puzzle\nA card.\n");
  write(path.join(puzzle.dir, "workspace", "reviews", "merged.md"), MERGED);
  config(run, extra);
  settle(run);
  return { run, puzzle: puzzle.dir };
}

/** A run with a puzzle in Phase 3 and an explanation node under it. */
export function fixture(t: TestContext, extra: Record<string, unknown> = {}): Fixture {
  const { run, puzzle } = puzzleRun(t, extra);
  const node = createChild(run, "P01", "Argument", "owner-p3");
  settle(run);
  return { run, node: node.dir, puzzle };
}

export const ARGUMENT = (version: string) => `# Argument\n\nVersion ${version}.\n`;

/** Everything `close_round` needs for round `round` with the given task letters, all passing. */
export function finish(fx: Fixture, round: number, letters: string[], argument?: string): void {
  const nn = String(round).padStart(2, "0");
  for (const letter of letters) write(path.join(fx.node, "tasks", letter, "handoff.md"), `Status: DONE\n\nDone ${letter}.\n`);
  write(path.join(fx.node, "tasks", `lit-${nn}`, "handoff.md"), "Status: DONE\n");
  write(path.join(fx.node, "workspace", "reports", `${nn}.md`), "Round: 1\n");
  if (argument !== undefined) write(path.join(fx.node, "workspace", "argument.md"), argument);
  settle(fx.run);
}

/** Open and close a round, `changed` being "substantial" or "none". */
export async function runRound(fx: Fixture, round: number, letters: string[], changed: "substantial" | "none"): Promise<string> {
  await openRound(fx.run, { nodeId: "E01", plan: plan(...letters) });
  finish(fx, round, letters, changed === "substantial" ? ARGUMENT(`v${round}`) : undefined);
  return closeRound(fx.run, { nodeId: "E01", changed, summary: `round ${round} ${changed}` });
}

export interface CapturedTool {
  name: string;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<{ content: { type: string; text: string }[] }>;
}

export function captureTools(t: TestContext, run: string, phase: number): Map<string, CapturedTool> {
  const savedRun = process.env.CTC_RUN_DIR;
  const savedPhase = process.env.CTC_PHASE;
  process.env.CTC_RUN_DIR = run;
  process.env.CTC_PHASE = String(phase);
  t.after(() => {
    if (savedRun === undefined) delete process.env.CTC_RUN_DIR;
    else process.env.CTC_RUN_DIR = savedRun;
    if (savedPhase === undefined) delete process.env.CTC_PHASE;
    else process.env.CTC_PHASE = savedPhase;
  });
  const tools = new Map<string, CapturedTool>();
  ownerExtension({
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool);
    },
    on() {
      /* the write guard is checked through ownerMayWrite below */
    },
  });
  return tools;
}

export const NODE_BASE = "patterns/T01-etiquette/puzzles/P01-rules-by-example/explanations/E01-argument";
export const REGISTRY = "name,value,note\nn,1234,\n";

export const ARGUMENT_FULL = [
  "Contribution: theoretical",
  "",
  "## Explanation",
  "Etiquette rules travel by example rather than by statement.",
  "",
  "## Mechanism and scope",
  "Readers copy the first example they meet.",
  "",
  "## What would count against it",
  "Rules stated in full on the opening pages.",
  "",
  "## Alternatives considered",
  "The timing account is ruled out.",
  "",
  "## Evidence",
  "The sample is [1234](output/numbers/A_01.csv#n) pages long.",
  "The literature is in [report one](reports/01.md).",
  "",
  "## Limitations",
  "The snapshot cannot show causality.",
  "",
  "## Predictions",
  "The hold-out sample should show the same ordering.",
  "",
].join("\n");

export const REPORT_FULL = (round: number) =>
  [
    `Round: ${round}`,
    "",
    ...[
      "What the results are",
      "Literature on these results",
      "Rival and artifact accounts",
      "What else should be true",
      "Measurement precedents",
      "Implications for the argument",
    ].flatMap((heading) => [`## ${heading}`, "Two sources were read.", ""]),
  ].join("\n");

export const review = (status = "DONE_WITH_CONCERNS", findings = ["- [F1] [major] Number provenance: no registry row."]) =>
  [
    ...["Citation fidelity", "Number provenance", "Overclaiming", "Abductive honesty"].flatMap((heading) => [
      `## ${heading}`,
      "Result: ok",
      "Fine.",
      "",
    ]),
    "## Findings",
    ...findings,
    "",
    `Status: ${status}`,
    "",
  ].join("\n");

export const REVISION = "F1: taken\n";

/** A fake container: writes the registry `A_01.csv` for `A_01.R`, whatever it is told. */
export function fakeContainer(options: { delayMs?: number; registry?: string; onRun?: (host: string) => void } = {}): { exec: Exec; calls: string[] } {
  const calls: string[] = [];
  const exec: Exec = async (args) => {
    const mount = args.find((arg, at) => args[at - 1] === "-v" && arg.endsWith(":/work/output"));
    const host = (mount ?? "").slice(0, -":/work/output".length);
    const script = (args.at(-1) ?? "").replace(/^scripts\//, "");
    calls.push(script);
    if (options.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    write(path.join(host, "numbers", `${script.replace(/\.[^.]+$/, "")}.csv`), options.registry ?? REGISTRY);
    options.onRun?.(host);
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  return { exec, calls };
}

export const inWorkspace = (fx: Fixture, ...parts: string[]) => path.join(fx.node, "workspace", ...parts);
