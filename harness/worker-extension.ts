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

import { workerMayWrite } from "./guard.ts";

interface ToolCallEventLike {
  toolName: string;
  input?: { path?: unknown } | undefined;
}

interface PiLike {
  on(event: string, handler: (event: ToolCallEventLike, ctx?: unknown) => unknown): unknown;
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
  pi.on("tool_call", (event) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
    const filePath = event.input?.path;
    if (typeof filePath !== "string" || filePath.length === 0) return undefined;

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
