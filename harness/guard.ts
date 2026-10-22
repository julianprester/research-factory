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
// The owner guard also refuses the phase's `tournament/` folder: `rounds.json`,
// `round-<n>.json` and `distinct.json` are what `tree_create` and `promote`
// trust, and the tournament tools write them with `fs` directly rather than
// through this guard. The ledger, strategy, meta-reviews and rulings in the rest
// of `owners/phase-<n>/` stay writable.
//
// The sibling guards are heuristics, not a sandbox: they refuse the direct
// spellings of a forbidden read so a model cannot wander by accident, but a
// script that walks the tree or a command built from a variable is not seen.
// `check-puzzle` and the judge's own prompt are the other half of that
// separation. The same caveat applies to the tournament refusal: the owner
// session also has pi's default `bash` tool, which no path guard can inspect, so
// this narrows the route around the gates rather than sandboxing it.
//
// Paths are compared case-sensitively (`P`, `reviews` and `owners` match
// exactly); the run environment is Linux, where the file system is too. Both
// reviewers may write either review slot: the brief names one, and a swapped or
// clobbered file is visible to `merge-reviews.ts` and `check-puzzle --reviews`.
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

/**
 * True for `owners/phase-<phase>/**` except its `tournament/` folder, and for
 * any node's `brief.md` (plus a puzzle node's `brief-review.md`). The
 * tournament records are the tools' evidence - `tree_create`'s STOP gate and
 * `promote`'s ranking/distinctness gates read them - so the owner's write tool
 * must not be able to forge them.
 */
export function ownerMayWrite(runDir: string, phase: number, absPath: string): boolean {
  const relative = relativeInside(runDir, absPath);
  if (relative === undefined) return false;
  const parts = relative.split(path.sep);
  if (parts[0] === "owners" && parts.length > 2 && parts[1] === `phase-${phase}`) {
    return parts[2] !== "tournament";
  }
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

/**
 * A puzzle folder named inside a shell command (the heuristic cannot parse
 * shell): `P02-x`, `P02-*`, `P02*` and `P02?` all count. A glob may replace the
 * whole suffix, so the name scan alone would miss `../P02*` and `../*`; the
 * traversal-plus-glob rule in `siblingRefusal` catches those.
 */
const PUZZLE_IN_COMMAND = /P\d+(?:-[A-Za-z0-9._-]*|[*?])/g;

/** Shell glob metacharacters; a path with one of these is not a path the guard can see. */
const GLOB = /[*?\[]/;

/** `P01` and `P1` name the same puzzle; compare the number, not the spelling. */
function canonicalPuzzleId(id: string): string | undefined {
  const match = /^P(\d+)$/.exec(id.trim());
  const digits = match?.[1];
  return digits === undefined ? undefined : `P${Number.parseInt(digits, 10)}`;
}

/** The id a command token stands for: `P02-x`, `P02*` and `P02?` all mean P02. */
function commandPuzzleId(token: string): string | undefined {
  const match = /^P(\d+)/.exec(token);
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
export function isPuzzleNode(nodeDir: string): boolean {
  const dir = path.resolve(nodeDir);
  return path.basename(path.dirname(dir)) === PUZZLES_DIR && puzzleIdOf(path.basename(dir)) !== undefined;
}

/**
 * The real path when the target exists, so a symlink cannot step around the
 * segment walk; otherwise the resolved path (a file not created yet has no real
 * path to compare, and remains a documented gap).
 */
function realPathOrSelf(absPath: string): string {
  try {
    return fs.realpathSync(absPath);
  } catch {
    return path.resolve(absPath);
  }
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
 * Both checks are heuristics on a string: the read path is made real when it
 * exists (so a symlink cannot step around the walk) and otherwise resolved,
 * while a shell command is scanned for `P<nn>` names and refused when it
 * combines a `..` traversal with a glob, which the guard cannot expand. This is
 * a guard against accidental reads, not a sandbox.
 */
export function siblingRefusal(
  nodeDir: string,
  toolName: string,
  input: { path?: unknown; command?: unknown } | undefined,
  options: { allowDerived?: boolean } = {},
): string | undefined {
  if (!isPuzzleNode(nodeDir)) return undefined;
  const allowDerived = options.allowDerived ?? true;
  const ownDir = realPathOrSelf(nodeDir);
  const ownId = puzzleIdOf(path.basename(ownDir));
  const derived = allowDerived ? derivedPuzzleIds(ownDir) : new Set<string>();

  if (toolName === "read" && typeof input?.path === "string") {
    const absPath = realPathOrSelf(input.path);
    if (relativeInside(ownDir, absPath) !== undefined) return undefined;
    for (const folder of puzzleFoldersInPath(absPath)) {
      if (folder.dir === ownDir) continue;
      if (derived.has(folder.id)) continue;
      return `Reading ${input.path} is not allowed: sibling puzzles are invisible (${folder.dir} is another puzzle's folder)`;
    }
    return undefined;
  }

  if (toolName === "bash" && typeof input?.command === "string") {
    if (input.command.includes("..") && GLOB.test(input.command)) {
      return "This command combines a `..` traversal with a glob: name every path you read explicitly";
    }
    for (const match of input.command.matchAll(PUZZLE_IN_COMMAND)) {
      const id = commandPuzzleId(match[0]);
      if (id === ownId) continue;
      if (id !== undefined && derived.has(id)) continue;
      return `This command names ${match[0]}: sibling puzzles are invisible, and a shell command is checked by name only`;
    }
  }
  return undefined;
}

/** The path segments a reviewer may never name in a file argument: the other review slot and the owners' records. */
const RESTRICTED_SEGMENTS = new Set(["reviews", "owners"]);

/**
 * Split a shell command into simple commands on `;`, `&&`, `||`, `|` and
 * newlines, respecting single and double quotes, so a separator inside a quoted
 * query does not split. `2>&1` stays inside its command. Shell escaping is
 * honoured: outside quotes a backslash and the next character are consumed
 * verbatim (an escaped separator does not split and an escaped quote opens no
 * span), inside single quotes a backslash is literal, and inside double quotes
 * a backslash escapes the next character so `\"` does not close the quote.
 */
function splitSimpleCommands(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] ?? "";
    if (quote === "'") {
      current += char;
      if (char === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (char === "\\" && i + 1 < command.length) {
        current += char + (command[i + 1] ?? "");
        i += 1;
        continue;
      }
      current += char;
      if (char === '"') quote = undefined;
      continue;
    }
    if (char === "\\" && i + 1 < command.length) {
      current += char + (command[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || char === "\n") {
      parts.push(current);
      current = "";
      continue;
    }
    if (char === "&" && command[i + 1] === "&") {
      parts.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (char === "|") {
      parts.push(current);
      current = "";
      if (command[i + 1] === "|") i += 1;
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.filter((part) => part.trim().length > 0);
}

/**
 * The shell words of one simple command. Quotes are removed, and a quoted span
 * stays one word, so `"owners of firms"` is a phrase rather than three words.
 * Escaping follows the shell: outside quotes `\x` is the ordinary character `x`
 * (so `don\'t` is one word, not the start of a phantom quoted span), inside
 * single quotes a backslash is literal, and inside double quotes `\"` is a
 * quote rather than the end of the span.
 */
function shellWords(simple: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < simple.length; i += 1) {
    const char = simple[i] ?? "";
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else {
        current += char;
        started = true;
      }
      continue;
    }
    if (quote === '"') {
      if (char === "\\" && i + 1 < simple.length) {
        current += simple[i + 1] ?? "";
        started = true;
        i += 1;
        continue;
      }
      if (char === '"') quote = undefined;
      else {
        current += char;
        started = true;
      }
      continue;
    }
    if (char === "\\" && i + 1 < simple.length) {
      current += simple[i + 1] ?? "";
      started = true;
      i += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        words.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) words.push(current);
  return words;
}

/**
 * True when a simple command runs `deepis`, directly or after an optional
 * `timeout <n>`: a literature search reads no local file, so its query text is
 * never treated as a path.
 */
function runsDeepis(words: string[]): boolean {
  const program = words[0];
  if (program === "deepis") return true;
  return program === "timeout" && words[2] === "deepis";
}

/**
 * The `reviews`/`owners` path segments a bash command names. The command is split
 * into simple commands (quote-aware) and tokenised; a `deepis` command is skipped
 * whole (its query text is not a path); a token containing whitespace is a
 * quoted phrase, not a path; a leading redirection operator is stripped; every
 * remaining token is split on `/` and a segment must equal `reviews` or `owners`
 * exactly, so `previews/`, `reviews-notes.md`, `xreviews/foo` and
 * `my_owners.txt` pass. Residual: an unquoted single-word argument to a
 * non-deepis command (`grep owners file`) is refused — accepted.
 */
function restrictedSegments(command: string): Set<string> {
  const found = new Set<string>();
  for (const simple of splitSimpleCommands(command)) {
    const words = shellWords(simple);
    if (runsDeepis(words)) continue;
    for (const word of words) {
      if (/\s/.test(word)) continue; // a quoted phrase is text, not a path
      const pathWord = word.replace(/^(?:\d*(?:>>|>)|&>>?|<)/, "");
      for (const segment of pathWord.split("/")) {
        if (RESTRICTED_SEGMENTS.has(segment)) found.add(segment);
      }
    }
  }
  return found;
}

/** Shell operators that chain or nest a command: after one of these the guard no longer knows what runs. */
const SHELL_OPERATOR = /;|&&|\|\||\||`|\$\(/;

/** A trailing stderr redirect (`2>&1`, possibly repeated) is not a shell operator chain. */
const TRAILING_STDERR_REDIRECT = /(?:\s+2>&1)+\s*$/;

/**
 * The one command allowed to touch a review: a plain `node …/check-citations.ts`,
 * optionally with a trailing `2>&1`, and with no other shell operator anywhere.
 * A chained command (`… && echo check-citations.ts`, `…; cat b.md`) and a piped
 * one (`… 2>&1 | tail -20`) do not qualify, so the escape cannot be borrowed to
 * read something else.
 */
function runsCheckCitations(command: string): boolean {
  const trimmed = command.trimStart().replace(TRAILING_STDERR_REDIRECT, "");
  return /^node\b/.test(trimmed) && trimmed.includes("check-citations.ts") && !SHELL_OPERATOR.test(trimmed);
}

/**
 * Why a reviewer may not run this tool call, or undefined when it may. A
 * reviewer's inputs are the card and the pattern files its brief names, never a
 * review: any `read` of a path with a `reviews` segment — including the
 * reviewer's own `a.md` — is refused, and so is any `bash` command whose file
 * arguments name the segment (`grep -r . workspace/reviews`, `cd reviews && …`),
 * except a single `check-citations.ts` run on its own file. The command is
 * tokenised, not regex-matched, so a `deepis` query that says "reviews of firms"
 * is literature, not a path. A script that walks the folder is not caught; this
 * is a guard against accidental reads, not a sandbox.
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
    if (restrictedSegments(input.command).has("reviews") && !runsCheckCitations(input.command)) {
      return "This command names reviews/: reviewers read no review, except a single check-citations.ts run on their own file";
    }
  }
  return undefined;
}

/**
 * Why a reviewer may not read the owners' folder, or undefined when it may. The
 * phase-2 owner's ledger, rulings and `owners/phase-2/tournament/round-*.json`
 * hold judge verdicts and ratings, and §5.3 says a reviewer sees no judge
 * output. The command is tokenised like `reviewsRefusal`'s, so a literature
 * query about "owners of firms" is not a path. A script that reads the folder
 * indirectly is not caught.
 */
export function ownersRefusal(
  toolName: string,
  input: { path?: unknown; command?: unknown } | undefined,
): string | undefined {
  if (toolName === "read" && typeof input?.path === "string") {
    if (path.resolve(input.path).split(path.sep).includes("owners")) {
      return `Reading ${input.path} is not allowed: reviewers never read the owners' folder (rulings and judge verdicts)`;
    }
  }
  if (toolName === "bash" && typeof input?.command === "string") {
    if (restrictedSegments(input.command).has("owners")) {
      return "This command names owners/: reviewers never read the owners' folder (rulings and judge verdicts)";
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
