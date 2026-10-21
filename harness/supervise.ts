// The supervisor loop: every tick, read the run's config.json, the owners'
// Herdr states and the run's tree, ask supervisor.ts's decide(), and carry the
// actions out with launch.ts. The rules live in decide(); this file only talks
// to Herdr, git and the tree. A failing Herdr or git call is logged and the
// loop carries on to the next tick.
//
//   node harness/supervise.ts <runDir>
//
// The tick is 60 s (CTC_TICK_MS overrides it for tests). A `done` action logs
// and exits 0. Every line printed is `<ISO time> P<phase> <action> <detail>`.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  nudgeOwner,
  ownerState,
  readConfig,
  realHerdr,
  sessionName,
  startOwner,
  type Herdr,
  type RunConfig,
} from "./launch.ts";
import {
  decide,
  phasesWithNodes,
  viewPhase,
  type Action,
  type Memory,
  type OwnerState,
  type PhaseView,
} from "./supervisor.ts";

const USAGE = "usage: node harness/supervise.ts <runDir>";
const DEFAULT_TICK_MS = 60_000;

function iso(): string {
  return new Date().toISOString();
}

/** Every line the loop prints: `<ISO time> P<phase> <action> <detail>`. */
function log(phase: number | "-", action: string, detail: string): void {
  console.log(`${iso()} P${phase} ${action} ${detail}`);
}

/** Synchronous sleep (Atomics.wait), the same idiom tree.ts uses for its lock. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tickMs(): number {
  const raw = Number(process.env.CTC_TICK_MS ?? DEFAULT_TICK_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TICK_MS;
}

function headOf(runDir: string): string {
  return execFileSync("git", ["-C", runDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15_000,
  }).trim();
}

function hasWork(view: PhaseView): boolean {
  return view.ready.length > 0 || view.running.length > 0 || view.finished.length > 0 || view.inputs.length > 0;
}

/** Carry one decide() action out; returns true when the run is done. */
function execute(
  runDir: string,
  herdr: Herdr,
  cfg: RunConfig,
  started: Set<number>,
  action: Action,
): boolean {
  switch (action.kind) {
    case "done": {
      const waiting = Object.entries(action.waitingForUnconfiguredPhases)
        .map(([phase, count]) => `P${phase} (${count} ready)`)
        .join(", ");
      log("-", "done", waiting === "" ? "run finished" : `run finished; waiting for unconfigured phases: ${waiting}`);
      return true;
    }
    case "start": {
      const result = startOwner(runDir, action.phase, cfg, herdr);
      // An owner that exists (or was just started) must not be started again on
      // the next tick, even before Herdr reports it working.
      if (result !== "failed") started.add(action.phase);
      log(action.phase, "start", `${action.reason}; owner-p${action.phase} ${result}`);
      return false;
    }
    case "nudge": {
      log(action.phase, "nudge", action.message);
      if (!nudgeOwner(herdr, action.phase, action.message)) log(action.phase, "nudge", "agent prompt failed");
      return false;
    }
    case "stalled":
      log(action.phase, "stalled", "three nudges with no new commit; waiting for a new HEAD (one more nudge after 10 minutes)");
      return false;
  }
}

interface TickResult {
  memory: Memory;
  done: boolean;
}

/** One full tick; a bad config.json is logged and the tick skipped. */
function tick(runDir: string, herdr: Herdr, started: Set<number>, memory: Memory): TickResult {
  let cfg: RunConfig;
  try {
    cfg = readConfig(runDir);
  } catch (error) {
    log("-", "config", `${error instanceof Error ? error.message : String(error)}; skipping this tick`);
    return { memory, done: false };
  }

  const configured = new Set<number>();
  for (const key of Object.keys(cfg.phases)) configured.add(Number(key));
  const phases = new Set<number>(phasesWithNodes(runDir));
  for (const phase of configured) phases.add(phase);
  const ordered = [...phases].sort((a, b) => a - b);
  const entry = configured.size > 0 ? Math.min(...configured) : -1;

  const states = new Map<number, OwnerState>();
  for (const phase of ordered) {
    const state = ownerState(herdr, phase);
    states.set(phase, state);
    if (state !== "gone") started.add(phase);
  }

  const views = ordered.map((phase) =>
    viewPhase(runDir, phase, states.get(phase) ?? "unknown", {
      configured: configured.has(phase),
      started: started.has(phase),
      entry: phase === entry,
    }),
  );

  for (const view of views) {
    if (view.owner === "blocked") log(view.phase, "blocked", "owner reports blocked; leaving it alone");
    if (view.owner === "unknown") log(view.phase, "unknown", "owner state is unknown; leaving it alone");
  }

  // A phase with work but no skill in config.json waits for a human; report it
  // every tick. Phases without work are not waiting for anything.
  for (const view of views) {
    if (!view.configured && hasWork(view)) log(view.phase, "waiting", "no skill configured");
  }

  const head = headOf(runDir);
  const { actions, memory: next } = decide(views, head, memory);

  let done = false;
  for (const action of actions) done = execute(runDir, herdr, cfg, started, action) || done;
  return { memory: next, done };
}

function main(args: string[]): number {
  const [runArg] = args;
  if (runArg === undefined) {
    console.error(USAGE);
    return 2;
  }
  const runDir = path.resolve(runArg);
  if (!fs.existsSync(path.join(runDir, "node.json"))) {
    console.error(`supervise.ts: ${runDir} is not a run (no node.json)`);
    return 2;
  }

  const session = sessionName(runDir);
  const herdr = realHerdr(session);
  const interval = tickMs();
  log("-", "start", `supervising ${runDir} every ${interval} ms in session ${session}`);

  const started = new Set<number>();
  let memory: Memory = { head: "", nudges: {}, stalled: [], doneStreak: 0 };
  for (;;) {
    try {
      const result = tick(runDir, herdr, started, memory);
      memory = result.memory;
      if (result.done) return 0;
    } catch (error) {
      console.error(`${iso()} P- error ${error instanceof Error ? error.message : String(error)}`);
    }
    sleepSync(interval);
  }
}

process.exitCode = main(process.argv.slice(2));
