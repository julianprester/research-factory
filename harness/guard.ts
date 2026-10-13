// Pure write guards for the owner and worker extensions.
//
// Both take a path and resolve it (`path.resolve`, so relative paths become
// cwd-relative and `.`/`..` segments collapse) before matching. The worker
// guard keeps a worker inside its own node folder; the owner guard keeps an
// owner to its own phase folder plus the `brief.md` of any node, at any
// nesting depth (`patterns/T01-a/brief.md`,
// `patterns/T01-a/puzzles/P01-b/brief.md`, ...).
import * as path from "node:path";

/** Folders that hold node directories, one per child type in tree.ts. */
const NODE_DIRS = new Set(["patterns", "puzzles", "explanations", "framings", "papers"]);

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
