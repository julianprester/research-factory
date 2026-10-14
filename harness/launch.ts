// Herdr, the session server, owners and the supervisor, behind one injectable
// runner. Everything Herdr-shaped lives here; `factory.ts` and `supervise.ts`
// call these functions and never build a herdr argv themselves.
//
// The command sequence is the port of harness/run.sh's Herdr logic; the
// verified commands and JSON paths are in docs/notes/herdr.md. Every command is
// scoped with --session ctc-<basename runDir>: the Herdr type takes the argv
// without it, and realHerdr() prepends it.
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { OwnerState } from "./supervisor.ts";

/** One herdr call: argv without `--session`; ok is the exit status. */
export type Herdr = (args: string[]) => { ok: boolean; stdout: string };

/** The project root: harness/launch.ts lives in harness/, so its parent is the root. */
export const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface RunConfig {
  model: string;
  phases: Record<string, string>;
}

const OWNER_STATES: readonly OwnerState[] = ["idle", "working", "blocked", "done", "unknown"];
/** Canonical phase keys: non-negative integers without leading zeros. */
const PHASE_KEY = /^(0|[1-9]\d*)$/;
const HERDR_TIMEOUT_MS = 30_000;
const SESSION_POLL_MS = 200;
const SESSION_POLL_LIMIT = 100; // 20 s, as run.sh's 100 x 0.2 s

/** The herdr CLI, scoped to one named session. A non-zero exit is {ok: false}. */
export function realHerdr(session: string): Herdr {
  return (args) => {
    try {
      const stdout = execFileSync("herdr", ["--session", session, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: HERDR_TIMEOUT_MS,
      });
      return { ok: true, stdout };
    } catch (error) {
      if (error !== null && typeof error === "object" && "stdout" in error) {
        return { ok: false, stdout: String((error as { stdout?: unknown }).stdout ?? "") };
      }
      return { ok: false, stdout: "" };
    }
  };
}

/** The run's Herdr session and workspace label: ctc-<basename runDir>. */
export function sessionName(runDir: string): string {
  return `ctc-${path.basename(path.resolve(runDir))}`;
}

/** Synchronous sleep (Atomics.wait), the idiom supervise.ts and tree.ts use. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }
}

/** `.result.workspaces[]` → the first workspace_id whose label matches. */
function labelledWorkspace(stdout: string, label: string): string | null {
  const parsed = parseJson(stdout) as {
    result?: { workspaces?: Array<{ label?: unknown; workspace_id?: unknown }> };
  } | null;
  for (const workspace of parsed?.result?.workspaces ?? []) {
    if (workspace.label === label && typeof workspace.workspace_id === "string" && workspace.workspace_id !== "") {
      return workspace.workspace_id;
    }
  }
  return null;
}

/** `.result.panes[0].pane_id` and `.result.pane.pane_id`. */
function paneId(stdout: string, where: "panes" | "pane"): string | null {
  const parsed = parseJson(stdout) as {
    result?: { panes?: Array<{ pane_id?: unknown }>; pane?: { pane_id?: unknown } };
  } | null;
  const id = where === "panes" ? parsed?.result?.panes?.[0]?.pane_id : parsed?.result?.pane?.pane_id;
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * The run's existing workspace id: one `workspace list`, and `null` when the
 * session server does not answer or no workspace carries the run's label. It
 * never starts a server and never creates anything, so `startOwner` and
 * `startSupervisor` can use it without a session of their own: only init and
 * resume may bring a session up.
 */
export function findWorkspace(runDir: string, herdr: Herdr): string | null {
  const list = herdr(["workspace", "list"]);
  return list.ok ? labelledWorkspace(list.stdout, sessionName(path.resolve(runDir))) : null;
}

/**
 * The one place a Herdr session server is started: a detached
 * `herdr --session <session> server`, stdio ignored and unref'd. It is
 * `ensureSession`'s default when no `startServer` is injected; `findWorkspace`,
 * `startOwner` and `startSupervisor` never call it. Exported as an object so
 * tests can replace `start` with a spy and prove no server is ever started.
 */
export const sessionServerStarter = {
  start(session: string): void {
    const child = spawn("herdr", ["--session", session, "server"], { detached: true, stdio: "ignore" });
    // A missing herdr binary emits 'error'; without this listener it would be
    // an uncaught exception. The workspace-list poll in ensureSession turns the
    // missing server into "Herdr session <name> did not start" instead.
    child.on("error", () => {
      /* the poll reports it */
    });
    child.unref();
  },
};

/**
 * The run's Herdr workspace, started and created if needed. **Init and resume
 * only** — the supervisor must never call this (it uses `findWorkspace`). If
 * `workspace list` fails the named session has no server (verified 0.9.3), so
 * startServer (by default the detached `sessionServerStarter`) is called and
 * `workspace list` is polled every 200 ms up to 20 s. Then the workspace
 * labelled sessionName is reused, or created with the run dir and CTC_RUN_DIR.
 * Port of run.sh steps 2-3.
 */
export function ensureSession(runDir: string, herdr: Herdr, startServer?: () => void): string {
  const dir = path.resolve(runDir);
  const name = sessionName(dir);
  const server = startServer ?? (() => sessionServerStarter.start(name));

  let list = herdr(["workspace", "list"]);
  if (!list.ok) {
    server();
    for (let attempt = 0; !list.ok && attempt <= SESSION_POLL_LIMIT; attempt++) {
      if (attempt === SESSION_POLL_LIMIT) break;
      if (attempt > 0) sleepSync(SESSION_POLL_MS);
      list = herdr(["workspace", "list"]);
    }
    if (!list.ok) throw new Error(`Herdr session ${name} did not start`);
  }

  const existing = labelledWorkspace(list.stdout, name);
  if (existing !== null) return existing;

  const created = herdr([
    "workspace",
    "create",
    "--cwd",
    dir,
    "--label",
    name,
    "--env",
    `CTC_RUN_DIR=${dir}`,
    "--no-focus",
  ]);
  const body = created.ok
    ? (parseJson(created.stdout) as { result?: { workspace?: { workspace_id?: unknown } } } | null)
    : null;
  const id = body?.result?.workspace?.workspace_id;
  if (typeof id !== "string" || id === "") throw new Error(`could not create Herdr workspace ${name} in session ${name}`);
  return id;
}

/** `agent get`'s `.result.agent.agent_status`; a non-zero exit means the agent is gone. */
export function ownerState(herdr: Herdr, phase: number): OwnerState {
  const result = herdr(["agent", "get", `owner-p${phase}`]);
  if (!result.ok) return "gone";
  const status = (parseJson(result.stdout) as { result?: { agent?: { agent_status?: unknown } } } | null)?.result
    ?.agent?.agent_status;
  return typeof status === "string" && (OWNER_STATES as readonly string[]).includes(status)
    ? (status as OwnerState)
    : "unknown";
}

/** Start a pane off the workspace's first pane, always carrying CTC_RUN_DIR. */
function splitPane(herdr: Herdr, workspace: string, dir: string): string | null {
  const panes = herdr(["pane", "list", "--workspace", workspace]);
  const anchor = panes.ok ? paneId(panes.stdout, "panes") : null;
  if (anchor === null) return null;
  const split = herdr([
    "pane",
    "split",
    "--pane",
    anchor,
    "--direction",
    "right",
    "--cwd",
    dir,
    "--env",
    `CTC_RUN_DIR=${dir}`,
    "--no-focus",
  ]);
  return split.ok ? paneId(split.stdout, "pane") : null;
}

/** Close a pane that was split but could not be used; a failed close is ignored. */
function closePane(herdr: Herdr, pane: string): void {
  try {
    herdr(["pane", "close", pane]);
  } catch {
    /* the pane is already gone */
  }
}

function kickOff(runDir: string, phase: number): string {
  return `You own phase ${phase} of the run in ${runDir}. Follow phase-owner and your phase skill. Start now.`;
}

/**
 * Start the phase's owner, or refuse when one is alive. The `agent get` guard
 * comes before any pane is split or agent started (Plan Review Focus 2), so a
 * duplicate start leaves the session untouched: an owner that is not `gone`
 * means `already-running`. Only an existing session workspace is used
 * (`findWorkspace`): the supervisor runs inside the session that init/resume
 * started and must never bring a server up itself, so a missing workspace is
 * `failed` at once. A failure after the pane split closes that pane, so the
 * next tick does not split another one beside a discarded one.
 */
export function startOwner(
  runDir: string,
  phase: number,
  cfg: RunConfig,
  herdr: Herdr,
): "started" | "already-running" | "failed" {
  const dir = path.resolve(runDir);
  if (ownerState(herdr, phase) !== "gone") return "already-running";

  const skill = cfg.phases[String(phase)];
  if (typeof skill !== "string" || skill === "") return "failed";

  const workspace = findWorkspace(dir, herdr);
  if (workspace === null) return "failed";

  const pane = splitPane(herdr, workspace, dir);
  if (pane === null) return "failed";

  try {
    if (!herdr(["pane", "run", pane, `export CTC_PHASE=${phase}`]).ok) {
      closePane(herdr, pane);
      return "failed";
    }

    const started = herdr([
      "agent",
      "start",
      `owner-p${phase}`,
      "--kind",
      "pi",
      "--pane",
      pane,
      "--",
      "--model",
      cfg.model,
      "--extension",
      path.join(HARNESS_ROOT, "harness", "owner-extension.ts"),
      "--skill",
      path.join(HARNESS_ROOT, "harness", "skills", "phase-owner"),
      "--skill",
      path.join(HARNESS_ROOT, skill),
    ]);
    if (!started.ok) {
      closePane(herdr, pane);
      return "failed";
    }

    if (!herdr(["agent", "prompt", `owner-p${phase}`, kickOff(dir, phase)]).ok) {
      closePane(herdr, pane);
      return "failed";
    }
    return "started";
  } catch {
    closePane(herdr, pane);
    return "failed";
  }
}

/** Nudge an idle owner with decide()'s message; no `--wait`. */
export function nudgeOwner(herdr: Herdr, phase: number, message: string): boolean {
  try {
    return herdr(["agent", "prompt", `owner-p${phase}`, message]).ok;
  } catch {
    return false;
  }
}

function readArgv(cmdline: string): string[] | null {
  try {
    const argv = fs.readFileSync(cmdline, "utf8").split("\0");
    if (argv.length > 0 && argv[argv.length - 1] === "") argv.pop();
    return argv;
  } catch {
    return null; // the process exited, or /proc does not let us read it
  }
}

/**
 * The pid of the supervisor watching this exact run, or null. run.sh compared
 * the literal suffix `supervise.ts <abs runDir>`; here the last two argv
 * elements must be the supervise.ts path and the absolute run dir, so a
 * supervisor for …/runs/sup2 never hides the one for …/runs/sup.
 */
export function supervisorPid(runDir: string): number | null {
  const dir = path.resolve(runDir);
  const supervise = path.join(HARNESS_ROOT, "harness", "supervise.ts");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync("/proc", { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.name)) continue;
    const argv = readArgv(path.join("/proc", entry.name, "cmdline"));
    if (argv === null || argv.length < 2) continue;
    if (argv[argv.length - 1] === dir && argv[argv.length - 2] === supervise) return Number(entry.name);
  }
  return null;
}

/** Single-quote one argv element for the pane's shell, escaping embedded quotes. */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Start the run's supervisor in its own pane, unless one already watches this
 * run. The pane command ends with the absolute run dir, which is what
 * supervisorPid() matches.
 */
export function startSupervisor(runDir: string, herdr: Herdr): "started" | "already-running" {
  const dir = path.resolve(runDir);
  if (supervisorPid(dir) !== null) return "already-running";

  const workspace = findWorkspace(dir, herdr);
  if (workspace === null) {
    throw new Error(`no Herdr workspace ${sessionName(dir)}; start the session with init or resume first`);
  }
  const pane = splitPane(herdr, workspace, dir);
  if (pane === null) throw new Error(`could not split a pane for the supervisor in Herdr workspace ${workspace}`);

  const command = `${shellQuote("node")} ${shellQuote(path.join(HARNESS_ROOT, "harness", "supervise.ts"))} ${shellQuote(dir)}`;
  if (!herdr(["pane", "run", pane, command]).ok) {
    closePane(herdr, pane);
    throw new Error(`could not run the supervisor in Herdr pane ${pane}`);
  }
  return "started";
}

/**
 * The run's config.json: `{model, phases}` with a model and a relative skill
 * path per phase. A missing or invalid file throws a clear error, so a caller
 * can log it and skip a tick rather than start an owner with no skill.
 */
export function readConfig(runDir: string): RunConfig {
  const file = path.join(path.resolve(runDir), "config.json");

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`${file}: no config.json in this run`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${file}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file}: expected a JSON object`);
  }

  const { model, phases } = parsed as { model?: unknown; phases?: unknown };
  if (typeof model !== "string" || model === "") throw new Error(`${file}: missing "model" (a string)`);
  if (phases === null || typeof phases !== "object" || Array.isArray(phases)) {
    throw new Error(`${file}: missing "phases" (an object of phase number to skill path)`);
  }

  const skills: Record<string, string> = {};
  for (const [phase, skill] of Object.entries(phases as Record<string, unknown>)) {
    if (!PHASE_KEY.test(phase)) {
      throw new Error(`${file}: phase key "${phase}" must be a whole number like "1"`);
    }
    if (typeof skill !== "string" || skill === "") throw new Error(`${file}: phase ${phase} needs a skill path (a string)`);
    skills[phase] = skill;
  }
  return { model, phases: skills };
}
