// The supervisor loop: every tick, read the run's owned phases and their
// owners' Herdr states, ask supervisor.ts's decide(), and carry the actions
// out. The rules live in decide(); this file only talks to Herdr, git and the
// run's start scripts. A failing Herdr or git call is logged and the loop
// carries on to the next tick.
//
//   node harness/supervise.ts <runDir>
//
// The tick is 60 s (CTC_TICK_MS overrides it for tests). A `done` action logs
// and exits 0. Every line printed is `<ISO time> P<phase> <action> <detail>`.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { decide, viewPhase, type Action, type Memory, type OwnerState } from "./supervisor.ts";
import { listNodes } from "./tree.ts";

const USAGE = "usage: node harness/supervise.ts <runDir>";
const DEFAULT_TICK_MS = 60_000;
const OWNER_STATES: readonly OwnerState[] = ["idle", "working", "blocked", "done", "unknown"];

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

/** The phases with an `owners/phase-N/start.sh`, in phase order. */
function ownedPhases(runDir: string): number[] {
  const ownersDir = path.join(runDir, "owners");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(ownersDir, { withFileTypes: true });
  } catch {
    return []; // no owners yet: nothing to supervise
  }
  const phases: number[] = [];
  for (const entry of entries) {
    const match = /^phase-(\d+)$/.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    if (fs.existsSync(path.join(ownersDir, entry.name, "start.sh"))) phases.push(Number(match[1]));
  }
  return phases.sort((a, b) => a - b);
}

/** A ready node in a phase with no owner is work nobody has picked up. */
function unownedReady(runDir: string, owned: number[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const node of listNodes(runDir)) {
    if (node.status !== "ready" || owned.includes(node.phase)) continue;
    counts[node.phase] = (counts[node.phase] ?? 0) + 1;
  }
  return counts;
}

/** Herdr exits non-zero when the agent does not exist: that is `gone`. */
function ownerState(session: string, phase: number): OwnerState {
  let out: string;
  try {
    out = execFileSync("herdr", ["--session", session, "agent", "get", `owner-p${phase}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    });
  } catch {
    return "gone";
  }
  try {
    const status = (JSON.parse(out) as { result?: { agent?: { agent_status?: unknown } } }).result?.agent
      ?.agent_status;
    return typeof status === "string" && (OWNER_STATES as readonly string[]).includes(status)
      ? (status as OwnerState)
      : "unknown";
  } catch {
    return "unknown";
  }
}

function headOf(runDir: string): string {
  return execFileSync("git", ["-C", runDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15_000,
  }).trim();
}

/** Restart a gone owner by re-running the exact command run.sh recorded. */
function restart(runDir: string, phase: number): void {
  const script = path.join(runDir, "owners", `phase-${phase}`, "start.sh");
  const result = spawnSync("bash", [script], { cwd: runDir, encoding: "utf8", timeout: 120_000 });
  if (result.error) {
    log(phase, "restart", `could not run ${script}: ${result.error.message}`);
    return;
  }
  if (typeof result.status === "number" && result.status !== 0) {
    log(phase, "restart", `${script} exited ${result.status}`);
  }
  for (const text of [result.stdout ?? "", result.stderr ?? ""]) {
    for (const line of text.split("\n")) {
      if (line.trim() !== "") log(phase, "restart", `output: ${line.trim()}`);
    }
  }
}

/** Nudge an idle owner with the message decide() built; no --wait. */
function nudge(session: string, phase: number, message: string): void {
  try {
    execFileSync("herdr", ["--session", session, "agent", "prompt", `owner-p${phase}`, message], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    });
  } catch (error) {
    log(phase, "nudge", `prompt failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Carry one decide() action out; returns true when the run is done. */
function execute(runDir: string, session: string, action: Action): boolean {
  switch (action.kind) {
    case "done": {
      const waiting = Object.entries(action.waitingForUnownedPhases)
        .map(([phase, count]) => `P${phase} (${count} ready)`)
        .join(", ");
      log("-", "done", waiting === "" ? "run finished" : `run finished; waiting for unowned phases: ${waiting}`);
      return true;
    }
    case "restart":
      log(action.phase, "restart", `owner-p${action.phase} is gone; running owners/phase-${action.phase}/start.sh`);
      restart(runDir, action.phase);
      return false;
    case "nudge":
      log(action.phase, "nudge", action.message);
      nudge(session, action.phase, action.message);
      return false;
    case "stalled":
      log(action.phase, "stalled", "three nudges with no new commit; waiting for a new HEAD");
      return false;
  }
}

interface TickResult {
  memory: Memory;
  done: boolean;
}

/** One full tick; throws only on tree/git errors, which main() logs and survives. */
function tick(runDir: string, session: string, memory: Memory): TickResult {
  const owned = ownedPhases(runDir);
  const states = new Map<number, OwnerState>();
  for (const phase of owned) states.set(phase, ownerState(session, phase));
  for (const phase of owned) {
    if (states.get(phase) === "blocked") log(phase, "blocked", "owner reports blocked; leaving it alone");
    if (states.get(phase) === "unknown") log(phase, "unknown", "owner state is unknown; leaving it alone");
  }

  const head = headOf(runDir);
  const views = owned.map((phase) => viewPhase(runDir, phase, states.get(phase) ?? "unknown"));
  const unowned = unownedReady(runDir, owned);
  const { actions, memory: next } = decide(views, unowned, head, memory);

  let done = false;
  for (const action of actions) done = execute(runDir, session, action) || done;

  // Done reports the unowned phases itself; otherwise say what is waiting.
  if (!done) {
    for (const [phase, count] of Object.entries(unowned)) {
      log(Number(phase), "unowned", `${count} ready node(s) with no owner; not starting one`);
    }
  }
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

  const session = `ctc-${path.basename(runDir)}`;
  const interval = tickMs();
  log("-", "start", `supervising ${runDir} every ${interval} ms in session ${session}`);

  let memory: Memory = { head: "", nudges: {}, stalled: [] };
  for (;;) {
    try {
      const result = tick(runDir, session, memory);
      memory = result.memory;
      if (result.done) return 0;
    } catch (error) {
      console.error(`${iso()} P- error ${error instanceof Error ? error.message : String(error)}`);
    }
    sleepSync(interval);
  }
}

process.exitCode = main(process.argv.slice(2));
