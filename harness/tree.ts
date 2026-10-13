// The tree module: the only code that writes a run's tree of research nodes.
//
// A run folder is a tree of node folders, each holding a `node.json`. Every
// change is appended to `events.jsonl` and committed to the run's own git
// repository, all under a `mkdir` lock so parallel writers stay consistent.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface Node {
  id: string;
  type: string;
  phase: number;
  status: string;
  parent: string | null;
  derivedFrom: string[];
  title: string;
  card: Record<string, unknown>;
  runIds: string[];
  note?: string;
}

export interface NodeRef {
  dir: string;
  node: Node;
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

const CHILD_DIR: Record<string, string> = {
  pattern: "patterns",
  puzzle: "puzzles",
  explanation: "explanations",
  framing: "framings",
  paper: "papers",
};

const SKIP_DIRS = new Set(["workspace", ".git", "owners"]);
const LOCK_STEP_MS = 100;
const LOCK_TIMEOUT_MS = 30_000;
const GIT_IDENTITY = ["-c", "user.name=ctc", "-c", "user.email=ctc@localhost"];

type Patch = Partial<Pick<Node, "status" | "phase" | "note" | "card">> & { runId?: string };

interface TreeEvent {
  at: string;
  op: string;
  nodeId: string;
  phase: number;
  actor: string;
  data: Record<string, unknown>;
}

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

function appendEvent(runDir: string, event: TreeEvent): void {
  fs.appendFileSync(path.join(runDir, "events.jsonl"), JSON.stringify(event) + "\n");
}

function git(runDir: string, args: string[]): void {
  execFileSync("git", [...GIT_IDENTITY, ...args], { cwd: runDir });
}

function commit(runDir: string, message: string): void {
  git(runDir, ["add", "-A"]);
  // --allow-empty keeps one commit per event even when a patch changed no
  // file content (e.g. re-applying the current status).
  git(runDir, ["commit", "-m", message, "--allow-empty"]);
}

function writeNode(dir: string, node: Node): void {
  fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify(node, null, 2) + "\n");
}

function walk(dir: string, out: NodeRef[]): void {
  const nodePath = path.join(dir, "node.json");
  if (fs.existsSync(nodePath)) {
    out.push({ dir, node: JSON.parse(fs.readFileSync(nodePath, "utf8")) as Node });
  }
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    walk(path.join(dir, entry.name), out);
  }
}

export function listNodes(runDir: string): NodeRef[] {
  const nodes: NodeRef[] = [];
  walk(runDir, nodes);
  return nodes;
}

export function findNode(runDir: string, id: string): NodeRef {
  const found = listNodes(runDir).find((entry) => entry.node.id === id);
  if (!found) throw new Error(`Unknown node ${id}`);
  return found;
}

function nextId(nodes: NodeRef[], type: string): string {
  const prefix = PREFIX[type];
  if (!prefix) throw new Error(`Unknown node type ${type}`);
  let max = 0;
  for (const { node } of nodes) {
    if (node.type !== type) continue;
    const value = Number.parseInt(node.id.slice(prefix.length), 10);
    if (Number.isInteger(value) && value > max) max = value;
  }
  return `${prefix}${String(max + 1).padStart(2, "0")}`;
}

export function createChild(
  runDir: string,
  parentId: string,
  title: string,
  card: Record<string, unknown>,
  actor: string,
  derivedFrom: string[] = [],
): Node {
  return withLock(runDir, () => {
    const parent = findNode(runDir, parentId);
    const type = CHILD_TYPE[parent.node.type];
    if (!type) throw new Error(`Node type ${parent.node.type} has no children`);
    const childDir = CHILD_DIR[type];
    if (!childDir) throw new Error(`Unknown child type ${type}`);

    const id = nextId(listNodes(runDir), type);
    const phase = parent.node.type === "dataset" ? 1 : parent.node.phase;
    const node: Node = {
      id,
      type,
      phase,
      status: "ready",
      parent: parentId,
      derivedFrom: [...derivedFrom],
      title,
      card,
      runIds: [],
    };

    const dir = path.join(parent.dir, childDir, `${id}-${slug(title)}`);
    fs.mkdirSync(dir, { recursive: true });
    writeNode(dir, node);
    appendEvent(runDir, {
      at: new Date().toISOString(),
      op: "createChild",
      nodeId: id,
      phase,
      actor,
      data: { parent: parentId, title, card, derivedFrom: [...derivedFrom] },
    });
    commit(runDir, `[P${phase}:createChild] ${id} — ${title}`);
    return node;
  });
}

function updateSummary(patch: Patch): string {
  const parts: string[] = [];
  if (patch.status !== undefined) parts.push(`status ${patch.status}`);
  if (patch.phase !== undefined) parts.push(`phase ${patch.phase}`);
  if (patch.note !== undefined) parts.push("note");
  if (patch.card !== undefined) parts.push("card");
  if (patch.runId !== undefined) parts.push(`runId ${patch.runId}`);
  return parts.length > 0 ? parts.join(", ") : "update";
}

export function updateNode(runDir: string, id: string, patch: Patch, actor: string): Node {
  return withLock(runDir, () => {
    const found = findNode(runDir, id);
    const node = found.node;
    if (patch.status !== undefined) node.status = patch.status;
    if (patch.phase !== undefined) node.phase = patch.phase;
    if (patch.note !== undefined) node.note = patch.note;
    if (patch.card !== undefined) node.card = patch.card;
    if (patch.runId !== undefined) node.runIds.push(patch.runId);

    writeNode(found.dir, node);
    appendEvent(runDir, {
      at: new Date().toISOString(),
      op: "updateNode",
      nodeId: id,
      phase: node.phase,
      actor,
      data: { ...patch },
    });
    commit(runDir, `[P${node.phase}:updateNode] ${id} — ${updateSummary(patch)}`);
    return node;
  });
}

export function initRun(runDir: string, dataset: string, interest: string): void {
  fs.mkdirSync(runDir, { recursive: true });
  withLock(runDir, () => {
    const node: Node = {
      id: "D01",
      type: "dataset",
      phase: 0,
      status: "ready",
      parent: null,
      derivedFrom: [],
      title: dataset,
      card: { dataset, interest },
      runIds: [],
    };
    writeNode(runDir, node);

    for (let phase = 0; phase <= 5; phase++) {
      const dir = path.join(runDir, "owners", `phase-${phase}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "ledger.md"), "");
    }

    fs.writeFileSync(path.join(runDir, "events.jsonl"), "");
    appendEvent(runDir, {
      at: new Date().toISOString(),
      op: "init",
      nodeId: "D01",
      phase: 0,
      actor: "system",
      data: { dataset, interest },
    });

    git(runDir, ["init"]);
    commit(runDir, "[P0:init] D01 — create run");
  });
}
