// The phase-owner extension: an owner session's only way to touch the tree.
//
// Pi loads this with the run and phase in the environment (see harness/run.sh):
// CTC_RUN_DIR is the run folder, CTC_PHASE the phase this session owns. Every
// tool refuses nodes outside that phase, and a `tool_call` guard blocks
// `write`/`edit` calls outside `owners/phase-<phase>/` and node briefs. The
// environment is read when a tool runs, not at module load, so tests (and
// reloaded sessions) can set it around the factory call.
import * as path from "node:path";
import { Type } from "typebox";

import { ownerMayWrite } from "./guard.ts";
import { createChild, findNode, listNodes, updateNode, type Node } from "./tree.ts";

interface ToolCallEventLike {
  toolName: string;
  input?: { path?: unknown } | undefined;
}

interface PiLike {
  on(event: string, handler: (event: ToolCallEventLike, ctx?: unknown) => unknown): unknown;
  registerTool(tool: any): void;
}

const TreeListParams = Type.Object({
  phase: Type.Optional(Type.Number({ description: "Only list nodes in this phase, e.g. 1" })),
  status: Type.Optional(Type.String({ description: "Only list nodes with this status, e.g. ready" })),
});

const TreeCreateParams = Type.Object({
  parentId: Type.String({ description: "Id of the parent node, e.g. D01 or T01" }),
  title: Type.String({ description: "Title of the new node" }),
  card: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), { description: "Card fields for the new node" }),
  ),
  derivedFrom: Type.Optional(Type.Array(Type.String(), { description: "Ids of nodes this one derives from" })),
});

const TreeUpdateParams = Type.Object({
  nodeId: Type.String({ description: "Id of the node to update, e.g. T01" }),
  status: Type.Optional(Type.String({ description: "New status, e.g. ready, active, submitted" })),
  phase: Type.Optional(
    Type.Number({ description: "New phase; moving a node to the next phase hands it on" }),
  ),
  note: Type.Optional(Type.String({ description: "Note to record on the node" })),
  card: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Replacement card" })),
  runId: Type.Optional(Type.String({ description: "Worker run id to push onto the node" })),
});

interface TreeListInput {
  phase?: number;
  status?: string;
}

interface TreeCreateInput {
  parentId: string;
  title: string;
  card?: Record<string, unknown>;
  derivedFrom?: string[];
}

interface TreeUpdateInput {
  nodeId: string;
  status?: string;
  phase?: number;
  note?: string;
  card?: Record<string, unknown>;
  runId?: string;
}

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

function runDir(): string {
  return path.resolve(env("CTC_RUN_DIR"));
}

function ownerPhase(): number {
  const raw = env("CTC_PHASE");
  const phase = Number(raw);
  if (!Number.isInteger(phase)) throw new Error(`CTC_PHASE must be an integer, got ${JSON.stringify(raw)}`);
  return phase;
}

function actor(phase: number): string {
  return `owner-p${phase}`;
}

function refuseNotYourPhase(nodePhase: number, phase: number): Error {
  return new Error(`Not your phase (node in P${nodePhase}, you own P${phase})`);
}

function result(text: string) {
  return { content: [{ type: "text", text }], details: undefined };
}

function line(node: Node): string {
  return `${node.id} ${node.type} ${node.phase} ${node.status} ${node.title}`;
}

export default function ownerExtension(pi: PiLike): void {
  pi.registerTool({
    name: "tree_list",
    label: "List tree",
    description:
      "List the run's research nodes as `id type phase status title` lines, optionally filtered by phase or status.",
    parameters: TreeListParams,
    async execute(_toolCallId: string, params: TreeListInput) {
      let nodes = listNodes(runDir()).map(({ node }) => node);
      if (params.phase !== undefined) nodes = nodes.filter((node) => node.phase === params.phase);
      if (params.status !== undefined) nodes = nodes.filter((node) => node.status === params.status);
      nodes.sort((a, b) => a.id.localeCompare(b.id));
      return result(nodes.length === 0 ? "(no nodes)" : nodes.map(line).join("\n"));
    },
  });

  pi.registerTool({
    name: "tree_create",
    label: "Create node",
    description:
      "Create a child node under `parentId` in the owner's phase. The parent must be the dataset for phase 1, otherwise it must be in the owner's phase.",
    parameters: TreeCreateParams,
    async execute(_toolCallId: string, params: TreeCreateInput) {
      const dir = runDir();
      const phase = ownerPhase();
      const parent = findNode(dir, params.parentId);
      const allowed = parent.node.type === "dataset" ? phase === 1 : parent.node.phase === phase;
      if (!allowed) throw refuseNotYourPhase(parent.node.phase, phase);
      const node = createChild(
        dir,
        params.parentId,
        params.title,
        params.card ?? {},
        actor(phase),
        params.derivedFrom ?? [],
      );
      return result(`created ${line(node)}`);
    },
  });

  pi.registerTool({
    name: "tree_update",
    label: "Update node",
    description:
      "Update a node in the owner's phase. Moving `phase` is how a node is handed to the next owner.",
    parameters: TreeUpdateParams,
    async execute(_toolCallId: string, params: TreeUpdateInput) {
      const dir = runDir();
      const phase = ownerPhase();
      const found = findNode(dir, params.nodeId);
      if (found.node.phase !== phase) throw refuseNotYourPhase(found.node.phase, phase);

      const patch: { status?: string; phase?: number; note?: string; card?: Record<string, unknown>; runId?: string } =
        {};
      if (params.status !== undefined) patch.status = params.status;
      if (params.phase !== undefined) patch.phase = params.phase;
      if (params.note !== undefined) patch.note = params.note;
      if (params.card !== undefined) patch.card = params.card;
      if (params.runId !== undefined) patch.runId = params.runId;

      const node = updateNode(dir, params.nodeId, patch, actor(phase));
      return result(`updated ${line(node)}`);
    },
  });

  pi.on("tool_call", (event) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
    const filePath = event.input?.path;
    if (typeof filePath !== "string" || filePath.length === 0) return undefined;

    let allowed = false;
    let reason = "The owner extension has no CTC_RUN_DIR/CTC_PHASE to check against";
    try {
      const phase = ownerPhase();
      allowed = ownerMayWrite(runDir(), phase, path.resolve(filePath));
      reason = `Owner P${phase} may only write owners/phase-${phase}/** and node brief.md files, not ${filePath}`;
    } catch {
      // An owner session without a run/phase configured owns nothing: fail closed.
    }
    return allowed ? undefined : { block: true, reason };
  });
}
