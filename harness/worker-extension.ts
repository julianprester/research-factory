// The worker extension: keeps a worker inside its own node folder.
//
// Pi loads this into every `ctc-worker` child (see harness/agents/ctc-worker.md).
// A worker session runs with its node directory as cwd. On `write`/`edit` the
// extension finds the nearest ancestor of cwd holding a `node.json` and blocks
// anything outside `<nodeDir>/workspace/**`, `<nodeDir>/rounds.md` and
// `<nodeDir>/handoff.md`. A worker that is not inside a node at all fails
// closed: it has no folder to be trusted with. An explanation worker runs in
// its `tasks/<L>/` (or `tasks/lit-<nn>/`) folder and may write only that task's
// files, its scripts or its report; a session with no task folder writes
// nothing. A paper worker runs in its paper folder and may write only the
// manuscript lane (`paperWorkerMayWrite`). Workers of Phase 1 to 4 nodes
// also cannot `read` a hold-out path or run a `bash` command that names it. A
// Phase 3 or 4 worker also cannot `read` the dataset root (Phase 1 measures it by
// design; Phases 3 and 4 use only the exploration split) or run `docker`/`podman`.
// A Phase 2 puzzle worker can neither read a sibling puzzle's folder nor run a
// command naming one (its `derivedFrom` parents stay readable, so an evolution
// worker can read the cards and merged reviews it derives from). An explanation
// worker is held to the same rule about its ancestor puzzle, which it may name
// but not read outside its node; a paper worker reads its explanation as well.
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";

import { realExec, runScript, type Exec } from "./analysis/run.ts";
import { ANALYSIS_TASK } from "./explain/names.ts";
import { readConfig } from "./launch.ts";
import {
  datasetRefusal,
  dockerRefusal,
  explanationWorkerMayWrite,
  holdoutLocked,
  holdoutRefusal,
  isExplanationNode,
  isPaperNode,
  paperWorkerMayWrite,
  siblingRefusal,
  taskOf,
  workerMayWrite,
} from "./guard.ts";
import { commitFile, findRunDir, measurementFiles, nodeIdOf, preregisterCommits, readRun } from "./tree.ts";

interface ToolCallEventLike {
  toolName: string;
  input?: { path?: unknown; command?: unknown } | undefined;
}

interface PiLike {
  on(event: string, handler: (event: ToolCallEventLike, ctx?: unknown) => unknown): unknown;
  registerTool(tool: any): void;
}

const PreregisterParams = Type.Object({});
const RunAnalysisParams = Type.Object({
  script: Type.String({ description: "The script's bare file name, for example A_01.R; it runs from workspace/scripts/." }),
});

/** The last lines of a script's log that run_analysis returns to the worker. */
const LOG_TAIL_LINES = 40;

/** The Exec run_analysis uses; undefined in production, where it is realExec. */
let execForTests: Exec | undefined;

/**
 * Replace the Exec run_analysis runs containers with (default realExec). Tests
 * use this to inject a fake docker; pass undefined to restore the default.
 */
export function setExecForTests(exec: Exec | undefined): void {
  execForTests = exec;
}

function result(text: string) {
  return { content: [{ type: "text", text }], details: undefined };
}

/**
 * True when `dir` is an explanation's `tasks/` folder or a paper's `workspace/`
 * folder, or lies under one. Those folders are writable by the workers, so a
 * `node.json` there is not a node.
 */
function isInsideWorkerFolder(dir: string): boolean {
  for (let current = dir; ; ) {
    const parent = path.dirname(current);
    if (parent === current) return false;
    const name = path.basename(current);
    if (name === "tasks" && isExplanationNode(parent)) return true;
    if (name === "workspace" && isPaperNode(parent)) return true;
    current = parent;
  }
}

/**
 * The nearest ancestor of `start` (or `start` itself) that holds a `node.json`,
 * passing over an explanation's task folders and a paper's workspace: a worker
 * writes those, so a stray `node.json` there must not redirect the guards.
 */
export function findNodeDir(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "node.json")) && !isInsideWorkerFolder(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The dataset root of the run `nodeDir` belongs to (`dataset` in the run's
 * `node.json`, resolved against the run), or undefined when no readable run
 * sits above it.
 */
export function datasetRootOf(nodeDir: string): string | undefined {
  const runDir = findRunDir(nodeDir);
  if (runDir === undefined) return undefined;
  try {
    return path.resolve(runDir, readRun(runDir).dataset);
  } catch {
    return undefined;
  }
}

/**
 * Why a Phase 3 or Phase 4 node may not run this read or bash, or undefined when
 * it may. A run whose dataset root cannot be found is refused every call: the
 * guard has no root to check against, so it fails closed.
 */
function dataRefusal(nodeDir: string, event: ToolCallEventLike): string | undefined {
  const dataset = datasetRootOf(nodeDir);
  if (dataset === undefined) {
    return `Refusing ${event.toolName}: cannot find the run's dataset root above ${nodeDir}`;
  }
  return datasetRefusal(dataset, event.toolName, event.input) ?? dockerRefusal(event.toolName, event.input);
}

/** The phase stored in a node's `node.json`; a node whose file can't be read is not locked. */
function nodePhase(nodeDir: string): number {
  try {
    return Number(JSON.parse(fs.readFileSync(path.join(nodeDir, "node.json"), "utf8")).phase);
  } catch {
    return Number.NaN;
  }
}

export default function workerExtension(pi: PiLike): void {
  pi.registerTool({
    name: "preregister",
    label: "Pre-register measure",
    description:
      "Commit workspace/measure.md to the run's git before you measure anything. Call it once, after measure.md is final.",
    parameters: PreregisterParams,
    async execute() {
      const nodeDir = findNodeDir(process.cwd());
      if (nodeDir === undefined) {
        throw new Error(
          `Refusing to pre-register: this session is not inside a node folder (no node.json above ${process.cwd()})`,
        );
      }
      const runDir = findRunDir(nodeDir);
      if (runDir === undefined) {
        throw new Error(`Refusing to pre-register: there is no .git repository above ${nodeDir}`);
      }
      const measure = path.join(nodeDir, "workspace", "measure.md");
      if (!fs.existsSync(measure)) {
        throw new Error(`Refusing to pre-register: ${measure} does not exist. Write workspace/measure.md first.`);
      }
      const id = nodeIdOf(nodeDir);
      if (id === undefined) {
        throw new Error(`Refusing to pre-register: ${nodeDir} is not a node folder (expected <id>-<slug>)`);
      }
      const [existing] = preregisterCommits(runDir, id);
      if (existing !== undefined) {
        throw new Error(
          `already pre-registered at ${existing.short} — do not call preregister again; record deviations in the card instead`,
        );
      }

      // Pre-registration is only a safeguard if no analysis has run yet. Anything
      // under scripts/ or results/, or a card, means measuring came first.
      const measured = measurementFiles(nodeDir);
      if (measured.length > 0) {
        throw new Error(
          `measure first is not allowed: found ${measured.join(", ")} — write workspace/measure.md and call preregister before you create workspace/scripts/, workspace/results/ or workspace/pattern.md; nothing was committed`,
        );
      }

      const relPath = path.relative(runDir, measure).split(path.sep).join("/");
      const sha = commitFile(runDir, relPath, `worker-${id}`, `[P1:preregister] ${id} — measure.md`);
      return result(`pre-registered at ${sha}`);
    },
  });

  pi.registerTool({
    name: "run_analysis",
    label: "Run analysis script",
    description:
      "Run one of this task's analysis scripts (workspace/scripts/<L>_nn.R or .py, or assets.R|py for the last task) in the analysis container: no network, the exploration split read-only, output written to workspace/output. Returns the exit code and the end of the log.",
    parameters: RunAnalysisParams,
    async execute(_toolCallId: string, params: { script: string }) {
      const cwd = process.cwd();
      const nodeDir = findNodeDir(cwd);
      if (nodeDir === undefined) {
        throw new Error(`Refusing to run an analysis: this session is not inside a node folder (no node.json above ${cwd})`);
      }
      if (!isExplanationNode(nodeDir)) {
        throw new Error("Refusing to run an analysis: run_analysis is for explanation analysis tasks only");
      }
      const task = taskOf(nodeDir, cwd);
      if (task === undefined) {
        throw new Error(`Refusing to run an analysis: this session is not inside a task folder (tasks/<L>/ under ${nodeDir})`);
      }
      if (!ANALYSIS_TASK.test(task)) {
        throw new Error(`Refusing to run an analysis: literature task ${task} runs no scripts`);
      }
      const script = params.script;
      if (path.basename(script) !== script) {
        throw new Error(`Refusing to run "${script}": give a bare file name, such as ${task}_01.R`);
      }
      if (!explanationWorkerMayWrite(nodeDir, task, path.join(nodeDir, "workspace", "scripts", script))) {
        throw new Error(
          `Refusing to run ${script}: task ${task} may run only its own ${task}_nn.R|py and, as the last-lettered task, assets.R|py`,
        );
      }
      const runDir = findRunDir(nodeDir);
      if (runDir === undefined) {
        throw new Error(`Refusing to run an analysis: there is no .git repository above ${nodeDir}`);
      }
      const config = readConfig(runDir);
      const run = await runScript({
        runDir,
        nodeDir,
        script,
        image: config.analysisImage,
        timeoutMs: config.analysisTimeoutMs,
        exec: execForTests ?? realExec,
      });
      const tail = run.log.replace(/\n$/, "").split("\n").slice(-LOG_TAIL_LINES).join("\n");
      const status = `exit code ${run.code}${run.timedOut ? ", timed out" : ""}`;
      return {
        content: [{ type: "text", text: `${status}\n${tail}` }],
        details: { code: run.code, timedOut: run.timedOut },
      };
    },
  });

  pi.on("tool_call", (event) => {
    if (event.toolName === "read" || event.toolName === "bash") {
      const nodeDir = findNodeDir(process.cwd());
      if (nodeDir === undefined) return undefined;
      const phase = nodePhase(nodeDir);
      const reason =
        (holdoutLocked(phase) ? holdoutRefusal(event.toolName, event.input) : undefined) ??
        (phase === 2 || isExplanationNode(nodeDir) || isPaperNode(nodeDir)
          ? siblingRefusal(nodeDir, event.toolName, event.input)
          : undefined) ??
        (phase === 3 || phase === 4 ? dataRefusal(nodeDir, event) : undefined);
      return reason === undefined ? undefined : { block: true, reason };
    }
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
    const filePath = event.input?.path;
    if (typeof filePath !== "string" || filePath.length === 0) {
      return { block: true, reason: "worker-extension: write/edit without a path is not allowed" };
    }

    const nodeDir = findNodeDir(process.cwd());
    if (nodeDir === undefined) {
      return {
        block: true,
        reason: `Refusing to write ${filePath}: this session is not inside a node folder (no node.json above ${process.cwd()})`,
      };
    }
    if (isPaperNode(nodeDir)) {
      if (!paperWorkerMayWrite(nodeDir, path.resolve(filePath))) {
        return {
          block: true,
          reason: `Paper workers may only write workspace/paper.qmd, outline.md, reopen-request.md, workspace/embeds/diagrams/<name>.yml, rounds.md and handoff.md inside ${nodeDir}, not ${filePath}`,
        };
      }
      return undefined;
    }
    if (isExplanationNode(nodeDir)) {
      const task = taskOf(nodeDir, process.cwd());
      if (task === undefined) {
        return {
          block: true,
          reason: `Refusing to write ${filePath}: this explanation worker is not inside a task folder (tasks/<L>/ or tasks/lit-<nn>/ under ${nodeDir})`,
        };
      }
      if (!explanationWorkerMayWrite(nodeDir, task, path.resolve(filePath))) {
        return {
          block: true,
          reason: `Task ${task} may only write its own tasks/${task}/ folder, scripts and report inside ${nodeDir}, not ${filePath}`,
        };
      }
      return undefined;
    }
    if (!workerMayWrite(nodeDir, path.resolve(filePath))) {
      return {
        block: true,
        reason: `Workers may only write workspace/, rounds.md and handoff.md inside ${nodeDir}, not ${filePath}`,
      };
    }
    return undefined;
  });
}
