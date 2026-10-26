// Shared fixture for the paper-node tests (diagram and render): a run with an explanation E01 in phase 4, its
// argument, and its paper W01 under it. Nothing here starts a container.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

import { createChild, findNode, initRun, updateNode } from "../tree.ts";

export const ARGUMENT = [
  "Contribution: theoretical",
  "",
  "## Explanation",
  "Etiquette rules travel by example.",
  "",
  "## Mechanism and scope",
  "Readers copy the first example they meet.",
  "",
].join("\n");


export function put(file: string, text: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A run with explanation E01 (argument.md as given) and its paper W01; `spec` is written as the theory diagram when given. */
export function paperRun(t: TestContext, spec: string | undefined, argument = ARGUMENT) {
  const dataset = mkdtempSync(path.join(tmpdir(), "ctc-diagram-dataset-"));
  t.after(() => rmSync(dataset, { recursive: true, force: true }));
  const run = mkdtempSync(path.join(tmpdir(), "ctc-diagram-run-"));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  initRun(run, dataset, "interest");
  createChild(run, "D01", "Self Presentation", "owner-p1");
  createChild(run, "T01", "status quo: crowd", "owner-p2");
  createChild(run, "P01", "Explanation of crowd", "owner-p3", [], "explanation");
  updateNode(run, "E01", { phase: 3, status: "active" }, "owner-p3");
  updateNode(run, "E01", { phase: 4, status: "ready" }, "owner-p3");
  createChild(run, "E01", "Paper of crowd", "owner-p4", [], "paper");
  put(path.join(run, "config.json"), JSON.stringify({ model: "test-model", phases: { "4": "harness/skills/phase-4" } }, null, 2));
  const explanation = findNode(run, "E01").dir;
  const paper = findNode(run, "W01").dir;
  put(path.join(explanation, "workspace", "argument.md"), argument);
  if (spec !== undefined) put(path.join(paper, "workspace", "embeds", "diagrams", "theory.yml"), spec);
  return { run, explanation, paper, diagrams: path.join(paper, "workspace", "embeds", "diagrams") };
}

