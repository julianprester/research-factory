// The supervisor's decision logic, as one pure function.
//
// A tick reads each owned phase as a PhaseView (viewPhase, below), then decide()
// turns those views, the run's HEAD and its own memory into actions. The loop
// that carries the actions out with Herdr lives in supervise.ts; keeping the
// rules here means they can be unit-tested without a tree or an agent.
//
// The rules (docs/superpowers/specs/2026-10-12-ctc-research-factory-design.md
// §5.9): start a gone owner when its phase has work (rerunning a crashed one is
// just starting one that already ran); nudge an idle/done owner when work is
// waiting; leave an owner alone while its workers run; stall a phase after three
// nudges without a new commit; and call the run done before anything else when no
// configured phase has work and no owner is working. Done has to hold on two
// consecutive ticks, so a just-started, not-yet-prompted owner (idle, empty tree)
// cannot end the run, and the entry phase of a brand-new run counts as having
// work so a fresh run starts instead of finishing before its first owner exists.
import * as fs from "node:fs";
import * as path from "node:path";

import { listNodes } from "./tree.ts";

export type OwnerState = "idle" | "working" | "blocked" | "done" | "unknown" | "gone";

export interface PhaseView {
  phase: number;
  owner: OwnerState;
  configured: boolean; // the phase has a skill in config.json
  started: boolean; // an owner for this phase has been started (this supervisor's lifetime or Herdr)
  ready: string[]; // node ids in this phase with status ready ("(entry)" on a fresh run)
  running: string[]; // active nodes in this phase without handoff.md
  finished: string[]; // active nodes in this phase with handoff.md (handoff not yet processed)
}

export interface Memory {
  head: string;
  nudges: Record<number, number>;
  stalled: number[];
  doneStreak: number; // consecutive ticks the done condition has held
}

export type Action =
  | { kind: "start"; phase: number; reason: "never-started" | "gone" }
  | { kind: "nudge"; phase: number; message: string }
  | { kind: "stalled"; phase: number }
  | { kind: "done"; waitingForUnconfiguredPhases: Record<number, number> };

/** How many nudges in a row a phase gets before it is considered stalled. */
const NUDGE_LIMIT = 3;

/** A phase has work when at least one of its nodes is ready, running or finished. */
function hasWork(view: PhaseView): boolean {
  return view.ready.length > 0 || view.running.length > 0 || view.finished.length > 0;
}

/** Phases with work but no skill in config.json, and how many ready nodes each is waiting on. */
function unconfiguredPhases(views: PhaseView[]): Record<number, number> {
  const waiting: Record<number, number> = {};
  for (const view of views) {
    if (!view.configured && hasWork(view)) waiting[view.phase] = view.ready.length;
  }
  return waiting;
}

function nudgeMessage(view: PhaseView): string {
  const ids = [...view.ready, ...view.finished];
  return `Continue phase ${view.phase}: ${view.ready.length} ready, ${view.finished.length} handoffs waiting (${ids.join(", ")}). Trust tree_list and your ledger; your phase skill's limits still apply.`;
}

export function decide(views: PhaseView[], head: string, memory: Memory): { actions: Action[]; memory: Memory } {
  // A new HEAD is a new run of attempts: forget every nudge count and stall.
  // The done streak survives a HEAD change: a commit does not make a finished
  // run unfinished, and the owner may commit while the run is quiet.
  const current: Memory =
    head === memory.head
      ? { head, nudges: { ...memory.nudges }, stalled: [...memory.stalled], doneStreak: memory.doneStreak }
      : { head, nudges: {}, stalled: [], doneStreak: memory.doneStreak };

  // Done is checked first: a finished run is never nudged, started or stalled,
  // even by an owner that has gone away. Only configured phases count as work:
  // a phase with no skill waits for a human to configure it, and the loop reports
  // it every tick. Done must hold on two consecutive ticks: `agent start` leaves
  // the owner idle until it is prompted, and one quiet tick is not a finished run.
  if (!views.some((view) => view.configured && hasWork(view)) && !views.some((view) => view.owner === "working")) {
    current.doneStreak += 1;
    if (current.doneStreak >= 2) {
      return {
        actions: [{ kind: "done", waitingForUnconfiguredPhases: unconfiguredPhases(views) }],
        memory: current,
      };
    }
    return { actions: [], memory: current };
  }
  current.doneStreak = 0;

  const actions: Action[] = [];
  for (const view of views) {
    // A phase with no skill in config.json has no owner to start, nudge or stall.
    if (!view.configured) continue;
    if (view.owner === "gone") {
      // Work is what earns an owner. A gone owner whose phase still has work is
      // started again (its workers may have survived it); a gone owner with no
      // work is left gone, and the run will finish instead.
      if (hasWork(view)) {
        actions.push({ kind: "start", phase: view.phase, reason: view.started ? "gone" : "never-started" });
      }
      continue;
    }
    // working, blocked and unknown owners are left alone (the loop logs blocked).
    if (view.owner !== "idle" && view.owner !== "done") continue;
    // Only running workers: they will report back, so do not interrupt the owner.
    if (view.ready.length === 0 && view.finished.length === 0) continue;
    // Already stalled on this HEAD: nothing changes until a new commit moves it.
    if (current.stalled.includes(view.phase)) continue;
    if ((current.nudges[view.phase] ?? 0) >= NUDGE_LIMIT) {
      current.stalled.push(view.phase);
      actions.push({ kind: "stalled", phase: view.phase });
      continue;
    }
    current.nudges[view.phase] = (current.nudges[view.phase] ?? 0) + 1;
    actions.push({ kind: "nudge", phase: view.phase, message: nudgeMessage(view) });
  }
  return { actions, memory: current };
}

/** The phases the tree has nodes in; the root (phase 0) is not a phase. */
export function phasesWithNodes(runDir: string): number[] {
  const phases = new Set<number>();
  for (const node of listNodes(runDir)) {
    // The root is a dataset, not a phase: everything else counts, phase 0 included.
    if (node.parent !== null) phases.add(node.phase);
  }
  return [...phases].sort((a, b) => a - b);
}

/** One phase as decide() sees it: the run's tree, filtered to that phase. */
export function viewPhase(
  runDir: string,
  phase: number,
  owner: OwnerState,
  opts: { configured: boolean; started: boolean; entry: boolean },
): PhaseView {
  const nodes = listNodes(runDir);
  const ready: string[] = [];
  const running: string[] = [];
  const finished: string[] = [];
  for (const node of nodes) {
    if (node.phase !== phase) continue;
    if (node.status === "ready") {
      ready.push(node.id);
    } else if (node.status === "active") {
      (fs.existsSync(path.join(node.dir, "handoff.md")) ? finished : running).push(node.id);
    }
  }
  // A brand-new run has no nodes besides the root, so its entry phase would look
  // empty and the run would finish before its first owner ever starts. "(entry)"
  // is not a node id: it is the work of creating the run's first node, and it
  // disappears as soon as the tree has one.
  if (opts.entry && nodes.length === 1) ready.push("(entry)");
  return { phase, owner, configured: opts.configured, started: opts.started, ready, running, finished };
}
