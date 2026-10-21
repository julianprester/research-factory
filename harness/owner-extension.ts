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
import { checkDuplicates, judgeRound, type CheckDuplicatesInput, type JudgeRoundInput } from "./tournament/tools.ts";
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

const JudgeRoundParams = Type.Object({
  round: Type.Number({ description: "The round to judge: 0 for the first ranking, then 1, 2, …" }),
  entrants: Type.Optional(
    Type.Array(Type.String(), {
      description: "Round 1+: the incumbent puzzle ids this round ranks (round 0 takes every submitted puzzle)",
    }),
  ),
  pairs: Type.Optional(
    Type.Array(Type.Object({ child: Type.String(), parent: Type.String() }), {
      description: "Round 1+: each evolution child and the incumbent parent it must be judged against",
    }),
  ),
});

const CheckDuplicatesParams = Type.Object({
  ids: Type.Array(Type.String(), {
    description: "The candidate puzzle ids to compare pairwise, e.g. the top 8 of the latest round",
  }),
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

/** The tournament tools are Phase 2's alone, whatever tree the session can see. */
function requirePhase2(tool: string): void {
  const phase = ownerPhase();
  if (phase !== 2) throw new Error(`Not your phase: ${tool} is a phase-2 tool and you own P${phase}`);
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

  pi.registerTool({
    name: "judge_round",
    label: "Judge a tournament round",
    description:
      "Judge one Phase 2 ranking round. Round 0 takes every submitted puzzle with its card and merged review and refuses until the pool is closed; later rounds take `entrants` plus `pairs` (child, parent) and play each child against its parent first. A PARTIAL answer means call again with the same arguments to resume. A COMPLETE answer appends the round's stop decision; STOP means no more evolution children may be created.",
    parameters: JudgeRoundParams,
    async execute(_toolCallId: string, params: JudgeRoundInput) {
      requirePhase2("judge_round");
      return result(await judgeRound(runDir(), params));
    },
  });

  pi.registerTool({
    name: "check_duplicates",
    label: "Check duplicates",
    description:
      "Judge every pair among `ids` for being the same puzzle in both orders. A confirmed duplicate keeps the higher Bradley-Terry score from the latest round and drops the other; the record in owners/phase-2/tournament/distinct.json is unioned with earlier checks and is idempotent.",
    parameters: CheckDuplicatesParams,
    async execute(_toolCallId: string, params: CheckDuplicatesInput) {
      requirePhase2("check_duplicates");
      return result(await checkDuplicates(runDir(), params));
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
