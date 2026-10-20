// The tree module: the only code that writes a run's tree of research nodes.
//
// A run folder is a tree of node folders named `<ID>-<slug>` (the root is the
// run folder itself, node D01). A node's id, type, parent and title all follow
// from where its folder sits, so `node.json` stores only what can't be derived:
// its phase and status (plus `derivedFrom` for forks). The root's `node.json`
// holds the dataset path and research interest instead.
//
// There is no separate event log: every change is one git commit in the run's
// own repository, authored by the actor, under a `mkdir` lock inside `.git/`
// (which records the holder's pid, so a crashed writer's lock can be broken).
// `git log` is the event log.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** What a node's `node.json` stores. */
export interface NodeState {
  phase: number;
  status: string;
  derivedFrom?: string[];
}

/** A node as read from disk: its stored state plus what its folder tells us. */
export interface NodeRef extends NodeState {
  id: string;
  type: string;
  title: string;
  parent: string | null;
  dir: string;
}

export interface RunInfo {
  dataset: string;
  interest: string;
}

/** Every child type a parent type may have, in default-first order. */
export const CHILD_TYPES: Record<string, string[]> = {
  dataset: ["pattern", "prep"],
  pattern: ["puzzle"],
  puzzle: ["explanation"],
  explanation: ["framing"],
  framing: ["paper"],
};

/**
 * The default child type: what createChild makes when no type is asked for.
 * Derived from CHILD_TYPES so the two can never disagree.
 */
export const CHILD_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(CHILD_TYPES).map(([type, children]) => [type, children[0]]),
);

export const PREFIX: Record<string, string> = {
  dataset: "D",
  prep: "Z",
  pattern: "T",
  puzzle: "P",
  explanation: "E",
  framing: "F",
  paper: "W",
};

/** The folder a node type's nodes live in, under their parent. */
export const CHILD_DIR: Record<string, string> = {
  prep: "prep",
  pattern: "patterns",
  puzzle: "puzzles",
  explanation: "explanations",
  framing: "framings",
  paper: "papers",
};

const ROOT_ID = "D01";
const TYPE_OF_PREFIX = Object.fromEntries(Object.entries(PREFIX).map(([type, prefix]) => [prefix, type]));
const NODE_FOLDER = /^([A-Z])(\d+)-(.+)$/;
const LOCK_STEP_MS = 100;
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 5_000;
// The lock lives inside .git so that `git add -A` in commit() never sees it.
const LOCK_DIR = ".git/ctc.lock";
const PID_FILE = "pid";

function slug(title: string): string {
  const words = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const truncated = words.slice(0, 40).replace(/-+$/g, "");
  return truncated || "untitled";
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockTimeoutMs(): number {
  const override = Number(process.env.CTC_LOCK_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : LOCK_TIMEOUT_MS;
}

function readPid(pidFile: string): number | undefined {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined; // no pid file yet (or it is unreadable)
  }
}

function lockAgeMs(lockDir: string): number {
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY; // the lock vanished: retry mkdir
  }
}

/**
 * A lock is stale when its recorded holder is dead (kill throws ESRCH), or
 * when its pid file never appeared and the lock is older than 5 s. A live — or
 * unreadable and young — lock is honoured. An absent lock is not stale: there
 * is nothing to break, and a missing directory must lead back to `mkdir`,
 * never to a remove that could hit a lock another writer has just created.
 *
 * Exported for the lock unit tests; the rest of the module treats it as internal.
 */
export function isStaleLock(lockDir: string): boolean {
  if (!fs.existsSync(lockDir)) return false;
  const pid = readPid(path.join(lockDir, PID_FILE));
  if (pid === undefined) return lockAgeMs(lockDir) > LOCK_STALE_MS;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Take the lock: the atomic `mkdir`, then the holder's pid. A failed pid write drops the fresh dir. */
function createLock(lockDir: string): void {
  fs.mkdirSync(lockDir);
  try {
    fs.writeFileSync(path.join(lockDir, PID_FILE), String(process.pid));
  } catch (error) {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      /* the lock is already gone */
    }
    throw error;
  }
}

/**
 * Remove a stale lock and take it in the same breath. Two processes can see
 * the same stale lock at once, and a plain remove-then-mkdir lets one of them
 * delete the lock the other has just re-created. Breaking is therefore
 * serialised by a short-lived `<lock>.breaker` mkdir, and the breaker holder
 * is the only process allowed to remove a lock: it re-checks staleness, and if
 * the lock is stale it removes it and immediately creates (and so holds) its
 * own before releasing the breaker. It therefore never removes a lock it does
 * not then own. Returns true only when the caller now holds the lock.
 *
 * The breaker is held for microseconds and carries no pid, so one left behind
 * by a crash is recovered by the same 5 s age rule as any lock whose pid file
 * never appeared.
 *
 * Exported for the lock unit tests; the rest of the module treats it as internal.
 */
export function breakStaleLock(lockDir: string): boolean {
  const breakDir = `${lockDir}.breaker`;
  try {
    fs.mkdirSync(breakDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (lockAgeMs(breakDir) > LOCK_STALE_MS) fs.rmSync(breakDir, { recursive: true, force: true });
    return false; // another process is breaking it: let it finish
  }
  try {
    if (!isStaleLock(lockDir)) return false; // live, absent, or too young to tell
    fs.rmSync(lockDir, { recursive: true, force: true });
    try {
      createLock(lockDir); // only a lock we immediately own is ever removed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false; // another writer created the lock first: it won the race
    }
    return true;
  } finally {
    try {
      fs.rmSync(breakDir, { recursive: true, force: true });
    } catch {
      /* the breaker dir is already gone */
    }
  }
}

function withLock<T>(runDir: string, fn: () => T): T {
  const lockDir = path.join(runDir, LOCK_DIR);
  const timeout = lockTimeoutMs();
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      createLock(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Breaking takes the lock itself, so an absent lock can never be removed
    // out from under a writer that is recreating it.
    if (isStaleLock(lockDir) && breakStaleLock(lockDir)) break; // we now hold it
    if (Date.now() >= deadline) {
      throw new Error(`Could not acquire ${lockDir} within ${timeout} ms`);
    }
    sleepSync(LOCK_STEP_MS);
  }
  try {
    return fn();
  } finally {
    // Best effort: a failed release must not mask an error thrown by fn.
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      /* the lock is already gone */
    }
  }
}

function git(runDir: string, args: string[], actor = "ctc"): void {
  execFileSync("git", ["-c", `user.name=${actor}`, "-c", `user.email=${actor}@ctc.local`, ...args], {
    cwd: runDir,
  });
}

/** Commit everything as one change by `actor`; an optional note becomes the commit body. */
function commit(runDir: string, actor: string, subject: string, note?: string): void {
  git(runDir, ["add", "-A"], actor);
  const message = note ? ["-m", subject, "-m", note] : ["-m", subject];
  // --allow-empty keeps one commit per change even when nothing on disk moved
  // (e.g. re-applying the current status).
  git(runDir, ["commit", ...message, "--allow-empty"], actor);
}

/** Run a read-only git command and return its stdout. */
function gitOut(runDir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: runDir, encoding: "utf8" });
}

/**
 * Commit exactly one file as `actor` and return the new commit's short sha.
 *
 * `commit()` adds the whole tree, so a worker's half-written files in other
 * nodes would ride along; this commits only `relPath`. An unchanged file still
 * gets a commit (`--allow-empty`): the marker commit is the record that the
 * file was pre-registered, and a tree operation's `git add -A` may already
 * have swept the file into an unrelated commit. Only a missing file throws.
 */
export function commitFile(runDir: string, relPath: string, actor: string, subject: string): string {
  return withLock(runDir, () => {
    if (!fs.existsSync(path.join(runDir, relPath))) {
      throw new Error(`${relPath} does not exist: write it before committing it`);
    }
    // The add makes the path known to the index, so the partial commit below
    // can see it even when it is still untracked.
    git(runDir, ["add", "--", relPath], actor);
    git(runDir, ["commit", "--allow-empty", "-m", subject, "--", relPath], actor);
    return gitOut(runDir, ["rev-parse", "--short", "HEAD"]).trim();
  });
}

/** The id a node folder names: `T01-slug` → `T01`; undefined for anything else. */
export function nodeIdOf(dir: string): string | undefined {
  const match = NODE_FOLDER.exec(path.basename(path.resolve(dir)));
  return match?.[1] !== undefined && match[2] !== undefined ? `${match[1]}${match[2]}` : undefined;
}

/** A pre-registration marker commit: the full sha and the abbreviated form git prints. */
export interface Preregistration {
  sha: string;
  short: string;
}

/**
 * The run's `[P1:preregister] <id>` commits, oldest first. The id must be
 * followed by whitespace or the end of the subject, so T01 never matches
 * T011's marker.
 */
export function preregisterCommits(runDir: string, id: string): Preregistration[] {
  const subject = new RegExp(`^\\[P1:preregister\\] ${id}(\\s|$)`);
  const found: Preregistration[] = [];
  for (const line of gitOut(runDir, ["log", "--format=%h%x09%H%x09%s"]).split("\n")) {
    if (line.length === 0) continue;
    const [short, sha, ...rest] = line.split("\t");
    if (short === undefined || sha === undefined) continue;
    if (subject.test(rest.join("\t"))) found.push({ sha, short });
  }
  return found.reverse(); // git log is newest first
}

/** The nearest ancestor of `start` (or `start` itself) that is a git repository root. */
export function findRunDir(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function writeState(dir: string, state: NodeState): void {
  const stored: NodeState = { phase: state.phase, status: state.status };
  if (state.derivedFrom && state.derivedFrom.length > 0) stored.derivedFrom = state.derivedFrom;
  fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify(stored, null, 2) + "\n");
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function readRun(runDir: string): RunInfo {
  return readJson<RunInfo>(path.join(runDir, "node.json"));
}

function walk(dir: string, parent: string, out: NodeRef[]): void {
  const childFolders = new Set(Object.values(CHILD_DIR));
  const groups = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && childFolders.has(e.name));
  for (const group of groups.sort((a, b) => a.name.localeCompare(b.name))) {
    const groupDir = path.join(dir, group.name);
    const folders = fs.readdirSync(groupDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const folder of folders.sort((a, b) => a.name.localeCompare(b.name))) {
      const match = NODE_FOLDER.exec(folder.name);
      const nodeDir = path.join(groupDir, folder.name);
      if (!match || !fs.existsSync(path.join(nodeDir, "node.json"))) continue;
      const [, prefix, number, title] = match;
      const type = TYPE_OF_PREFIX[prefix];
      if (!type) continue;
      const state = readJson<NodeState>(path.join(nodeDir, "node.json"));
      const id = `${prefix}${number}`;
      out.push({ ...state, id, type, title, parent, dir: nodeDir });
      walk(nodeDir, id, out);
    }
  }
}

/** Every node in the run, root first, then depth-first in folder order. */
export function listNodes(runDir: string): NodeRef[] {
  const root: NodeRef = {
    id: ROOT_ID,
    type: "dataset",
    title: path.basename(readRun(runDir).dataset),
    parent: null,
    phase: 0,
    status: "-",
    dir: runDir,
  };
  const nodes = [root];
  walk(runDir, ROOT_ID, nodes);
  return nodes;
}

export function findNode(runDir: string, id: string): NodeRef {
  const found = listNodes(runDir).find((node) => node.id === id);
  if (!found) throw new Error(`Unknown node ${id}`);
  return found;
}

function nextId(nodes: NodeRef[], type: string): string {
  const prefix = PREFIX[type];
  let max = 0;
  for (const node of nodes) {
    if (node.type === type) max = Math.max(max, Number.parseInt(node.id.slice(prefix.length), 10));
  }
  return `${prefix}${String(max + 1).padStart(2, "0")}`;
}

/**
 * The phase a new child of `parent` starts in: a prep node is Phase 0 work, a
 * pattern under the dataset is Phase 1 work, and anything else keeps its
 * parent's phase (children are handed on with their parent).
 */
function childPhase(parent: NodeRef, type: string): number {
  if (type === "prep") return 0;
  return parent.type === "dataset" ? 1 : parent.phase;
}

export function createChild(
  runDir: string,
  parentId: string,
  title: string,
  actor: string,
  derivedFrom: string[] = [],
  type?: string,
): NodeRef {
  return withLock(runDir, () => {
    const parent = findNode(runDir, parentId);
    const allowed = CHILD_TYPES[parent.type] ?? [];
    if (allowed.length === 0) throw new Error(`Node type ${parent.type} has no children`);
    const childType = type ?? CHILD_TYPE[parent.type];
    if (!allowed.includes(childType)) {
      throw new Error(`Node type ${parent.type} cannot have ${childType} children`);
    }

    const id = nextId(listNodes(runDir), childType);
    const state: NodeState = { phase: childPhase(parent, childType), status: "ready", derivedFrom };
    const dir = path.join(parent.dir, CHILD_DIR[childType], `${id}-${slug(title)}`);
    fs.mkdirSync(dir, { recursive: true });
    writeState(dir, state);
    commit(runDir, actor, `[P${state.phase}:createChild] ${id} — ${title}`);
    return findNode(runDir, id);
  });
}

export function updateNode(
  runDir: string,
  id: string,
  patch: { status?: string; phase?: number },
  actor: string,
  note?: string,
): NodeRef {
  return withLock(runDir, () => {
    const node = findNode(runDir, id);
    if (node.type === "dataset") throw new Error("The dataset root has no status or phase to update");
    const state: NodeState = { phase: patch.phase ?? node.phase, status: patch.status ?? node.status, derivedFrom: node.derivedFrom };
    writeState(node.dir, state);

    const parts: string[] = [];
    if (patch.status !== undefined) parts.push(`status ${patch.status}`);
    if (patch.phase !== undefined) parts.push(`phase ${patch.phase}`);
    if (note) parts.push("note");
    commit(runDir, actor, `[P${state.phase}:updateNode] ${id} — ${parts.join(", ") || "update"}`, note);
    return findNode(runDir, id);
  });
}

export function initRun(runDir: string, dataset: string, interest: string): void {
  fs.mkdirSync(runDir, { recursive: true });
  if (fs.existsSync(path.join(runDir, "node.json"))) throw new Error(`${runDir} is already a run`);
  // The lock lives in .git, so the repository must exist before it is taken.
  git(runDir, ["init", "--quiet"]);
  withLock(runDir, () => {
    const info: RunInfo = { dataset, interest };
    fs.writeFileSync(path.join(runDir, "node.json"), JSON.stringify(info, null, 2) + "\n");
    commit(runDir, "ctc", `[P0:init] ${ROOT_ID} — create run`);
  });
}
