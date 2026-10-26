// The Phase 4 chain end to end, through the owner extension's registered tools, after a Phase 3 loop that ends
// with `submit` (explain-fixture.ts drives the loop with the real Phase 3 tools).
//
// Scenario 1: the writer's paper goes through `init_paper`, `check_paper`, a rejected style pass (a number variable's
// key changed, restored byte for byte), both passes redone cleanly, `submit_paper` refused at its check, pins and
// passes gates in turn, and then accepted: the paper is Phase 5 ready and the explanation closed.
//
// Scenario 2 (a separate run, `maxReopens` 1): the writer files a reopen request; `reopen_explanation` sends the
// explanation to Phase 3 ready; the extra loop (tasks R1A, R1B) runs through `open_round`, `close_round`, `reproduce`
// and `submit`; back in Phase 4, `repin_paper` refuses until the outline has changed and then succeeds; a second
// reopen is refused at the limit; the passes and `submit_paper` then succeed.
//
// The container, `deepis` and the citation check are fakes; the Quarto render is a fake that writes the outputs the
// render would. Every owner call's git effect is checked: a refused call changes neither HEAD nor the working tree; a
// call adds no dirty path; the tree operations and the submits are the sweeps that take the pending files.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { Exec } from "../analysis/run.ts";
import { loopDir, readRegular, readRounds } from "../explain/rounds.ts";
import { readReopens } from "../explain/reopen.ts";
import { setBudgetForTests, setCitationsForTests, setExecForTests } from "../explain/tools.ts";
import { quoteSource } from "../paper/quotes.ts";
import { setCitationsForTests as setPaperCitations, setDeepisForTests, setPaperExecForTests } from "../paper/tools.ts";
import ownerExtension from "../owner-extension.ts";
import { checkArgument } from "../tools/check-argument.ts";
import { findNode } from "../tree.ts";
import {
  ARGUMENT_FULL,
  ASSET_SOURCES,
  ASSET_VARIABLES,
  REGISTRY,
  REPORT_FULL,
  REVISION,
  fakeContainer,
  git,
  settle,
  plan,
  puzzleRun,
  rejectMessage,
  review,
  subjects,
  write,
} from "./explain-fixture.ts";

type Handler = (name: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

const dirty = (run: string): string[] => git(run, "status", "--porcelain", "-uall").split("\n").filter((line) => line !== "").sort();
const head = (run: string): string => git(run, "rev-parse", "HEAD").trim();
/** Tree operations: `updateNode` and `commit()` add the whole tree, so they take the pending files with them. */
const SWEEPS = new Set(["tree_create", "tree_update", "submit", "submit_paper", "reopen_explanation"]);
const TABLE = "| Group | N |\n|---|---|\n| A | 12 |\n";
const FIGURE = "fake png bytes\n";

interface Owner {
  /** Calls a registered tool as the owner of `phase`; a refusal is rethrown after the git checks. */
  call(phase: number, name: string, params: Record<string, unknown>): Promise<string>;
  /** Calls a tool expected to refuse, and returns the refusal. */
  refused(phase: number, name: string, params: Record<string, unknown>): Promise<string>;
}

/** The real extension, registered once; the phase is set per call, as a launched owner session sees it. */
function owner(t: TestContext, run: string): Owner {
  const saved = { run: process.env.CTC_RUN_DIR, phase: process.env.CTC_PHASE };
  process.env.CTC_RUN_DIR = run;
  t.after(() => {
    for (const [name, value] of [["CTC_RUN_DIR", saved.run], ["CTC_PHASE", saved.phase]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const tools = new Map<string, { execute: Handler }>();
  ownerExtension({
    registerTool(tool: { name: string; execute: Handler }) {
      tools.set(tool.name, tool);
    },
    on() {
      /* the write guard is not exercised here */
    },
  });
  const self: Owner = {
    async call(phase, name, params) {
      process.env.CTC_PHASE = String(phase);
      const tool = tools.get(name);
      assert.ok(tool !== undefined, `${name} is registered`);
      const dirtyBefore = dirty(run);
      const headBefore = head(run);
      let answer: { content: { text: string }[] };
      try {
        answer = await tool.execute(name, params);
      } catch (error) {
        assert.equal(head(run), headBefore, `${name} refused: no commit`);
        // A refused check or submit may leave the render's own outputs (checks/render) as the render wrote them.
        const outside = (line: string) => !line.includes("/checks/render/");
        assert.deepEqual(dirty(run).filter(outside), dirtyBefore.filter(outside), `${name} refused: the working tree is as it was`);
        throw error;
      }
      if (!SWEEPS.has(name)) {
        const added = dirty(run).filter((line) => !dirtyBefore.includes(line));
        assert.deepEqual(added, [], `${name} adds no dirty path`);
      }
      return answer.content.map((part) => part.text).join("\n");
    },
    refused(phase, name, params) {
      return rejectMessage(self.call(phase, name, params));
    },
  };
  return self;
}

const clean = (run: string, why: string) => assert.equal(git(run, "status", "--porcelain"), "", why);
const read = (file: string): string => readFileSync(file, "utf8");

/** What a round's workers leave: a handoff per task, a script and registry per task, the literature handoff and report. */
function workersFinish(node: string, round: number, tasks: string[], argument: string): void {
  const nn = String(round).padStart(2, "0");
  for (const letter of tasks) {
    write(path.join(node, "tasks", letter, "handoff.md"), `Status: DONE\n\nTask ${letter} done.\n`);
    write(path.join(node, "workspace", "scripts", `${letter}_01.R`), `# analysis ${letter}\n`);
    write(path.join(node, "workspace", "output", "numbers", `${letter}_01.csv`), REGISTRY);
  }
  write(path.join(node, "tasks", `lit-${nn}`, "handoff.md"), "Status: DONE\n");
  write(path.join(node, "workspace", "reports", `${nn}.md`), REPORT_FULL(round));
  write(path.join(node, "workspace", "argument.md"), argument);
}

/** A round that changed nothing: the workers confirm the registry and report. */
function quietWorkers(node: string, round: number, task: string): void {
  const nn = String(round).padStart(2, "0");
  write(path.join(node, "tasks", task, "handoff.md"), `Status: DONE\n\nTask ${task} confirmed the registry.\n`);
  write(path.join(node, "tasks", `lit-${nn}`, "handoff.md"), "Status: DONE\n");
  write(path.join(node, "workspace", "reports", `${nn}.md`), REPORT_FULL(round));
}

/** The Quarto container's fake: writes the html and docx a clean render writes, nothing else. */
function fakeRender(): Exec {
  return async (args) => {
    const mount = args[args.indexOf("-v") + 1] ?? "";
    const folder = mount.slice(0, mount.lastIndexOf(":/work"));
    write(path.join(folder, "checks", "render", "paper.html"), "<html><table><tr><td>A</td></tr></table></html>");
    write(path.join(folder, "checks", "render", "paper.docx"), "PK docx");
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
}

/** `deepis bib`'s fake: rewrites the draft's numeric chunk id to a key and writes the bibliography for it. */
function fakeDeepis(workspace: string): (args: string[]) => { code: number; stderr: string } {
  return () => {
    const qmd = path.join(workspace, "paper.qmd");
    writeFileSync(qmd, read(qmd).replace(/@1001/g, "@smith2020"));
    write(path.join(workspace, "references.bib"), "@article{smith2020,\n  title = {Etiquette by example},\n}\n");
    return { code: 0, stderr: "" };
  };
}

/** The paper as the writer drafts it: a variable, a table, a figure, a quote, a citation, the Predictions. */
function draft(quote: string): string {
  return [
    "---",
    'title: "Etiquette by example"',
    'author:',
    '  - "Test Author"',
    "bibliography: references.bib",
    "csl: apa.csl",
    "---",
    "",
    "# Introduction",
    "",
    "Etiquette travels by example rather than by statement.",
    "",
    "# Findings",
    "",
    "Readers copy the first example they meet, and {{< var n_pages >}} pages show it [@1001].",
    "",
    "{{< include embeds/tables/T1.qmd >}}",
    "",
    "![The first page](embeds/figures/F1.png)",
    "",
    quote,
    "",
    "{{< include embeds/predictions.qmd >}}",
    "",
    "# References {.unnumbered}",
    "",
    "::: {#refs}",
    ":::",
    "",
  ].join("\n");
}

const OUTLINE = [
  "# Outline",
  "",
  "## Sections",
  "",
  "- Introduction: the claim.",
  "- Findings: the first example, the table and the figure.",
  "",
  "## Omitted",
  "",
  "## Needs",
  "",
  "None.",
  "",
].join("\n");

interface Run {
  run: string;
  tools: Owner;
  node: string;
  paper: string;
  workspace: string;
  exec: ReturnType<typeof fakeContainer>;
}

/**
 * A run whose explanation E01 has been submitted to Phase 4 through the real Phase 3 tools: two substantial-then-quiet
 * rounds of loop 0 (round 1 changes, rounds 2 and 3 are quiet: STOP two-quiet), reproduce, review, submit.
 */
async function submittedExplanation(t: TestContext, extra: Record<string, unknown> = {}): Promise<Run> {
  const { run } = puzzleRun(t, extra);
  const tools = owner(t, run);
  const exec = fakeContainer({
    onRun: (host) => {
      write(path.join(host, "assets", "T1.qmd"), TABLE);
    },
  });
  setExecForTests(exec.exec);
  setCitationsForTests(() => []);
  setPaperCitations(() => []);
  setPaperExecForTests(fakeRender());
  setBudgetForTests(undefined);
  t.after(() => {
    setExecForTests(undefined);
    setCitationsForTests(undefined);
    setPaperCitations(undefined);
    setPaperExecForTests(undefined);
    setDeepisForTests(undefined);
    setBudgetForTests(undefined);
  });

  await tools.call(3, "tree_update", { nodeId: "P01", status: "input" });
  await tools.call(3, "tree_create", { parentId: "P01", title: "Argument" });
  await tools.call(3, "tree_update", { nodeId: "E01", status: "active" });
  const node = findNode(run, "E01").dir;

  await tools.call(3, "open_round", { nodeId: "E01", plan: plan("A") });
  workersFinish(node, 1, ["A"], ARGUMENT_FULL);
  assert.match(await tools.call(3, "close_round", { nodeId: "E01", changed: "substantial", summary: "the first account" }), /continue/);
  await tools.call(3, "open_round", { nodeId: "E01", plan: plan("B") });
  quietWorkers(node, 2, "B");
  assert.match(await tools.call(3, "close_round", { nodeId: "E01", changed: "none", summary: "nothing new" }), /continue/);
  await tools.call(3, "open_round", { nodeId: "E01", plan: plan("C") });
  quietWorkers(node, 3, "C");
  assert.match(await tools.call(3, "close_round", { nodeId: "E01", changed: "none", summary: "still nothing" }), /STOP \(two-quiet\)/);

  write(path.join(node, "workspace", "scripts", "assets.R"), "# assets\n");
  write(path.join(node, "workspace", "output", "assets", "_variables.yml"), ASSET_VARIABLES);
  write(path.join(node, "workspace", "output", "assets", "variables_sources.csv"), ASSET_SOURCES);
  write(path.join(node, "workspace", "output", "assets", "T1.qmd"), TABLE);
  write(path.join(node, "workspace", "output", "figures", "F1.png"), FIGURE);
  write(path.join(node, "workspace", "reviews", "report.md"), review());
  write(path.join(node, "workspace", "reviews", "revision.md"), REVISION);
  assert.deepEqual(checkArgument(run, node, { report: true, citations: () => [] }).problems, []);
  assert.match(await tools.call(3, "reproduce", { nodeId: "E01" }), /reproduced/);
  assert.match(await tools.call(3, "submit", { nodeId: "E01" }), /now ready in Phase 4/);
  assert.deepEqual([findNode(run, "E01").phase, findNode(run, "E01").status], [4, "ready"]);
  return { run, tools, node, paper: "", workspace: "", exec };
}

/** The paper node W01 under E01, scaffolded, with its draft, the exploration quote and the figure in place. */
async function scaffoldPaper(f: Run): Promise<{ paper: string; workspace: string; quote: string }> {
  await f.tools.call(4, "tree_create", { parentId: "E01", title: "Paper" });
  await f.tools.call(4, "tree_update", { nodeId: "W01", status: "active" });
  await f.tools.call(4, "tree_update", { nodeId: "E01", status: "input" });
  const paper = findNode(f.run, "W01").dir;
  const workspace = path.join(paper, "workspace");
  const init = await f.tools.call(4, "init_paper", { nodeId: "W01" });
  assert.match(init, /W01 under E01: created \d+ file/);
  write(path.join(f.run, "analysis-data", "exploration", "handbook", "rules.md"), "Rule one: say it by example.\nRule two: never state it.\nRule three: copy the first.\n");
  const quote = quoteSource(f.run, paper, { path: "handbook/rules.md", start: 1, end: 3 }).embed;
  write(path.join(workspace, "paper.qmd"), draft(quote));
  write(path.join(workspace, "outline.md"), OUTLINE);
  settle(f.run); // the writer's draft is committed, as a sweep would commit it
  return { paper, workspace, quote };
}

test("the Phase 4 chain runs end to end: a rejected pass, both passes, submit_paper", async (t) => {
  const f = await submittedExplanation(t);
  const { paper, workspace } = await scaffoldPaper(f);
  setDeepisForTests(fakeDeepis(workspace));
  const { tools, run } = f;
  const qmd = path.join(workspace, "paper.qmd");

  // The paper is scaffolded from the explanation: the copies, the Predictions fragment, the pins.
  assert.equal(findNode(run, "W01").status, "active");
  assert.ok(existsSync(path.join(workspace, "_variables.yml")) && existsSync(path.join(workspace, "embeds", "predictions.qmd")));
  assert.ok(existsSync(path.join(workspace, "embeds", "tables", "T1.qmd")), "the table fragment is copied");
  assert.ok(existsSync(path.join(workspace, "embeds", "figures", "F1.png")), "the figure is copied");
  assert.deepEqual(readRegular(paper, "workspace/checks/pins.json") !== undefined, true);

  // 1. The first check: clean, and it commits its result for this paper.
  assert.match(await tools.call(4, "check_paper", { nodeId: "W01" }), /W01 checks ok/);
  const result = JSON.parse(read(path.join(workspace, "checks", "result.json"))) as { ok: boolean; paperSha: string };
  assert.equal(result.ok, true);
  assert.equal(subjects(run)[0], "[P4:check] W01");

  // 2. A concise pass that changes a number variable's key is rejected, and paper.qmd comes back byte for byte.
  const beforePass = read(qmd);
  assert.match(await tools.call(4, "pass_begin", { nodeId: "W01", pass: "concise" }), /concise begun/);
  write(qmd, beforePass.replace("{{< var n_pages >}}", "{{< var n_pagez >}}"));
  const rejected = await tools.call(4, "pass_end", { nodeId: "W01", pass: "concise" });
  assert.match(rejected, /concise REJECTED/);
  assert.match(rejected, /variable n_pages: 1 before, 0 after/);
  assert.equal(read(qmd), beforePass, "restored byte for byte");
  assert.equal(subjects(run)[0], "[P4:pass-rejected] W01 concise");
  clean(run, "the rejection leaves the tree clean");
  assert.match(await tools.call(4, "submit_paper", { nodeId: "W01" }).catch((error: Error) => error.message), /gate "passes"/, "no accepted pass yet");

  // 3. Both passes, redone cleanly, each on a check that is ok for the paper it begins on.
  assert.match(await tools.call(4, "check_paper", { nodeId: "W01" }), /checks ok/);
  await tools.call(4, "pass_begin", { nodeId: "W01", pass: "concise" });
  write(qmd, read(qmd).replace("Readers copy the first example they meet, and", "Readers copy the first example, and"));
  assert.match(await tools.call(4, "pass_end", { nodeId: "W01", pass: "concise" }), /concise accepted/);
  assert.match(await tools.call(4, "check_paper", { nodeId: "W01" }), /checks ok/);
  await tools.call(4, "pass_begin", { nodeId: "W01", pass: "humanize" });
  write(qmd, read(qmd).replace("Readers copy the first example, and", "Readers copy the first example; and"));
  assert.match(await tools.call(4, "pass_end", { nodeId: "W01", pass: "humanize" }), /humanize accepted/);
  assert.match(await tools.call(4, "check_paper", { nodeId: "W01" }), /checks ok/);
  assert.match(await tools.refused(4, "pass_begin", { nodeId: "W01", pass: "concise" }), /already accepted/);

  // 4. submit_paper refuses at each gate in turn, and each refusal writes nothing.
  const afterPasses = read(qmd);
  write(qmd, `${afterPasses}\nA late sentence.\n`);
  assert.match(await tools.refused(4, "submit_paper", { nodeId: "W01" }), /gate "check"/, "an edit after the last check");
  write(qmd, afterPasses);
  assert.match(await tools.call(4, "check_paper", { nodeId: "W01" }), /checks ok/);

  const argument = path.join(f.node, "workspace", "argument.md");
  const argumentBefore = read(argument);
  write(argument, `${argumentBefore}\nA limitation the extra data would close.\n`);
  assert.match(await tools.refused(4, "submit_paper", { nodeId: "W01" }), /gate "pins"[\s\S]*stale: argumentSha/, "the pins are stale after an argument edit");
  write(argument, argumentBefore);
  const submitted = await tools.call(4, "submit_paper", { nodeId: "W01", note: "the account is settled" });
  const finalise = git(run, "log", "-1", "--format=%h", "--fixed-strings", "--grep", "[P4:finalize] W01").trim();
  assert.match(submitted, /submitted W01: now ready in Phase 5/);
  assert.ok(submitted.includes(finalise), `the reply names the paper commit ${finalise}`);
  assert.equal(subjects(run)[0], "[P4:updateNode] E01 — status closed");
  assert.ok(subjects(run).includes("[P4:finalize] W01"), "the finalise commit");
  assert.deepEqual([findNode(run, "W01").phase, findNode(run, "W01").status], [5, "ready"]);
  assert.deepEqual([findNode(run, "E01").phase, findNode(run, "E01").status], [4, "closed"]);
  assert.match(read(qmd), /@smith2020/, "the bibliography is finalised in the paper");
  assert.ok(existsSync(path.join(workspace, "references.bib")));
  clean(run, "submit_paper leaves the tree clean");

  // Phase 5 is not the Phase 4 owner's: a second submit is refused.
  assert.match(await tools.refused(4, "submit_paper", { nodeId: "W01" }), /Not your phase/);
});

test("the reopen chain: the request, the extra loop, repin after the outline changes, a second reopen refused", async (t) => {
  const f = await submittedExplanation(t, { maxReopens: 1 });
  const { tools, run } = f;
  const { paper, workspace } = await scaffoldPaper(f);
  setDeepisForTests(fakeDeepis(workspace));
  assert.match(await tools.call(4, "check_paper", { nodeId: "W01" }), /checks ok/);

  // 1. The writer asks for evidence; the explanation goes back to Phase 3 ready and the paper reads as stale.
  assert.match(await tools.refused(4, "reopen_explanation", { nodeId: "W01" }), /reopen-request\.md is missing/, "no request, no reopen");
  write(path.join(workspace, "reopen-request.md"), "Register the per-page rate of the subject-to-change class.\n");
  const outlineAtReopen = read(path.join(workspace, "outline.md"));
  const reopened = await tools.call(4, "reopen_explanation", { nodeId: "W01", note: "the rate is missing" });
  assert.match(reopened, /E01 reopened \(reopen 1 of 1\)/);
  assert.deepEqual([findNode(run, "E01").phase, findNode(run, "E01").status], [3, "ready"]);
  assert.deepEqual(readReopens(run, "E01").map((record) => record.n), [1]);
  assert.equal(read(path.join(f.node, "reopens", "01", "request.md")), read(path.join(workspace, "reopen-request.md")));
  const pins = JSON.parse(read(path.join(workspace, "checks", "pins.json"))) as { reopens: number; outlineShaAtReopen: string | null };
  assert.equal(pins.reopens, 1);
  assert.ok(typeof pins.outlineShaAtReopen === "string", "the outline is pinned at the reopen");
  assert.equal(findNode(run, "W01").status, "active", "the paper stays active");
  assert.equal(subjects(run)[0], "[P3:updateNode] E01 — status ready, phase 3, note", "the explanation's own tree commit comes last");
  assert.ok(subjects(run).includes("[P4:reopen] W01 reopen 1"));
  assert.match(git(run, "show", "--name-only", "--format=", "HEAD~1"), /reopens\/01\/request\.md/, "the reopen commit holds the request");

  // 2. The extra loop: reopen 1 takes R1A and R1B, two rounds (reopenRounds), round numbers continue.
  await tools.call(3, "open_round", { nodeId: "E01", plan: plan("R1A") });
  // The extra loop changes the Limitations only: the Predictions are pinned and stay as they were.
  workersFinish(f.node, 4, ["R1A"], ARGUMENT_FULL.replace("The snapshot cannot show causality.", "The snapshot cannot show causality.\nThe rate of the class is added to the account."));
  assert.match(await tools.call(3, "close_round", { nodeId: "E01", changed: "substantial", summary: "the rate" }), /continue/);
  await tools.call(3, "open_round", { nodeId: "E01", plan: plan("R1B") });
  quietWorkers(f.node, 5, "R1B");
  assert.match(await tools.call(3, "close_round", { nodeId: "E01", changed: "none", summary: "nothing more" }), /STOP \(cap\)/);
  assert.deepEqual(readRounds(run, "E01").map((round) => [round.round, round.reopen ?? 0]), [[1, 0], [2, 0], [3, 0], [4, 1], [5, 1]]);
  assert.match(await tools.call(3, "reproduce", { nodeId: "E01" }), /reproduced/);
  assert.match(await tools.call(3, "submit", { nodeId: "E01" }), /now ready in Phase 4/);
  assert.deepEqual([findNode(run, "E01").phase, findNode(run, "E01").status], [4, "ready"]);
  assert.equal(existsSync(path.join(loopDir(run, "E01"), "reproduction.json")), true);

  // 3. Back in Phase 4: repin refuses until the outline has changed, then succeeds.
  assert.match(await tools.refused(4, "repin_paper", { nodeId: "W01" }), /has not changed since the reopen/);
  write(path.join(workspace, "outline.md"), outlineAtReopen.replace("## Omitted", "- Reopen: the rate of the class.\n\n## Omitted"));
  assert.match(await tools.call(4, "repin_paper", { nodeId: "W01" }), /W01 repinned to E01/);
  const repinned = JSON.parse(read(path.join(workspace, "checks", "pins.json"))) as { reopens: number; outlineShaAtReopen: string | null };
  assert.deepEqual([repinned.reopens, repinned.outlineShaAtReopen], [1, null]);
  assert.equal(git(run, "log", "-1", "--format=%s").trim(), "[P4:repin] W01");

  // 4. A second reopen is refused at the limit, and nothing changes.
  write(path.join(workspace, "reopen-request.md"), "Another request.\n");
  const explanationBefore = findNode(run, "E01");
  assert.match(await tools.refused(4, "reopen_explanation", { nodeId: "W01" }), /gate "reopen limit"/);
  assert.deepEqual(findNode(run, "E01").phase, explanationBefore.phase);
  assert.equal(readReopens(run, "E01").length, 1);

  // 5. The paper is checked, both passes run, and submitted.
  assert.match(await tools.call(4, "check_paper", { nodeId: "W01" }), /checks ok/);
  const qmd = path.join(workspace, "paper.qmd");
  await tools.call(4, "pass_begin", { nodeId: "W01", pass: "concise" });
  write(qmd, read(qmd).replace("Readers copy the first example they meet, and", "Readers copy the first example, and"));
  assert.match(await tools.call(4, "pass_end", { nodeId: "W01", pass: "concise" }), /accepted/);
  assert.match(await tools.call(4, "check_paper", { nodeId: "W01" }), /checks ok/);
  await tools.call(4, "pass_begin", { nodeId: "W01", pass: "humanize" });
  write(qmd, read(qmd).replace("Readers copy the first example, and", "Readers copy the first example; and"));
  assert.match(await tools.call(4, "pass_end", { nodeId: "W01", pass: "humanize" }), /accepted/);
  assert.match(await tools.call(4, "check_paper", { nodeId: "W01" }), /checks ok/);
  assert.match(await tools.call(4, "submit_paper", { nodeId: "W01" }), /now ready in Phase 5/);
  assert.deepEqual([findNode(run, "W01").phase, findNode(run, "E01").status], [5, "closed"]);
  clean(run, "the reopen chain ends with a clean tree");
  assert.equal(git(run, "status", "--porcelain"), "");
  assert.ok(execFileSync("git", ["log", "--format=%s", "--fixed-strings", "--grep", "[P3:verdict] E01 round 05"], { cwd: run, encoding: "utf8" }).includes("round 05"));
});

test("the owner tools are Phase 4's alone: Phase 3 is refused by name", async (t) => {
  const f = await submittedExplanation(t);
  for (const name of ["init_paper", "check_paper", "submit_paper", "reopen_explanation", "repin_paper"]) {
    assert.match(await f.tools.refused(3, name, { nodeId: "W01" }), /Not your phase: .* is a phase-4 tool/, name);
  }
});

test("submit_paper refuses at the finalise, final-check and Needs gates, and writes nothing", async (t) => {
  const f = await submittedExplanation(t);
  const { tools, run } = f;
  const { workspace } = await scaffoldPaper(f);
  const qmd = path.join(workspace, "paper.qmd");
  const bib = path.join(workspace, "references.bib");
  setDeepisForTests(fakeDeepis(workspace));
  assert.match(await tools.call(4, "check_paper", { nodeId: "W01" }), /checks ok/);
  await tools.call(4, "pass_begin", { nodeId: "W01", pass: "concise" });
  write(qmd, read(qmd).replace("Readers copy the first example they meet, and", "Readers copy the first example, and"));
  assert.match(await tools.call(4, "pass_end", { nodeId: "W01", pass: "concise" }), /accepted/);
  assert.match(await tools.call(4, "check_paper", { nodeId: "W01" }), /checks ok/);
  await tools.call(4, "pass_begin", { nodeId: "W01", pass: "humanize" });
  write(qmd, read(qmd).replace("Readers copy the first example, and", "Readers copy the first example; and"));
  assert.match(await tools.call(4, "pass_end", { nodeId: "W01", pass: "humanize" }), /accepted/);
  assert.match(await tools.call(4, "check_paper", { nodeId: "W01" }), /checks ok/);
  const draftBefore = read(qmd);

  // The finalisation fails: refused at its gate, and the draft and the bibliography are as they were.
  setDeepisForTests(() => ({ code: 1, stderr: "deepis exploded" }));
  assert.match(await tools.refused(4, "submit_paper", { nodeId: "W01" }), /gate "finalize"[\s\S]*failed \(exit 1\)/);
  assert.equal(read(qmd), draftBefore, "paper.qmd is as it was");
  assert.equal(existsSync(bib), false, "no bibliography is left behind");

  // The finalised paper fails the render: refused at the final check, the finalisation undone.
  setDeepisForTests(fakeDeepis(workspace));
  setPaperExecForTests(async (args) => {
    const mount = args[args.indexOf("-v") + 1] ?? "";
    const folder = mount.slice(0, mount.lastIndexOf(":/work"));
    write(path.join(folder, "checks", "render", "paper.html"), "<html><p>no table</p></html>");
    write(path.join(folder, "checks", "render", "paper.docx"), "PK docx");
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  });
  assert.match(await tools.refused(4, "submit_paper", { nodeId: "W01" }), /gate "check"[\s\S]*does not check[\s\S]*table include/);
  assert.equal(read(qmd), draftBefore, "the finalisation is undone");
  assert.equal(existsSync(bib), false);
  assert.equal(findNode(run, "W01").phase, 4, "the paper did not move");

  // A Needs entry is a problem: check_paper says so, and submit refuses at the check (its result is not ok).
  setPaperExecForTests(fakeRender());
  write(path.join(workspace, "outline.md"), OUTLINE.replace("None.", "- the rate of the class, per page"));
  const needs = await tools.call(4, "check_paper", { nodeId: "W01" });
  assert.match(needs, /does NOT check/);
  assert.match(needs, /outline lists needs/);
  assert.match(await tools.refused(4, "submit_paper", { nodeId: "W01" }), /gate "check"/);
  write(path.join(workspace, "outline.md"), OUTLINE);
  assert.match(await tools.call(4, "check_paper", { nodeId: "W01" }), /checks ok/);
  assert.match(await tools.call(4, "submit_paper", { nodeId: "W01" }), /now ready in Phase 5/);
});
