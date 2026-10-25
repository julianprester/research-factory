// The phase-owner extension: an owner session's only way to touch the tree.
//
// Pi loads this with the run and phase in the environment (see
// harness/launch.ts's startOwner):
// CTC_RUN_DIR is the run folder, CTC_PHASE the phase this session owns. Every
// tool refuses nodes outside that phase, and a `tool_call` guard blocks
// `write`/`edit` calls outside `owners/phase-<phase>/` and node briefs. Owners
// of Phases 3 and 4 also get `read`/`bash` refused for the dataset and the
// hold-out (design §9: the owner's Predictions are the Phase 5 preregistration). The
// environment is read when a tool runs, not at module load, so tests (and
// reloaded sessions) can set it around the factory call.
import * as path from "node:path";
import { Type } from "typebox";

import {
  archiveScript,
  closeRound,
  openRound,
  reproduce,
  submit,
  type ArchiveScriptInput,
  type CloseRoundInput,
  type OpenRoundInput,
  type ReproduceInput,
  type SubmitInput,
} from "./explain/tools.ts";
import { datasetRefusal, holdoutRefusal, ownerMayWrite } from "./guard.ts";
import {
  checkDuplicates,
  judgeRound,
  promote,
  tournamentDir,
  type CheckDuplicatesInput,
  type JudgeRoundInput,
  type PromoteInput,
} from "./tournament/tools.ts";
import { readStop, type Decision } from "./tournament/stop.ts";
import { CHILD_TYPE, createChild, findNode, listNodes, readRun, updateNode, type NodeRef } from "./tree.ts";

interface ToolCallEventLike {
  toolName: string;
  input?: { path?: unknown; command?: unknown } | undefined;
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

const PromoteParams = Type.Object({
  nodeId: Type.String({ description: "The submitted Phase 2 puzzle to promote, e.g. P03" }),
  note: Type.Optional(Type.String({ description: "Why this one: recorded in the commit message, not on the node" })),
});

const OpenRoundParams = Type.Object({
  nodeId: Type.String({ description: "The explanation node, e.g. E01" }),
  plan: Type.String({
    description:
      "The round's plan, markdown: a `## Questions` section and a `## Tasks` section with one `### Task <L>: <aim>` heading per task, <L> a capital letter never used before in this node (in a reopen loop, <L> is R<n><L>, such as R1A)",
  }),
});

const CloseRoundParams = Type.Object({
  nodeId: Type.String({ description: "The explanation node, e.g. E01" }),
  changed: Type.Union([Type.Literal("substantial"), Type.Literal("none")], {
    description: '"substantial" if the theoretical argument changed substantially this round (it must differ from the last round\'s), otherwise "none"',
  }),
  summary: Type.String({ description: "What changed in the argument, or why nothing did; it becomes the round's verdict" }),
});

const ArchiveScriptParams = Type.Object({
  nodeId: Type.String({ description: "The explanation node, e.g. E01" }),
  script: Type.String({ description: "The script file name in workspace/scripts, e.g. A_01.R" }),
  reason: Type.String({ description: "Why this analysis is dropped; recorded in archive/<stem>/README.md" }),
});

const ReproduceParams = Type.Object({
  nodeId: Type.String({ description: "The explanation node, e.g. E01" }),
});

const SubmitParams = Type.Object({
  nodeId: Type.String({ description: "The explanation node, e.g. E01" }),
  note: Type.Optional(Type.String({ description: "Why it is ready: recorded in the commit message, not on the node" })),
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

/**
 * Why a phase-3 or phase-4 owner may not run this `read` or `bash`, or undefined when it may. Design §9
 * locks the hold-out for Phases 1-4, and the owner writes the Predictions that become the Phase 5
 * preregistration, so one stray look at the dataset would contaminate them: the owner reads no dataset
 * file and names no hold-out, exactly as its workers cannot. (The workers read the data; the owner never
 * does.) Owners of phases 0 to 2 are unaffected. A phase-3/4 owner whose run's dataset cannot be read is
 * refused every read and bash: the guard has no root to check against, so it fails closed.
 */
function dataOrHoldoutRefusal(event: ToolCallEventLike): string | undefined {
  let phase: number;
  try {
    phase = ownerPhase();
  } catch {
    return undefined; // an owner session with no phase configured: the write guard already fails closed
  }
  if (phase !== 3 && phase !== 4) return undefined;
  const holdout = holdoutRefusal(event.toolName, event.input);
  if (holdout !== undefined) return holdout.replace("workers in Phases 1 to 4", "the owner in Phases 3 and 4");
  let dataset: string;
  try {
    dataset = path.resolve(runDir(), readRun(runDir()).dataset);
  } catch {
    return `Refusing ${event.toolName}: the run's dataset root cannot be read, so the owner cannot show it is not being read`;
  }
  return datasetRefusal(dataset, event.toolName, event.input);
}

function actor(phase: number): string {
  return `owner-p${phase}`;
}

/** The tournament tools are Phase 2's alone, whatever tree the session can see. */
function requirePhase2(tool: string): void {
  const phase = ownerPhase();
  if (phase !== 2) throw new Error(`Not your phase: ${tool} is a phase-2 tool and you own P${phase}`);
}

/** The explanation-loop tools are Phase 3's alone. */
function requirePhase3(tool: string): void {
  const phase = ownerPhase();
  if (phase !== 3) throw new Error(`Not your phase: ${tool} is a phase-3 tool and you own P${phase}`);
}

function refuseNotYourPhase(nodePhase: number, phase: number): Error {
  return new Error(`Not your phase (node in P${nodePhase}, you own P${phase})`);
}

/**
 * The evolution gate (design §6): while the tournament's recorded decision is
 * STOP, no puzzle with a parent may be created. The gate is read from the file
 * for every create, so a stop recorded after the session started still bites. A
 * record that cannot be read is a refusal too: a STOP that cannot be read is not
 * a stop that did not happen.
 */
function refuseEvolvedAfterStop(dir: string): void {
  let decision: Decision;
  try {
    decision = readStop(path.join(tournamentDir(dir), "rounds.json"));
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    throw new Error(`STOP record unreadable: ${text}`);
  }
  if (decision.stop) throw new Error(`STOP recorded (${decision.reason}): no more evolution`);
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
      const childType = params.type ?? CHILD_TYPE[parent.type];
      // A paper is the Phase 4 writer's node. These gates come before the phase compare, so each names its own rule.
      if (childType === "paper") {
        if (parent.type !== "explanation") throw new Error(`${parent.id} is a ${parent.type}: a paper goes under an explanation`);
        if (phase !== 4) throw new Error(`Not your phase: a paper is made by the phase-4 owner, and you own P${phase}`);
        if (parent.phase !== 4) {
          throw new Error(`${parent.id} is in Phase ${parent.phase}, not Phase 4: papers are created only under explanations that submit has moved to Phase 4`);
        }
      }
      const nodePhase = createPhase(parent, params.type);
      if (nodePhase !== phase) throw refuseNotYourPhase(nodePhase, phase);
      // An explanation belongs to a promoted puzzle: a puzzle still in Phase 2 has not passed `promote`'s gates.
      if (parent.type === "puzzle" && childType === "explanation" && parent.phase !== 3) {
        throw new Error(`${parent.id} is in Phase ${parent.phase}, not Phase 3: explanations are created only under puzzles that promote has moved to Phase 3`);
      }
      // The child's resolved type decides whether this is evolution; only a
      // puzzle with a derivedFrom is a child of the tournament.
      const derivedFrom = params.derivedFrom ?? [];
      if (childType === "puzzle" && derivedFrom.length > 0) refuseEvolvedAfterStop(dir);
      const node = createChild(dir, params.parentId, params.title, actor(phase), derivedFrom, params.type);
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
      // Promotion is never self-declared (design spec §5.2): a puzzle reaches
      // Phase 3 only through `promote`, which runs the gates first. A puzzle's
      // phase is otherwise fixed; its status still moves within Phase 2.
      if (
        found.type === "puzzle" &&
        (params.status === "promoted" || (params.phase !== undefined && params.phase !== found.phase))
      ) {
        throw new Error("use promote: puzzles reach Phase 3 only through the gated promote tool");
      }
      // The same for an explanation: it reaches Phase 4 only through `submit`, which runs the end gate.
      if (
        found.type === "explanation" &&
        (params.status === "submitted" || (params.phase !== undefined && params.phase !== found.phase))
      ) {
        throw new Error("use submit: an explanation reaches Phase 4 only through the gated submit tool");
      }
      // And a paper reaches Phase 5 only through `submit_paper`, which runs the end checks.
      if (
        found.type === "paper" &&
        (params.status === "submitted" || (params.phase !== undefined && params.phase !== found.phase))
      ) {
        throw new Error("use submit_paper: a paper reaches Phase 5 only through the gated submit_paper tool");
      }
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

  pi.registerTool({
    name: "promote",
    label: "Promote a puzzle",
    description:
      "Promote one submitted Phase 2 puzzle to Phase 3 after the final round's STOP. The tool refuses, naming the gate, unless: a STOP is recorded; the puzzle is ranked in the final round with at least 6 matches; the distinctness check lists it and did not drop it; its merged review has no plausibility fails and none of the breakdown, knownResultBlocking, dataCharacterViolated or reviewBlocked flags; and check-puzzle passes. You decide how many to promote; park the rest.",
    parameters: PromoteParams,
    async execute(_toolCallId: string, params: PromoteInput) {
      requirePhase2("promote");
      return result(await promote(runDir(), params));
    },
  });

  pi.registerTool({
    name: "open_round",
    label: "Open a round",
    description:
      "Open the next round of an explanation node from your plan. The plan needs `## Questions` and `## Tasks` sections, each task a `### Task <L>: <aim>` heading with a capital letter never used in this node before. The tool writes rounds/NN/plan.md, creates tasks/<L>/ for each letter, and on round 1 snapshots the puzzle and its Phase 3 must-check list into the workspace. It refuses while the previous round is open, after the cap, and after a recorded STOP. In a reopen loop the tasks are `R<n><L>`, such as `R1A`, and the cap is the reopen's own.",
    parameters: OpenRoundParams,
    async execute(_toolCallId: string, params: OpenRoundInput) {
      requirePhase3("open_round");
      return result(await openRound(runDir(), params));
    },
  });

  pi.registerTool({
    name: "close_round",
    label: "Close a round",
    description:
      "Close the open round with your verdict. Refuses unless every task of the plan has a handoff whose first line is a Status other than BLOCKED, the round's literature handoff and report exist, and workspace/argument.md exists; round 1 cannot be \"none\", and \"substantial\" needs an argument that differs from the previous round's. Writes rounds/NN/verdict.md, records the round and reports whether the loop continues or STOPs (two consecutive \"none\" rounds, or the round cap).",
    parameters: CloseRoundParams,
    async execute(_toolCallId: string, params: CloseRoundInput) {
      requirePhase3("close_round");
      return result(await closeRound(runDir(), params));
    },
  });

  pi.registerTool({
    name: "archive_script",
    label: "Archive a script",
    description:
      "Drop an analysis: move workspace/scripts/<script> and its output/numbers/<stem>.csv and output/logs/<stem>.txt into workspace/archive/<stem>/ with a README holding your reason. Refuses an empty reason and any script or output file that argument.md links to.",
    parameters: ArchiveScriptParams,
    async execute(_toolCallId: string, params: ArchiveScriptInput) {
      requirePhase3("archive_script");
      return result(await archiveScript(runDir(), params));
    },
  });

  pi.registerTool({
    name: "reproduce",
    label: "Reproduce the analyses",
    description:
      "After the loop has STOPped, re-run every script of an explanation node in the container into an empty output and compare the registry with yours (exact for text and integers, relative 1e-6 for floats). A call is bounded to about 8 minutes, checked between scripts: a PARTIAL answer means call reproduce again to resume. A complete one writes and commits owners/phase-3/loop/<E>/reproduction.json. Editing a script or a number afterwards invalidates it.",
    parameters: ReproduceParams,
    async execute(_toolCallId: string, params: ReproduceInput) {
      requirePhase3("reproduce");
      return result(await reproduce(runDir(), params));
    },
  });

  pi.registerTool({
    name: "submit",
    label: "Submit an explanation",
    description:
      "Submit an explanation node to Phase 4. Refuses, naming the gate, unless: a STOP is recorded; the node has scripts; check-argument (with its review checks) has no problems; the last reproduction is ok and the scripts and numbers still hash the same; the review report is not BLOCKED; and every finding has a ruling in reviews/revision.md. Then one commit sets the node ready in Phase 4; its sha is the argument's preregistration for Phase 5.",
    parameters: SubmitParams,
    async execute(_toolCallId: string, params: SubmitInput) {
      requirePhase3("submit");
      return result(await submit(runDir(), params));
    },
  });

  pi.on("tool_call", (event) => {
    if (event.toolName === "read" || event.toolName === "bash") {
      const reason = dataOrHoldoutRefusal(event);
      return reason === undefined ? undefined : { block: true, reason };
    }
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
