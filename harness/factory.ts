// The research factory's four subcommands: init, status, stop and resume.
//
// This is the layer the pi command (harness/research-factory-extension.ts) and
// the plain CLI (harness/factory-cli.ts) sit on: every function returns the
// text to show and throws on error. All Herdr and process work goes through
// the injectable FactoryDeps, so the tests drive a fake Herdr and no real
// session is needed. The verified Herdr commands live in harness/launch.ts.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  ensureSession,
  ownerState,
  readConfig,
  realHerdr,
  sessionName,
  startSupervisor,
  supervisorPid,
  type Herdr,
  type RunConfig,
} from "./launch.ts";
import { initRun, listNodes } from "./tree.ts";

/**
 * What init writes into a new run and what a demo run starts with. `judgeModel`
 * is optional: a run without it judges on `model` (readConfig fills it in).
 */
export const DEFAULT_CONFIG: RunConfig = {
  model: "claude-bridge/claude-haiku-5-5",
  phases: { "0": "harness/skills/phase-0", "1": "harness/skills/phase-1", "2": "harness/skills/phase-2" },
};

/**
 * Everything init/status/stop/resume touch outside the run's files. `herdr` is
 * scoped to a session (`--session` is prepended by launch.realHerdr);
 * `rootHerdr` runs the unscoped CLI, because `session delete` is not
 * `--session`-scoped. The supervisor's pane pid is looked up in /proc by
 * launch.supervisorPid.
 */
export interface FactoryDeps {
  herdr: (session: string) => Herdr;
  rootHerdr?: Herdr;
  startServer?: (session: string) => void;
  now?: () => Date;
  runsDir?: string;
}

export const USAGE =
  'usage: /research-factory <init <dataset> "<interest>" [runDir] | status [runDir] | stop [runDir] | resume [runDir]>';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runsDirOf(deps: FactoryDeps): string {
  return path.resolve(deps.runsDir ?? path.join(process.cwd(), "runs"));
}

/** YYYYMMDD-HHMM, local time: the stamp in a default run dir name. */
function stamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

/** Synchronous sleep (Atomics.wait), the idiom the rest of harness/ uses. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function realRootHerdr(args: string[]): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync("herdr", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    });
    return { ok: true, stdout };
  } catch (error) {
    if (error !== null && typeof error === "object" && "stdout" in error) {
      return { ok: false, stdout: String((error as { stdout?: unknown }).stdout ?? "") };
    }
    return { ok: false, stdout: "" };
  }
}

/** Real deps: the herdr CLI, the wall clock and `<cwd>/runs`. */
export function realDeps(cwd = process.cwd()): FactoryDeps {
  return {
    herdr: (session) => realHerdr(session),
    rootHerdr: realRootHerdr,
    now: () => new Date(),
    runsDir: path.join(cwd, "runs"),
  };
}

/** The run dir under runs/ whose directory was modified most recently. */
export function latestRun(runsDir: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.resolve(runsDir), { withFileTypes: true });
  } catch {
    return null;
  }
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const runDir = path.join(path.resolve(runsDir), entry.name);
    try {
      if (!fs.statSync(runDir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!fs.existsSync(path.join(runDir, "node.json"))) continue;
    const mtime = fs.statSync(runDir).mtimeMs;
    if (mtime > bestMs) {
      bestMs = mtime;
      best = runDir;
    }
  }
  return best;
}

/** The explicit run dir, or the latest run; both must hold a node.json. */
function resolveRun(runDir: string | undefined, deps: FactoryDeps): string {
  const dir = runDir !== undefined ? path.resolve(runDir) : latestRun(runsDirOf(deps));
  if (dir === null) throw new Error(`no runs in ${runsDirOf(deps)}`);
  if (!fs.existsSync(path.join(dir, "node.json"))) throw new Error(`${dir} is not a run (no node.json)`);
  return dir;
}

/**
 * Bring the run's session up (init and resume only). An injected startServer is
 * used when present; otherwise `ensureSession`'s default detached
 * `herdr --session S server` spawn runs. The supervisor and the owners it
 * starts never come through here.
 */
function openSession(runDir: string, session: string, deps: FactoryDeps): void {
  const start = deps.startServer;
  ensureSession(runDir, deps.herdr(session), start === undefined ? undefined : () => start(session));
}

/** Start the supervisor, reporting a pane failure instead of throwing. */
function startSupervisorText(runDir: string, session: string, deps: FactoryDeps): string {
  try {
    return startSupervisor(runDir, deps.herdr(session)) === "started"
      ? "supervisor started"
      : "supervisor already running";
  } catch (error) {
    return `supervisor did not start: ${message(error)}`;
  }
}

/**
 * Create a run, write the default config.json (left uncommitted: it is picked
 * up by the first tree commit) and start the supervisor. Returns the text.
 */
export function init(args: { dataset: string; interest: string; runDir?: string }, deps: FactoryDeps = realDeps()): string {
  const dataset = path.resolve(args.dataset);
  const runDir =
    args.runDir !== undefined
      ? path.resolve(args.runDir)
      : path.join(runsDirOf(deps), `${path.basename(dataset)}-${stamp((deps.now ?? (() => new Date()))())}`);

  initRun(runDir, dataset, args.interest);
  fs.writeFileSync(path.join(runDir, "config.json"), JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");

  const session = sessionName(runDir);
  openSession(runDir, session, deps);
  return [`created run ${runDir}`, startSupervisorText(runDir, session, deps), `attach: herdr session attach ${session}`].join(
    "\n",
  );
}

/**
 * Count the nodes of one phase by status, in first-seen order. The statuses are
 * whatever the tree holds — `ready`, `active`, `submitted`, `closed`, or
 * `input` for a node a phase reads as its job list — so a new status needs no
 * change here.
 */
function statusCounts(nodes: ReturnType<typeof listNodes>, phase: number): string {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (node.phase !== phase || node.status === "-") continue;
    counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  }
  if (counts.size === 0) return "no nodes";
  return [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(", ");
}

/** The last `limit` commits as `%h %an %s`, newest first. */
function commits(runDir: string, limit: number): string[] {
  try {
    const out = execFileSync("git", ["-C", runDir, "log", `-${limit}`, "--format=%h %an %s"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    });
    const lines = out.split("\n").filter((line) => line.trim() !== "");
    return lines.length > 0 ? lines : ["(no commits)"];
  } catch {
    return ["(no commits)"];
  }
}

/**
 * The run's state: the supervisor pid, each phase's owner state and node
 * counts, and the last five commits. It never touches the session, so it also
 * works while the session is down; then it says so and shows the tree anyway.
 */
export function status(runDir: string | undefined, deps: FactoryDeps = realDeps()): string {
  const dir = resolveRun(runDir, deps);
  const session = sessionName(dir);
  const pid = supervisorPid(dir);
  const lines = [dir, `supervisor: ${pid === null ? "not running" : `running (pid ${pid})`}`];

  const herdr = deps.herdr(session);
  if (!herdr(["workspace", "list"]).ok) lines.push(`session ${session}: not running`);

  let cfg: RunConfig | null = null;
  try {
    cfg = readConfig(dir);
  } catch (error) {
    lines.push(`config: ${message(error)}`);
  }

  const nodes = listNodes(dir);
  const phases = new Set<number>();
  if (cfg !== null) for (const key of Object.keys(cfg.phases)) phases.add(Number(key));
  for (const node of nodes) if (node.parent !== null) phases.add(node.phase);

  for (const phase of [...phases].sort((a, b) => a - b)) {
    const state = ownerState(herdr, phase);
    const owner = state === "gone" ? "not started" : state;
    const configured = cfg !== null && Object.hasOwn(cfg.phases, String(phase)) ? "" : "; not configured";
    lines.push(`P${phase} owner ${owner}${configured}; ${statusCounts(nodes, phase)}`);
  }

  lines.push("commits:");
  for (const commit of commits(dir, 5)) lines.push(`  ${commit}`);
  return lines.join("\n");
}

/** true when supervisorPid no longer sees the supervisor for this run. */
function waitGone(runDir: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (supervisorPid(runDir) === null) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(50);
  }
}

/**
 * Stop the run, in this order: the supervisor first (SIGTERM, then SIGKILL
 * after 5 s — it would otherwise start its owners again), then the session's
 * server, then the session itself. Owners and workers are not signalled.
 */
export function stop(runDir: string | undefined, deps: FactoryDeps = realDeps()): string {
  const dir = resolveRun(runDir, deps);
  const session = sessionName(dir);
  const lines: string[] = [];

  const pid = supervisorPid(dir);
  if (pid === null) {
    lines.push("supervisor: not running");
  } else {
    lines.push(`supervisor: SIGTERM pid ${pid}`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* it exited between the scan and the signal */
    }
    if (!waitGone(dir, 5000)) {
      lines.push(`supervisor: still running after 5 s; SIGKILL pid ${pid}`);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* it exited between the wait and the signal */
      }
      waitGone(dir, 1000);
    }
    lines.push(`supervisor: ${supervisorPid(dir) === null ? "stopped" : "still running"}`);
  }

  const server = deps.herdr(session)(["server", "stop"]);
  lines.push(server.ok ? `session ${session}: server stopped` : `session ${session}: server stop failed`);
  const deleted = (deps.rootHerdr ?? realRootHerdr)(["session", "delete", session]);
  lines.push(deleted.ok ? `session ${session}: deleted` : `session ${session}: delete failed`);
  lines.push("workers: not touched");
  return lines.join("\n");
}

/** Start a supervisor for a run that already exists. Refuses if one runs. */
export function resume(runDir: string | undefined, deps: FactoryDeps = realDeps()): string {
  const dir = resolveRun(runDir, deps);
  const session = sessionName(dir);
  const pid = supervisorPid(dir);
  if (pid !== null) throw new Error(`supervisor is already running (pid ${pid}); stop the run first`);

  openSession(dir, session, deps);
  return [`run ${dir}`, startSupervisorText(dir, session, deps), `attach: herdr session attach ${session}`].join("\n");
}

const SUBCOMMANDS = ["init", "status", "stop", "resume"];

/** Split a command line the way a shell does: quotes group, backslash escapes. */
function split(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < input.length && ['"', "\\", "$", "`"].includes(input[i + 1])) current += input[++i];
      else current += ch;
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= input.length) throw new Error("dangling backslash in command");
      current += input[++i];
      started = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote !== null) throw new Error(`unterminated ${quote} in command`);
  if (started) tokens.push(current);
  return tokens;
}

/** Parse `/research-factory` input into a subcommand and its arguments. */
export function parseCommand(input: string): { sub: "init" | "status" | "stop" | "resume"; args: string[] } | { error: string } {
  let tokens: string[];
  try {
    tokens = split(input);
  } catch (error) {
    return { error: message(error) };
  }
  const [sub, ...args] = tokens;
  if (sub === undefined) return { error: USAGE };
  if (!SUBCOMMANDS.includes(sub)) {
    return { error: `unknown subcommand "${sub}"; expected one of ${SUBCOMMANDS.join(", ")}` };
  }
  return { sub: sub as "init" | "status" | "stop" | "resume", args };
}

/** Parse and run one command line; shared by the pi command and the CLI. */
export function runCommand(input: string, deps: FactoryDeps = realDeps()): string {
  const parsed = parseCommand(input);
  if ("error" in parsed) throw new Error(parsed.error);

  if (parsed.sub === "init") {
    const [dataset, interest, runDir, ...rest] = parsed.args;
    if (dataset === undefined || interest === undefined || rest.length > 0) throw new Error(USAGE);
    return init({ dataset, interest, runDir }, deps);
  }

  const [runDir, ...rest] = parsed.args;
  if (rest.length > 0) throw new Error(USAGE);
  switch (parsed.sub) {
    case "status":
      return status(runDir, deps);
    case "stop":
      return stop(runDir, deps);
    case "resume":
      return resume(runDir, deps);
  }
}
