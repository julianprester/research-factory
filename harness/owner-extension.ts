// The phase-owner extension: an owner session's only way to touch the tree.
//
// Pi loads this with the run and phase in the environment (see
// harness/launch.ts's startOwner):
// CTC_RUN_DIR is the run folder, CTC_PHASE the phase this session owns. Every
// tool refuses nodes outside that phase, and a `tool_call` guard blocks
// `write`/`edit` calls outside `owners/phase-<phase>/` and node briefs. The
// environment is read when a tool runs, not at module load, so tests (and
// reloaded sessions) can set it around the factory call.
import * as path from "node:path";
import { Type } from "typebox";

import { ownerMayWrite } from "./guard.ts";
import { createChild, findNode, listNodes, updateNode, type NodeRef } from "./tree.ts";

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
  title: Type.String({ description: "Short title; it becomes the node's folder name" }),
  derivedFrom: Type.Optional(Type.Array(Type.String(), { description: "For a fork: ids of the nodes it derives from" })),
  type: Type.Optional(
    Type.String({ description: '"prep" for Phase 0 preparation nodes; defaults to the parent\'s usual child type' }),
  ),
});

const TreeUpdateParams = Type.Object({
  nodeId: Type.String({ description: "Id of the node to update, e.g. T01" }),
  status: Type.Optional(Type.String({ description: "New status, e.g. ready, active, submitted" })),
  phase: Type.Optional(
    Type.Number({ description: "New phase; moving a node to the next phase hands it on" }),
  ),
  note: Type.Optional(Type.String({ description: "Why: recorded in the commit message, not on the node" })),
});

interface TreeListInput {
  phase?: number;
  status?: string;
}

interface TreeCreateInput {
  parentId: string;
  title: string;
  derivedFrom?: string[];
  type?: string;
}

interface TreeUpdateInput {
  nodeId: string;
  status?: string;
  phase?: number;
  note?: string;
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

/**
 * The phase a create under `parent` belongs to. The dataset's children are the
 * exception: a prep node is Phase 0 work, a pattern is Phase 1 work. Every
 * other parent's children stay in its own phase.
 */
function createPhase(parent: NodeRef, type: string | undefined): number {
  if (parent.type !== "dataset") return parent.phase;
  return type === "prep" ? 0 : 1;
}

function result(text: string) {
  return { content: [{ type: "text", text }], details: undefined };
}

function line(node: NodeRef): string {
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
      let nodes = listNodes(runDir());
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
      "Create a child node under `parentId` in the owner's phase. Under the dataset, `type: \"prep\"` makes a Phase 0 prep node and the default makes a Phase 1 pattern; any other parent must be in the owner's phase.",
    parameters: TreeCreateParams,
    async execute(_toolCallId: string, params: TreeCreateInput) {
      const dir = runDir();
      const phase = ownerPhase();
      const parent = findNode(dir, params.parentId);
      const nodePhase = createPhase(parent, params.type);
      if (nodePhase !== phase) throw refuseNotYourPhase(nodePhase, phase);
      const node = createChild(dir, params.parentId, params.title, actor(phase), params.derivedFrom ?? [], params.type);
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
      if (found.phase !== phase) throw refuseNotYourPhase(found.phase, phase);
      const node = updateNode(dir, params.nodeId, { status: params.status, phase: params.phase }, actor(phase), params.note);
      return result(`updated ${line(node)}`);
    },
  });

  pi.on("tool_call", (event) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
    const filePath = event.input?.path;
    if (typeof filePath !== "string" || filePath.length === 0) {
      return { block: true, reason: "owner-extension: write/edit without a path is not allowed" };
    }

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
