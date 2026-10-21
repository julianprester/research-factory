// Pure write guards for the owner and worker extensions.
//
// Both take a path and resolve it (`path.resolve`, so relative paths become
// cwd-relative and `.`/`..` segments collapse) before matching. The worker
// guard keeps a worker inside its own node folder; the owner guard keeps an
// owner to its own phase folder plus the `brief.md` of any node, at any
// nesting depth (`patterns/T01-a/brief.md`,
// `patterns/T01-a/puzzles/P01-b/brief.md`, ...).
import * as path from "node:path";

import { CHILD_DIR } from "./tree.ts";

/** Folders that hold node directories, one per child type in tree.ts. */
const NODE_DIRS = new Set(Object.values(CHILD_DIR));

/**
 * The path of `absPath` relative to `root`, or undefined when the resolved
 * target is `root` itself, is outside it, or escapes through `..`.
 */
function relativeInside(root: string, absPath: string): string | undefined {
  const relative = path.relative(path.resolve(root), path.resolve(absPath));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative;
}

/** True only for `<nodeDir>/workspace/**`, `<nodeDir>/rounds.md` and `<nodeDir>/handoff.md`. */
export function workerMayWrite(nodeDir: string, absPath: string): boolean {
  const relative = relativeInside(nodeDir, absPath);
  if (relative === undefined) return false;
  const parts = relative.split(path.sep);
  if (parts[0] === "workspace") return parts.length > 1;
  return parts.length === 1 && (parts[0] === "rounds.md" || parts[0] === "handoff.md");
}

/** True for `owners/phase-<phase>/**` and for any node's `brief.md`. */
export function ownerMayWrite(runDir: string, phase: number, absPath: string): boolean {
  const relative = relativeInside(runDir, absPath);
  if (relative === undefined) return false;
  const parts = relative.split(path.sep);
  if (parts[0] === "owners" && parts.length > 2 && parts[1] === `phase-${phase}`) return true;
  return (
    parts.length >= 3 && parts[parts.length - 1] === "brief.md" && NODE_DIRS.has(parts[parts.length - 3] ?? "")
  );
}

/** The hold-out in any spelling: `holdout`, `hold-out`, `hold_out`, `hold out`, any case. */
export const HOLDOUT_WORD = /hold[-_ ]?out/i;

/** Phases whose workers never see the hold-out; later phases unlock it per node. */
const HOLDOUT_LOCKED_PHASES = new Set([1, 2]);

/** True when workers of a node in `phase` must stay away from the hold-out. */
export function holdoutLocked(phase: number): boolean {
  return HOLDOUT_LOCKED_PHASES.has(phase);
}

/**
 * Why a locked worker may not run this tool call, or undefined when it may. A
 * `read` of any path with a hold-out spelling in it (the `holdout.txt` list, a
 * folder named after it) and a `bash` command that names the hold-out are refused.
 * This closes the direct routes; a script that walks the dataset is checked
 * separately by check-pattern.
 */
export function holdoutRefusal(toolName: string, input: { path?: unknown; command?: unknown } | undefined): string | undefined {
  if (toolName === "read" && typeof input?.path === "string" && HOLDOUT_WORD.test(input.path)) {
    return `Reading ${input.path} is not allowed: Phase 1 and 2 workers never read the hold-out`;
  }
  if (toolName === "bash" && typeof input?.command === "string" && HOLDOUT_WORD.test(input.command)) {
    return "This command names the hold-out, which Phase 1 and 2 workers never read";
  }
  return undefined;
}
