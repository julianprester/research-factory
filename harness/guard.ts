// Pure write guards for the owner and worker extensions, and the read guards
// that keep Phase 2 puzzle work independent.
//
// Every guard takes a path and resolves it (`path.resolve`, so relative paths
// become cwd-relative and `.`/`..` segments collapse) before matching. The
// worker guard keeps a worker inside its own node folder; the owner guard keeps
// an owner to its own phase folder plus the `brief.md` of any node, at any
// nesting depth (`patterns/T01-a/brief.md`,
// `patterns/T01-a/puzzles/P01-b/brief.md`, ...), and a puzzle node's
// `brief-review.md`.
//
// The sibling guards are heuristics, not a sandbox: they refuse the direct
// spellings of a forbidden read so a model cannot wander by accident, but a
// script that walks the tree or a command built from a variable is not seen.
// `check-puzzle` and the judge's own prompt are the other half of that
// separation.
import * as fs from "node:fs";
import * as path from "node:path";

import { CHILD_DIR } from "./tree.ts";

/** Folders that hold node directories, one per child type in tree.ts. */
const NODE_DIRS = new Set(Object.values(CHILD_DIR));

/** The folder puzzle nodes live in (`patterns/T01-a/puzzles/P01-b`). */
const PUZZLES_DIR = CHILD_DIR.puzzle;

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

/**
 * True only for a reviewer's own two files: `<nodeDir>/workspace/reviews/a.md`
 * and `b.md`. The merge, the card and `handoff.md` are not a reviewer's.
 */
export function reviewerMayWrite(nodeDir: string, absPath: string): boolean {
  const relative = relativeInside(nodeDir, absPath);
  if (relative === undefined) return false;
  const parts = relative.split(path.sep);
  return (
    parts.length === 3 &&
    parts[0] === "workspace" &&
    parts[1] === "reviews" &&
    (parts[2] === "a.md" || parts[2] === "b.md")
  );
}

/** True for `owners/phase-<phase>/**` and for any node's `brief.md` (plus a puzzle node's `brief-review.md`). */
export function ownerMayWrite(runDir: string, phase: number, absPath: string): boolean {
  const relative = relativeInside(runDir, absPath);
  if (relative === undefined) return false;
  const parts = relative.split(path.sep);
  if (parts[0] === "owners" && parts.length > 2 && parts[1] === `phase-${phase}`) return true;
  if (parts.length < 3) return false;
  const group = parts[parts.length - 3] ?? "";
  const name = parts[parts.length - 1] ?? "";
  if (!NODE_DIRS.has(group)) return false;
  return name === "brief.md" || (name === "brief-review.md" && group === PUZZLES_DIR);
}

/** The hold-out in any spelling: `holdout`, `hold-out`, `hold_out`, `hold out`, any case. */
export const HOLDOUT_WORD = /hold[-_ ]?out/i;

/** Phases whose workers never see the hold-out; later phases unlock it per node. */
const HOLDOUT_LOCKED_PHASES = new Set([1, 2]);

/** True when workers of a node in `phase` must stay away from the hold-out. */
export function holdoutLocked(phase: number): boolean {
  return HOLDOUT_LOCKED_PHASES.has(phase);
}

/** A puzzle folder name: `P<nn>-<slug>`, as tree.ts's createChild makes them. */
const PUZZLE_FOLDER = /^P(\d+)-/;

/** A puzzle folder named inside a shell command (the heuristic cannot parse shell). */
const PUZZLE_IN_COMMAND = /P\d+-[A-Za-z0-9._-]*/g;

/** `P01` and `P1` name the same puzzle; compare the number, not the spelling. */
function canonicalPuzzleId(id: string): string | undefined {
  const match = /^P(\d+)$/.exec(id.trim());
  const digits = match?.[1];
  return digits === undefined ? undefined : `P${Number.parseInt(digits, 10)}`;
}

/** The puzzle a folder name stands for, or undefined when the folder is not a puzzle. */
function puzzleIdOf(folderName: string): string | undefined {
  const match = PUZZLE_FOLDER.exec(folderName);
  const digits = match?.[1];
  return digits === undefined ? undefined : `P${Number.parseInt(digits, 10)}`;
}

/** A puzzle node: its own folder is `P<nn>-<slug>` and its parent folder is `puzzles`. */
function isPuzzleNode(nodeDir: string): boolean {
  const dir = path.resolve(nodeDir);
  return path.basename(path.dirname(dir)) === PUZZLES_DIR && puzzleIdOf(path.basename(dir)) !== undefined;
}

/** The puzzle ids in a node's `node.json` `derivedFrom`; missing or unreadable means none. */
function derivedPuzzleIds(nodeDir: string): Set<string> {
  const ids = new Set<string>();
  try {
    const state = JSON.parse(fs.readFileSync(path.join(nodeDir, "node.json"), "utf8")) as { derivedFrom?: unknown };
    if (!Array.isArray(state.derivedFrom)) return ids;
    for (const id of state.derivedFrom) {
      if (typeof id !== "string") continue;
      const canonical = canonicalPuzzleId(id);
      if (canonical !== undefined) ids.add(canonical);
    }
  } catch {
    // A node without a readable node.json has no parent it may read.
  }
  return ids;
}

interface PuzzleFolder {
  dir: string;
  id: string;
}

/** Every `puzzles/P<nn>-<slug>` folder a resolved path passes through. */
function puzzleFoldersInPath(absPath: string): PuzzleFolder[] {
  const segments = path.resolve(absPath).split(path.sep);
  const folders: PuzzleFolder[] = [];
  for (let i = 0; i + 1 < segments.length; i += 1) {
    if (segments[i] !== PUZZLES_DIR) continue;
    const id = puzzleIdOf(segments[i + 1] ?? "");
    if (id === undefined) continue;
    folders.push({ dir: segments.slice(0, i + 2).join(path.sep), id });
  }
  return folders;
}

/**
 * Why a puzzle node may not run this tool call, or undefined when it may.
 *
 * Sibling puzzles are never visible (§5.3 of the Phase 2 design): a `read` of a
 * path under another puzzle's folder and a `bash` command that names one are
 * refused. The node's own folder is always allowed, and — unless
 * `allowDerived` is false — so are the puzzles its `node.json` names in
 * `derivedFrom`, because an evolution worker reads its parents' cards and
 * merged reviews. Reviewers pass `{ allowDerived: false }`: an evolved puzzle's
 * parent is another puzzle to them. A node that is not a puzzle is unaffected.
 *
 * Both checks are heuristics on a string: the path is resolved first, but a
 * shell command is only scanned for `P<nn>-<slug>` names. This is a guard
 * against accidental reads, not a sandbox.
 */
export function siblingRefusal(
  nodeDir: string,
  toolName: string,
  input: { path?: unknown; command?: unknown } | undefined,
  options: { allowDerived?: boolean } = {},
): string | undefined {
  if (!isPuzzleNode(nodeDir)) return undefined;
  const allowDerived = options.allowDerived ?? true;
  const ownDir = path.resolve(nodeDir);
  const ownId = puzzleIdOf(path.basename(ownDir));
  const derived = allowDerived ? derivedPuzzleIds(ownDir) : new Set<string>();

  if (toolName === "read" && typeof input?.path === "string") {
    const absPath = path.resolve(input.path);
    if (relativeInside(ownDir, absPath) !== undefined) return undefined;
    for (const folder of puzzleFoldersInPath(absPath)) {
      if (folder.dir === ownDir) continue;
      if (derived.has(folder.id)) continue;
      return `Reading ${input.path} is not allowed: sibling puzzles are invisible (${folder.dir} is another puzzle's folder)`;
    }
    return undefined;
  }

  if (toolName === "bash" && typeof input?.command === "string") {
    for (const match of input.command.matchAll(PUZZLE_IN_COMMAND)) {
      const id = puzzleIdOf(match[0]);
      if (id === ownId) continue;
      if (id !== undefined && derived.has(id)) continue;
      return `This command names ${match[0]}: sibling puzzles are invisible, and a shell command is checked by name only`;
    }
  }
  return undefined;
}

/** A `reviews/` folder named inside a shell command (both separators, for safety). */
const REVIEWS_IN_COMMAND = /reviews[/\\]/;

/**
 * Why a reviewer may not run this tool call, or undefined when it may. A
 * reviewer's inputs are the card and the pattern files its brief names, never a
 * review: any `read` of a path with a `reviews` segment — including the
 * reviewer's own `a.md` — is refused, and so is a `bash` command naming
 * `reviews/`, unless the command runs `check-citations.ts` (a reviewer must
 * cite-check its own review). A script that walks the folder is not caught;
 * this is a guard against accidental reads, not a sandbox.
 */
export function reviewsRefusal(
  toolName: string,
  input: { path?: unknown; command?: unknown } | undefined,
): string | undefined {
  if (toolName === "read" && typeof input?.path === "string") {
    if (path.resolve(input.path).split(path.sep).includes("reviews")) {
      return `Reading ${input.path} is not allowed: reviewers never read a review file, not even their own`;
    }
  }
  if (toolName === "bash" && typeof input?.command === "string") {
    if (REVIEWS_IN_COMMAND.test(input.command) && !input.command.includes("check-citations.ts")) {
      return "This command names reviews/: reviewers read no review, except through check-citations.ts";
    }
  }
  return undefined;
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
