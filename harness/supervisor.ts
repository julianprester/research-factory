// The supervisor's decision logic, as one pure function.
//
// A tick reads each owned phase as a PhaseView (viewPhase, below), then decide()
// turns those views, the run's HEAD and its own memory into actions. The loop
// that carries the actions out with Herdr lives in supervise.ts; keeping the
// rules here means they can be unit-tested without a tree or an agent.
//
// The rules (docs/superpowers/plans/2026-10-13-ctc-supervisor.md, Task 2):
// restart a gone owner; nudge an idle/done owner when work is waiting; leave an
// owner alone while its workers run; stall a phase after three nudges without a
// new commit; and call the run done before anything else when no owned phase has
// work and no owner is working. Done has to hold on two consecutive ticks, so a
// just-started, not-yet-prompted owner (idle, empty tree) cannot end the run.
import * as fs from "node:fs";
import * as path from "node:path";

import { listNodes } from "./tree.ts";

export type OwnerState = "idle" | "working" | "blocked" | "done" | "unknown" | "gone";

export interface PhaseView {
  phase: number;
  owner: OwnerState;
  ready: string[]; // node ids in this phase with status ready
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
  | { kind: "restart"; phase: number }
  | { kind: "nudge"; phase: number; message: string }
  | { kind: "stalled"; phase: number }
  | { kind: "done"; waitingForUnownedPhases: Record<number, number> };

/** How many nudges in a row a phase gets before it is considered stalled. */
const NUDGE_LIMIT = 3;

/** A phase has work when at least one of its nodes is ready, running or finished. */
function hasWork(view: PhaseView): boolean {
  return view.ready.length > 0 || view.running.length > 0 || view.finished.length > 0;
}

function nudgeMessage(view: PhaseView): string {
  const parts: string[] = [];
  if (view.ready.length > 0) parts.push(`ready ${view.ready.join(", ")}`);
  if (view.finished.length > 0) parts.push(`handoffs waiting in ${view.finished.join(", ")}`);
  return `Continue phase ${view.phase}: ${parts.join("; ")}. Trust tree_list and your ledger.`;
}

export function decide(
  views: PhaseView[],
  unowned: Record<number, number>,
  head: string,
  memory: Memory,
): { actions: Action[]; memory: Memory } {
  // A new HEAD is a new run of attempts: forget every nudge count and stall.
  // The done streak survives a HEAD change: a commit does not make a finished
  // run unfinished, and the owner may commit while the run is quiet.
  const current: Memory =
    head === memory.head
      ? { head, nudges: { ...memory.nudges }, stalled: [...memory.stalled], doneStreak: memory.doneStreak }
      : { head, nudges: {}, stalled: [], doneStreak: memory.doneStreak };

  // Done is checked first: a finished run is never nudged, restarted or stalled,
  // even by an owner that has gone away. It must hold on two consecutive ticks:
  // `agent start` leaves the owner idle until it is prompted, and one quiet tick
  // is not a finished run (run.sh starts this loop right after the prompt).
  if (!views.some(hasWork) && !views.some((view) => view.owner === "working")) {
    current.doneStreak += 1;
    if (current.doneStreak >= 2) {
      return { actions: [{ kind: "done", waitingForUnownedPhases: unowned }], memory: current };
    }
    return { actions: [], memory: current };
  }
  current.doneStreak = 0;

  const actions: Action[] = [];
  for (const view of views) {
    if (view.owner === "gone") {
      actions.push({ kind: "restart", phase: view.phase });
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

/** One phase as decide() sees it: the run's tree, filtered to that phase. */
export function viewPhase(runDir: string, phase: number, owner: OwnerState): PhaseView {
  const ready: string[] = [];
  const running: string[] = [];
  const finished: string[] = [];
  for (const node of listNodes(runDir)) {
    if (node.phase !== phase) continue;
    if (node.status === "ready") {
      ready.push(node.id);
    } else if (node.status === "active") {
      (fs.existsSync(path.join(node.dir, "handoff.md")) ? finished : running).push(node.id);
    }
  }
  return { phase, owner, ready, running, finished };
}
