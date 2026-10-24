// factory.ts: init, status, stop and resume of a research-factory run, tested
// with a fake Herdr that records every call and answers from a script. No real
// herdr session is ever touched. `stop`'s order is recorded in a file shared
// with a dummy supervisor process: the dummy appends `supervisor-exit` from its
// SIGTERM handler, and the fake Herdr appends `server stop` / `session delete`.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  DEFAULT_CONFIG as SHIPPED_CONFIG,
  init,
  latestRun,
  parseCommand,
  resume,
  runCommand,
  status,
  stop,
  type FactoryDeps,
} from "../factory.ts";
import { HARNESS_ROOT, sessionServerStarter, supervisorPid, type Herdr } from "../launch.ts";
import { createChild, initRun, updateNode } from "../tree.ts";

type Answer = { ok: boolean; stdout: string };

function ok(stdout = "{}"): Answer {
  return { ok: true, stdout };
}

function fail(): Answer {
  return { ok: false, stdout: "" };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

interface FakeOptions {
  /** When true, `workspace list` fails until the server has been started. */
  serverDown?: boolean;
  /** When false, deps.startServer stays undefined (the real default spawn path). */
  injectStartServer?: boolean;
}

interface FakeDeps extends FactoryDeps {
  calls: Array<{ session: string; args: string[] }>;
  rootCalls: string[][];
  /** The sessions passed to the injected startServer, in order. */
  startCalls: string[];
  /** Make `workspace list` answer: the fake server coming up. */
  bringUp(): void;
}

/**
 * A generic Herdr: one workspace created on demand and reused by label, a
 * single pane split off w1:p1, owners all gone, server stop ok, session delete
 * ok. `states` maps `owner-pN` to an agent_status for `agent get`. With
 * `serverDown` the first `workspace list` fails until the server is started
 * (by the injected `startServer`, or by bringUp() from a spy on the real one).
 */
function fakeDeps(states: Record<string, string> = {}, options: FakeOptions = {}): FakeDeps {
  const calls: FakeDeps["calls"] = [];
  const rootCalls: string[][] = [];
  const startCalls: string[] = [];
  let workspace: string | null = null;
  let serverUp = options.serverDown !== true;
  const deps: FakeDeps = {
    calls,
    rootCalls,
    startCalls,
    bringUp: () => {
      serverUp = true;
    },
    herdr: (session) => (args) => {
      calls.push({ session, args });
      const cmd = args.join(" ");
      if (cmd === "workspace list") {
        if (!serverUp) return fail();
        return workspace === null
          ? ok(json({ result: { workspaces: [] } }))
          : ok(json({ result: { workspaces: [{ label: session, workspace_id: workspace }] } }));
      }
      if (args[0] === "workspace" && args[1] === "create") {
        workspace = "w1";
        return ok(json({ result: { workspace: { workspace_id: "w1" } } }));
      }
      if (cmd === "pane list --workspace w1") return ok(json({ result: { panes: [{ pane_id: "w1:p1" }] } }));
      if (args[0] === "pane" && args[1] === "split") return ok(json({ result: { pane: { pane_id: "w1:p2" } } }));
      if (args[0] === "pane" && args[1] === "run") return ok(json({ result: { type: "ok" } }));
      if (args[0] === "agent" && args[1] === "get") {
        const status = states[args[2]];
        return status === undefined ? fail() : ok(json({ result: { agent: { agent_status: status } } }));
      }
      if (args[0] === "server" && args[1] === "stop") return ok(json({ result: { type: "ok" } }));
      throw new Error(`unexpected herdr call: ${cmd}`);
    },
    rootHerdr: (args) => {
      rootCalls.push(args);
      return ok(json({ deleted: true }));
    },
  };
  if (options.serverDown === true && options.injectStartServer !== false) {
    deps.startServer = (session) => {
      startCalls.push(session);
      serverUp = true;
    };
  }
  return deps;
}

/**
 * Replace the default detached server start (`sessionServerStarter.start`) with
 * a spy; `onStart` lets a test fake the server coming up. The spy records the
 * session a caller would have started.
 */
function spyServerStart(onStart?: (session: string) => void): { calls: string[]; restore: () => void } {
  const original = sessionServerStarter.start;
  const calls: string[] = [];
  sessionServerStarter.start = (session: string) => {
    calls.push(session);
    onStart?.(session);
  };
  return {
    calls,
    restore: () => {
      sessionServerStarter.start = original;
    },
  };
}

const SUPERVISE = path.join(HARNESS_ROOT, "harness", "supervise.ts");
const DATASET = path.join(HARNESS_ROOT, "harness", "test", "fixtures", "mini-dataset");
const DEFAULT_CONFIG = {
  model: "claude-bridge/claude-haiku-5-5",
  phases: {
    "0": "harness/skills/phase-0",
    "1": "harness/skills/phase-1",
    "2": "harness/skills/phase-2",
    "3": "harness/skills/phase-3",
  },
};

function workDir(t: TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ctc-factory-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeRun(dir: string): string {
  const runDir = path.join(dir, "runs", "fac");
  mkdirSync(runDir, { recursive: true });
  initRun(runDir, DATASET, "test interest");
  return runDir;
}

test("the shipped default model is the claude-bridge haiku model", () => {
  assert.equal(SHIPPED_CONFIG.model, "claude-bridge/claude-haiku-5-5");
});

test("parseCommand splits shell-like quoting and rejects unknown subcommands", () => {
  assert.deepEqual(parseCommand('init data "work on platforms" runs/x'), {
    sub: "init",
    args: ["data", "work on platforms", "runs/x"],
  });
  assert.deepEqual(parseCommand("status runs/x"), { sub: "status", args: ["runs/x"] });
  assert.deepEqual(parseCommand("'init' data 'work on platforms'"), {
    sub: "init",
    args: ["data", "work on platforms"],
  });

  const unknown = parseCommand("nope");
  assert.ok("error" in unknown, "an unknown subcommand is an error");
  for (const sub of ["init", "status", "stop", "resume"]) {
    assert.match(unknown.error, new RegExp(sub), `the error names ${sub}`);
  }
  assert.ok("error" in parseCommand(""), "an empty command is an error");
  assert.ok("error" in parseCommand('init "unbalanced'), "an unterminated quote is an error");
});

test("init creates the run, writes the default config and starts the supervisor", (t) => {
  const dir = workDir(t);
  const runDir = path.join(dir, "runs", "fac");
  const deps = fakeDeps();

  const text = init({ dataset: DATASET, interest: "work on platforms", runDir }, deps);

  assert.ok(text.includes(runDir), "the text names the run dir");
  assert.ok(text.includes("supervisor started"), text);
  assert.ok(text.includes("attach: herdr session attach ctc-fac"), text);
  assert.deepEqual(JSON.parse(readFileSync(path.join(runDir, "config.json"), "utf8")), DEFAULT_CONFIG);

  const creates = deps.calls.filter(({ args }) => args[0] === "workspace" && args[1] === "create");
  assert.equal(creates.length >= 1, true, "workspace create was recorded");
  assert.ok(creates[0].args.includes("--label"), "the workspace carries the session label");

  const supervisorRun = deps.calls.find(({ args }) => args[0] === "pane" && args[1] === "run");
  assert.ok(supervisorRun, "a supervisor pane run was recorded");
  const command = supervisorRun.args[3];
  assert.ok(command.includes("supervise.ts"), command);
  assert.ok(command.includes(path.resolve(runDir)), command);
  assert.ok(command.endsWith(`'${path.resolve(runDir)}'`), command);
});

test("init defaults the run dir to runs/<dataset basename>-<YYYYMMDD-HHMM>", (t) => {
  const dir = workDir(t);
  const runsDir = path.join(dir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const deps: FactoryDeps = { ...fakeDeps(), runsDir, now: () => new Date(2026, 9, 14, 12, 0) };

  const text = runCommand('init data "work on platforms"', deps);

  const runDir = path.join(runsDir, "data-20261014-1200");
  assert.ok(text.includes(runDir), text);
  assert.ok(readFileSync(path.join(runDir, "node.json"), "utf8").includes("work on platforms"));
  assert.deepEqual(JSON.parse(readFileSync(path.join(runDir, "config.json"), "utf8")), DEFAULT_CONFIG);
});

test("stop kills the supervisor before stopping the server and deleting the session", async (t) => {
  const dir = workDir(t);
  const runDir = makeRun(dir);
  const events = path.join(dir, "events.log");
  const ready = path.join(dir, "ready");
  const code =
    "const fs=require('fs');process.on('SIGTERM',()=>{fs.appendFileSync(process.argv[1],'supervisor-exit\\n');process.exit(0)});fs.writeFileSync(process.argv[2],'ready');setTimeout(()=>{},30000)";
  const child = spawn(process.execPath, ["-e", code, events, ready, SUPERVISE, runDir], { stdio: "ignore" });
  t.after(() => killChild(child));
  await waitFor(() => existsSync(ready) && supervisorPid(runDir) === child.pid, 3000);

  const session = `ctc-${path.basename(runDir)}`;
  const deps: FactoryDeps = {
    herdr: (scoped) => (args) => {
      assert.equal(scoped, session);
      assert.deepEqual(args, ["server", "stop"]);
      appendFileSync(events, "server stop\n");
      return ok();
    },
    rootHerdr: (args) => {
      assert.deepEqual(args, ["session", "delete", session]);
      appendFileSync(events, "session delete\n");
      return ok(json({ deleted: true }));
    },
  };

  const text = stop(runDir, deps);
  await once(child, "exit");

  assert.deepEqual(readFileSync(events, "utf8").trim().split("\n"), [
    "supervisor-exit",
    "server stop",
    "session delete",
  ]);
  assert.equal(child.exitCode, 0, "the dummy's SIGTERM handler ran");
  assert.equal(supervisorPid(runDir), null, "the supervisor is gone");
  assert.match(text, /supervisor/i);
  assert.match(text, /not touched/i);
});

test("stop records server stop and session delete even with no supervisor", (t) => {
  const dir = workDir(t);
  const runDir = makeRun(dir);
  const session = `ctc-${path.basename(runDir)}`;
  const seen: string[] = [];
  const deps: FactoryDeps = {
    herdr: () => (args) => {
      seen.push(`scoped ${args.join(" ")}`);
      return ok();
    },
    rootHerdr: (args) => {
      seen.push(`root ${args.join(" ")}`);
      return ok(json({ deleted: true }));
    },
  };

  const text = stop(runDir, deps);
  assert.deepEqual(seen, ["scoped server stop", `root session delete ${session}`]);
  assert.match(text, /not running/i);
});

test("init starts the session when it is down: the injected startServer runs once, then workspace and supervisor", (t) => {
  const dir = workDir(t);
  const runDir = path.join(dir, "runs", "fac");
  const deps = fakeDeps({}, { serverDown: true });

  const text = init({ dataset: DATASET, interest: "work on platforms", runDir }, deps);

  assert.deepEqual(deps.startCalls, ["ctc-fac"], "the injected startServer ran exactly once");
  assert.ok(text.includes("supervisor started"), text);
  const creates = deps.calls.filter(({ args }) => args[0] === "workspace" && args[1] === "create");
  assert.equal(creates.length, 1, "the workspace was created once the server answered");
  const supervisorRun = deps.calls.find(({ args }) => args[0] === "pane" && args[1] === "run");
  assert.ok(supervisorRun, "the supervisor pane run was recorded");
  assert.ok(supervisorRun.args[3].includes(SUPERVISE), supervisorRun.args[3]);
});

test("init uses the real detached server start when deps injects no startServer", (t) => {
  const dir = workDir(t);
  const runDir = path.join(dir, "runs", "fac");
  const deps = fakeDeps({}, { serverDown: true, injectStartServer: false });
  const spy = spyServerStart(() => deps.bringUp());
  t.after(() => spy.restore());

  const text = init({ dataset: DATASET, interest: "work on platforms", runDir }, deps);

  assert.deepEqual(spy.calls, ["ctc-fac"], "the default startServer path ran exactly once");
  assert.ok(text.includes("supervisor started"), text);
  const creates = deps.calls.filter(({ args }) => args[0] === "workspace" && args[1] === "create");
  assert.equal(creates.length, 1, "the workspace was created after the default start came up");
  const supervisorRun = deps.calls.find(({ args }) => args[0] === "pane" && args[1] === "run");
  assert.ok(supervisorRun, "the supervisor pane run was recorded");
});

test("resume starts the session server after a stop", (t) => {
  const dir = workDir(t);
  const runDir = makeRun(dir);
  const deps = fakeDeps({}, { serverDown: true });

  const text = resume(runDir, deps);

  assert.deepEqual(deps.startCalls, [`ctc-${path.basename(runDir)}`], "the injected startServer ran once");
  assert.ok(text.includes("supervisor started"), text);
  const supervisorRun = deps.calls.find(({ args }) => args[0] === "pane" && args[1] === "run");
  assert.ok(supervisorRun, "the supervisor pane run was recorded");
});

test("resume refuses while a supervisor runs and starts one when it does not", async (t) => {
  const dir = workDir(t);
  const runDir = makeRun(dir);

  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", SUPERVISE, runDir], { stdio: "ignore" });
  t.after(() => killChild(child));
  await waitFor(() => supervisorPid(runDir) === child.pid, 3000);

  const refused = fakeDeps();
  assert.throws(() => resume(runDir, refused), /already running/);
  assert.deepEqual(refused.calls, [], "refusing touches no Herdr");

  await killChild(child);
  assert.equal(supervisorPid(runDir), null);

  const deps = fakeDeps();
  const text = resume(runDir, deps);
  assert.ok(text.includes("supervisor started"), text);
  assert.ok(text.includes(`attach: herdr session attach ctc-${path.basename(runDir)}`), text);
  const supervisorRun = deps.calls.find(({ args }) => args[0] === "pane" && args[1] === "run");
  assert.ok(supervisorRun, "a supervisor pane run was recorded");
  assert.ok(supervisorRun.args[3].includes(SUPERVISE), supervisorRun.args[3]);
});

test("status reports the supervisor, the phases and the last commits", (t) => {
  const dir = workDir(t);
  const runDir = makeRun(dir);
  writeFileSync(path.join(runDir, "config.json"), json(DEFAULT_CONFIG));
  const deps = fakeDeps({ "owner-p0": "idle" });

  const text = status(runDir, deps);

  assert.match(text, /supervisor: not running/);
  assert.match(text, /P0 owner idle/);
  assert.match(text, /\[P0:init\]/);
  assert.match(text, /ctc/);
});

test("status reports phase-0 prep nodes even when config does not configure phase 0", (t) => {
  const dir = workDir(t);
  const runDir = makeRun(dir);
  writeFileSync(
    path.join(runDir, "config.json"),
    json({ model: DEFAULT_CONFIG.model, phases: {} }),
  );
  createChild(runDir, "D01", "Profile", "test", [], "prep");
  const deps = fakeDeps();

  const text = status(runDir, deps);

  assert.match(
    text,
    /P0 owner not started; not configured; 1 ready/,
    "a phase-0 prep node is reported even though only the root and the node carry phase 0",
  );
});

test("status counts input nodes among a phase's statuses", (t) => {
  const dir = workDir(t);
  const runDir = makeRun(dir);
  // Phase 1 must be configured for its line to carry only the counts.
  writeFileSync(
    path.join(runDir, "config.json"),
    json({ ...DEFAULT_CONFIG, phases: { ...DEFAULT_CONFIG.phases, "1": "harness/skills/phase-1" } }),
  );
  createChild(runDir, "D01", "Assemble", "test", [], "prep");
  updateNode(runDir, "Z01", { phase: 1, status: "input" }, "test");

  assert.match(status(runDir, fakeDeps()), /P1 owner not started; 1 input/, "the input node is counted");
});

test("latestRun picks the most recently modified run dir with node.json", (t) => {
  const dir = workDir(t);
  const runsDir = path.join(dir, "runs");
  mkdirSync(runsDir, { recursive: true });
  for (const name of ["a", "b", "c"]) mkdirSync(path.join(runsDir, name), { recursive: true });
  writeFileSync(path.join(runsDir, "a", "node.json"), "{}");
  writeFileSync(path.join(runsDir, "b", "node.json"), "{}");
  utimesSync(path.join(runsDir, "a"), 1000, 1000);
  utimesSync(path.join(runsDir, "b"), 2000, 2000);
  utimesSync(path.join(runsDir, "c"), 3000, 3000); // newest, but not a run

  assert.equal(latestRun(runsDir), path.join(runsDir, "b"));
  assert.equal(latestRun(path.join(dir, "missing")), null);
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the dummy process");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await once(child, "exit");
}
