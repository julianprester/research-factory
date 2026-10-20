// The worker extension: keeps a worker inside its own node folder.
//
// Pi loads this into every `ctc-worker` child (see harness/agents/ctc-worker.md).
// A worker session runs with its node directory as cwd. On `write`/`edit` the
// extension finds the nearest ancestor of cwd holding a `node.json` and blocks
// anything outside `<nodeDir>/workspace/**`, `<nodeDir>/rounds.md` and
// `<nodeDir>/handoff.md`. A worker that is not inside a node at all fails
// closed: it has no folder to be trusted with.
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";

import { workerMayWrite } from "./guard.ts";
import { commitFile, findRunDir, nodeIdOf, preregisterCommits } from "./tree.ts";

interface ToolCallEventLike {
  toolName: string;
  input?: { path?: unknown } | undefined;
}

interface PiLike {
  on(event: string, handler: (event: ToolCallEventLike, ctx?: unknown) => unknown): unknown;
  registerTool(tool: any): void;
}

const PreregisterParams = Type.Object({});

function result(text: string) {
  return { content: [{ type: "text", text }], details: undefined };
}

/** The nearest ancestor of `start` (or `start` itself) that holds a `node.json`. */
export function findNodeDir(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "node.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
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

      const relPath = path.relative(runDir, measure).split(path.sep).join("/");
      const sha = commitFile(runDir, relPath, `worker-${id}`, `[P1:preregister] ${id} — measure.md`);
      return result(`pre-registered at ${sha}`);
    },
  });

  pi.on("tool_call", (event) => {
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
    if (!workerMayWrite(nodeDir, path.resolve(filePath))) {
      return {
        block: true,
        reason: `Workers may only write workspace/, rounds.md and handoff.md inside ${nodeDir}, not ${filePath}`,
      };
    }
    return undefined;
  });
}
