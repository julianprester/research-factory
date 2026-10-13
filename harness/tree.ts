// The tree module: the only code that writes a run's tree of research nodes.
//
// A run folder is a tree of node folders named `<ID>-<slug>` (the root is the
// run folder itself, node D01). A node's id, type, parent and title all follow
// from where its folder sits, so `node.json` stores only what can't be derived:
// its phase and status (plus `derivedFrom` for forks). The root's `node.json`
// holds the dataset path and research interest instead.
//
// There is no separate event log: every change is one git commit in the run's
// own repository, authored by the actor, under a `mkdir` lock so parallel
// writers stay consistent. `git log` is the event log.
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

export const CHILD_TYPE: Record<string, string> = {
  dataset: "pattern",
  pattern: "puzzle",
  puzzle: "explanation",
  explanation: "framing",
  framing: "paper",
};

export const PREFIX: Record<string, string> = {
  dataset: "D",
  pattern: "T",
  puzzle: "P",
  explanation: "E",
  framing: "F",
  paper: "W",
};

/** The folder a node type's nodes live in, under their parent. */
export const CHILD_DIR: Record<string, string> = {
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

function withLock<T>(runDir: string, fn: () => T): T {
  const lockDir = path.join(runDir, ".lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Could not acquire ${lockDir} within ${LOCK_TIMEOUT_MS} ms`);
      }
      sleepSync(LOCK_STEP_MS);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmdirSync(lockDir);
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

export function createChild(
  runDir: string,
  parentId: string,
  title: string,
  actor: string,
  derivedFrom: string[] = [],
): NodeRef {
  return withLock(runDir, () => {
    const parent = findNode(runDir, parentId);
    const type = CHILD_TYPE[parent.type];
    if (!type) throw new Error(`Node type ${parent.type} has no children`);

    const id = nextId(listNodes(runDir), type);
    const state: NodeState = { phase: parent.type === "dataset" ? 1 : parent.phase, status: "ready", derivedFrom };
    const dir = path.join(parent.dir, CHILD_DIR[type], `${id}-${slug(title)}`);
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
  withLock(runDir, () => {
    const info: RunInfo = { dataset, interest };
    fs.writeFileSync(path.join(runDir, "node.json"), JSON.stringify(info, null, 2) + "\n");
    git(runDir, ["init", "--quiet"]);
    commit(runDir, "ctc", `[P0:init] ${ROOT_ID} — create run`);
  });
}
