// launch.ts: the Herdr session, owner and supervisor plumbing, tested with a
// fake Herdr that records every call and answers from a script. Nothing here
// talks to the real herdr CLI; the supervisorPid test uses a dummy `node -e`
// process that only stands in for the supervisor's command line.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  HARNESS_ROOT,
  ensureSession,
  nudgeOwner,
  ownerState,
  readConfig,
  sessionName,
  startOwner,
  startSupervisor,
  supervisorPid,
  type Herdr,
  type RunConfig,
} from "../launch.ts";

type Answer = { ok: boolean; stdout: string };

function ok(stdout: string): Answer {
  return { ok: true, stdout };
}

function fail(stdout = ""): Answer {
  return { ok: false, stdout };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

interface FakeHerdr {
  herdr: Herdr;
  calls: string[][];
}

function fakeHerdr(answer: (args: string[]) => Answer): FakeHerdr {
  const calls: string[][] = [];
  return {
    calls,
    herdr: (args) => {
      calls.push(args);
      return answer(args);
    },
  };
}

const RUN_DIR = path.resolve(tmpdir(), "ctc-launch-run");
const SESSION = `ctc-${path.basename(RUN_DIR)}`;
const CONFIG: RunConfig = { model: "test/model-a", phases: { "1": "harness/skills/demo-phase1" } };

const SUPERVISE = path.join(HARNESS_ROOT, "harness", "supervise.ts");
const OWNER_EXTENSION = path.join(HARNESS_ROOT, "harness", "owner-extension.ts");
const PHASE_OWNER_SKILL = path.join(HARNESS_ROOT, "harness", "skills", "phase-owner");
const PHASE1_SKILL = path.join(HARNESS_ROOT, "harness", "skills", "demo-phase1");

test("sessionName is ctc- plus the run directory basename", () => {
  assert.equal(sessionName("/tmp/x/runs/demo"), "ctc-demo");
});

test("ownerState reads agent_status; a failing agent get is gone", () => {
  for (const status of ["idle", "working", "blocked", "done"] as const) {
    const { herdr } = fakeHerdr(() => ok(json({ result: { agent: { agent_status: status } } })));
    assert.equal(ownerState(herdr, 1), status);
  }
  const weird = fakeHerdr(() => ok(json({ result: { agent: { agent_status: "sleeping" } } })));
  assert.equal(ownerState(weird.herdr, 1), "unknown");
  const missing = fakeHerdr(() => fail());
  assert.equal(ownerState(missing.herdr, 1), "gone");
});

test("startOwner refuses a live owner before touching any pane", () => {
  for (const status of ["idle", "working", "blocked", "done"]) {
    const { herdr, calls } = fakeHerdr((args) => {
      if (args.join(" ") === "agent get owner-p1") return ok(json({ result: { agent: { agent_status: status } } }));
      throw new Error(`unexpected herdr call: ${args.join(" ")}`);
    });
    assert.equal(startOwner(RUN_DIR, 1, CONFIG, herdr), "already-running", status);
    assert.deepEqual(calls, [["agent", "get", "owner-p1"]], `no pane split and no agent start for ${status}`);
  }
});

test("startOwner starts a gone owner: split, export CTC_PHASE, agent start, prompt", () => {
  const { herdr, calls } = fakeHerdr((args) => {
    const cmd = args.join(" ");
    if (cmd === "agent get owner-p1") return fail();
    if (cmd === "workspace list") return ok(json({ result: { workspaces: [{ label: SESSION, workspace_id: "w1" }] } }));
    if (cmd === "pane list --workspace w1") return ok(json({ result: { panes: [{ pane_id: "w1:p1" }] } }));
    if (args[0] === "pane" && args[1] === "split") return ok(json({ result: { pane: { pane_id: "w1:p2" } } }));
    if (cmd === "pane run w1:p2 export CTC_PHASE=1") return ok(json({ result: { type: "ok" } }));
    if (args[0] === "agent" && args[1] === "start") return ok(json({ result: { agent: { agent_status: "idle" } } }));
    if (args[0] === "agent" && args[1] === "prompt") return ok(json({ result: { type: "ok" } }));
    throw new Error(`unexpected herdr call: ${cmd}`);
  });

  assert.equal(startOwner(RUN_DIR, 1, CONFIG, herdr), "started");
  assert.deepEqual(calls, [
    ["agent", "get", "owner-p1"],
    ["workspace", "list"],
    ["pane", "list", "--workspace", "w1"],
    [
      "pane",
      "split",
      "--pane",
      "w1:p1",
      "--direction",
      "right",
      "--cwd",
      RUN_DIR,
      "--env",
      `CTC_RUN_DIR=${RUN_DIR}`,
      "--no-focus",
    ],
    ["pane", "run", "w1:p2", "export CTC_PHASE=1"],
    [
      "agent",
      "start",
      "owner-p1",
      "--kind",
      "pi",
      "--pane",
      "w1:p2",
      "--",
      "--model",
      CONFIG.model,
      "--extension",
      OWNER_EXTENSION,
      "--skill",
      PHASE_OWNER_SKILL,
      "--skill",
      PHASE1_SKILL,
    ],
    ["agent", "prompt", "owner-p1", `You own phase 1 of the run in ${RUN_DIR}. Follow phase-owner and your phase skill. Start now.`],
  ]);
});

test("startOwner reports failed when agent start fails and sends no prompt", () => {
  const { herdr, calls } = fakeHerdr((args) => {
    const cmd = args.join(" ");
    if (cmd === "agent get owner-p1") return fail();
    if (cmd === "workspace list") return ok(json({ result: { workspaces: [{ label: SESSION, workspace_id: "w1" }] } }));
    if (cmd === "pane list --workspace w1") return ok(json({ result: { panes: [{ pane_id: "w1:p1" }] } }));
    if (args[0] === "pane" && args[1] === "split") return ok(json({ result: { pane: { pane_id: "w1:p2" } } }));
    if (args[0] === "pane" && args[1] === "run") return ok(json({ result: { type: "ok" } }));
    if (args[0] === "agent" && args[1] === "start") return fail("pi: model not found");
    if (args[0] === "agent" && args[1] === "prompt") throw new Error("a failed start must not prompt the owner");
    throw new Error(`unexpected herdr call: ${cmd}`);
  });

  assert.equal(startOwner(RUN_DIR, 1, CONFIG, herdr), "failed");
  assert.deepEqual(calls.at(-1)?.slice(0, 2), ["agent", "start"], "the failed start is the last call");
});

test("nudgeOwner prompts the owner and reports success or failure", () => {
  const sent = fakeHerdr(() => ok(json({ result: { type: "ok" } })));
  assert.equal(nudgeOwner(sent.herdr, 2, "Continue phase 2: ready T01."), true);
  assert.deepEqual(sent.calls, [["agent", "prompt", "owner-p2", "Continue phase 2: ready T01."]]);

  const gone = fakeHerdr(() => fail("no agent"));
  assert.equal(nudgeOwner(gone.herdr, 2, "x"), false);
});

test("ensureSession creates the label's workspace when none exists", () => {
  const { herdr, calls } = fakeHerdr((args) => {
    if (args.join(" ") === "workspace list") {
      return ok(json({ result: { workspaces: [{ label: "other", workspace_id: "w9" }] } }));
    }
    if (args[0] === "workspace" && args[1] === "create") {
      return ok(json({ result: { workspace: { workspace_id: "w1" } } }));
    }
    throw new Error(`unexpected herdr call: ${args.join(" ")}`);
  });

  let started = false;
  assert.equal(ensureSession(RUN_DIR, herdr, () => {
    started = true;
  }), "w1");
  assert.equal(started, false, "a working session is not started again");
  assert.deepEqual(calls, [
    ["workspace", "list"],
    ["workspace", "create", "--cwd", RUN_DIR, "--label", SESSION, "--env", `CTC_RUN_DIR=${RUN_DIR}`, "--no-focus"],
  ]);
});

test("ensureSession reuses the workspace carrying the label", () => {
  const { herdr, calls } = fakeHerdr((args) => {
    if (args.join(" ") === "workspace list") {
      return ok(json({ result: { workspaces: [{ label: SESSION, workspace_id: "w7" }] } }));
    }
    throw new Error(`unexpected herdr call: ${args.join(" ")}`);
  });

  assert.equal(ensureSession(RUN_DIR, herdr), "w7");
  assert.deepEqual(calls, [["workspace", "list"]]);
});

test("ensureSession starts the server only when workspace list fails at first", () => {
  let lists = 0;
  const { herdr, calls } = fakeHerdr((args) => {
    if (args.join(" ") === "workspace list") {
      lists += 1;
      return lists === 1
        ? fail("server_not_running")
        : ok(json({ result: { workspaces: [{ label: SESSION, workspace_id: "w3" }] } }));
    }
    throw new Error(`unexpected herdr call: ${args.join(" ")}`);
  });

  let starts = 0;
  assert.equal(ensureSession(RUN_DIR, herdr, () => {
    starts += 1;
  }), "w3");
  assert.equal(starts, 1, "the server is started once");
  assert.deepEqual(calls, [["workspace", "list"], ["workspace", "list"]], "polled until the session answered");
});

test("supervisorPid matches the exact run dir as the last argument; startSupervisor reuses it", async (t) => {
  const runDir = "/tmp/x/runs/sup";
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", SUPERVISE, runDir], { stdio: "ignore" });
  t.after(() => killChild(child));
  await waitFor(() => supervisorPid(runDir) === child.pid, 3000);

  assert.equal(supervisorPid(runDir), child.pid);
  assert.equal(supervisorPid("/tmp/x/runs/su"), null, "a prefix is not the run dir");
  assert.equal(supervisorPid("/tmp/x/runs/sup2"), null, "a longer path is not the run dir");

  const { herdr, calls } = fakeHerdr(() => {
    throw new Error("startSupervisor must not touch Herdr when a supervisor is already running");
  });
  assert.equal(startSupervisor(runDir, herdr), "already-running");
  assert.deepEqual(calls, []);
});

test("startSupervisor splits a pane and runs the quoted supervisor command", () => {
  const runDir = path.resolve(tmpdir(), "ctc-launch-supervisor");
  const { herdr, calls } = fakeHerdr((args) => {
    const cmd = args.join(" ");
    if (cmd === "workspace list") {
      return ok(json({ result: { workspaces: [{ label: `ctc-${path.basename(runDir)}`, workspace_id: "w1" }] } }));
    }
    if (cmd === "pane list --workspace w1") return ok(json({ result: { panes: [{ pane_id: "w1:p1" }] } }));
    if (args[0] === "pane" && args[1] === "split") return ok(json({ result: { pane: { pane_id: "w1:p4" } } }));
    if (args[0] === "pane" && args[1] === "run") return ok(json({ result: { type: "ok" } }));
    throw new Error(`unexpected herdr call: ${cmd}`);
  });

  assert.equal(startSupervisor(runDir, herdr), "started");
  assert.deepEqual(calls, [
    ["workspace", "list"],
    ["pane", "list", "--workspace", "w1"],
    [
      "pane",
      "split",
      "--pane",
      "w1:p1",
      "--direction",
      "right",
      "--cwd",
      runDir,
      "--env",
      `CTC_RUN_DIR=${runDir}`,
      "--no-focus",
    ],
    ["pane", "run", "w1:p4", `'node' '${SUPERVISE}' '${runDir}'`],
  ]);
});

test("readConfig reads the model and the phases", (t) => {
  const dir = configDir(t);
  const cfg = { model: "m1", phases: { "1": "harness/skills/demo-phase1" } };
  writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg));
  assert.deepEqual(readConfig(dir), cfg);
});

test("readConfig throws a clear error for a missing file", (t) => {
  const dir = configDir(t);
  assert.throws(() => readConfig(dir), /config\.json/);
});

test("readConfig throws a clear error when model is missing", (t) => {
  const dir = configDir(t);
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ phases: {} }));
  assert.throws(() => readConfig(dir), /model/);
});

test("readConfig throws a clear error for invalid JSON", (t) => {
  const dir = configDir(t);
  writeFileSync(path.join(dir, "config.json"), "{not json");
  assert.throws(() => readConfig(dir), /config\.json/);
});

function configDir(t: TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ctc-launch-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

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
