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
  findWorkspace,
  kickOff,
  nudgeOwner,
  ownerState,
  readConfig,
  sessionName,
  sessionServerStarter,
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

/**
 * Replace the default detached server start (`sessionServerStarter.start`) with
 * a spy. Tests use this to prove that `startOwner` / `startSupervisor` never
 * bring a session up: the spy records the session a buggy caller would start
 * and does nothing else.
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
    ["agent", "prompt", "owner-p1", `You own phase 1 of the run in ${RUN_DIR}. Follow phase-owner and your phase skill. Start now. Worker model: test/model-a. Pass it as model: "test/model-a" on every subagent call you make (workers and reviewers). Judge model: test/model-a.`],
  ]);
});

test("kickOff names the worker model and the judge model, which defaults to the worker model", () => {
  const plain = kickOff(RUN_DIR, 1, { model: "m1", phases: {} });
  assert.ok(plain.includes("Worker model: m1."), plain);
  assert.ok(plain.includes('Pass it as model: "m1"'), plain);
  assert.ok(plain.includes("Judge model: m1."), plain);

  const judged = kickOff(RUN_DIR, 1, { model: "m1", judgeModel: "j", phases: {} });
  assert.ok(judged.includes("Worker model: m1."), judged);
  assert.ok(judged.includes("Judge model: j."), judged);
});

test("findWorkspace reads only the labelled workspace and never starts a server", () => {
  const { herdr, calls } = fakeHerdr((args) => {
    if (args.join(" ") === "workspace list") {
      return ok(
        json({
          result: {
            workspaces: [
              { label: "other", workspace_id: "w9" },
              { label: SESSION, workspace_id: "w7" },
            ],
          },
        }),
      );
    }
    throw new Error(`unexpected herdr call: ${args.join(" ")}`);
  });
  assert.equal(findWorkspace(RUN_DIR, herdr), "w7");
  assert.deepEqual(calls, [["workspace", "list"]], "one list, nothing else");

  const down = fakeHerdr(() => fail("server_not_running"));
  assert.equal(findWorkspace(RUN_DIR, down.herdr), null, "a server that does not answer is null");
  assert.deepEqual(down.calls, [["workspace", "list"]]);

  const unlabelled = fakeHerdr(() => ok(json({ result: { workspaces: [{ label: "other", workspace_id: "w9" }] } })));
  assert.equal(findWorkspace(RUN_DIR, unlabelled.herdr), null, "a server without the label is null");
});

test("startOwner fails fast when no session answers and never starts a server", () => {
  const { herdr, calls } = fakeHerdr((args) => {
    const cmd = args.join(" ");
    if (cmd === "agent get owner-p1") return fail();
    if (cmd === "workspace list") return fail("server_not_running");
    throw new Error(`unexpected herdr call: ${cmd}`);
  });

  const spy = spyServerStart();
  const before = Date.now();
  let result: string;
  try {
    result = startOwner(RUN_DIR, 1, CONFIG, herdr);
  } finally {
    spy.restore();
  }
  const elapsed = Date.now() - before;

  assert.equal(result, "failed");
  assert.ok(elapsed < 5000, `no 20 s session poll (took ${elapsed} ms)`);
  assert.deepEqual(spy.calls, [], "startOwner never starts a session server");
  assert.deepEqual(calls, [["agent", "get", "owner-p1"], ["workspace", "list"]], "no pane split and no agent start");
});

test("startOwner reports failed when agent start fails, sends no prompt and closes the pane", () => {
  const { herdr, calls } = fakeHerdr((args) => {
    const cmd = args.join(" ");
    if (cmd === "agent get owner-p1") return fail();
    if (cmd === "workspace list") return ok(json({ result: { workspaces: [{ label: SESSION, workspace_id: "w1" }] } }));
    if (cmd === "pane list --workspace w1") return ok(json({ result: { panes: [{ pane_id: "w1:p1" }] } }));
    if (args[0] === "pane" && args[1] === "split") return ok(json({ result: { pane: { pane_id: "w1:p2" } } }));
    if (args[0] === "pane" && args[1] === "run") return ok(json({ result: { type: "ok" } }));
    if (args[0] === "agent" && args[1] === "start") return fail("pi: model not found");
    if (args[0] === "pane" && args[1] === "close") return ok(json({ result: { type: "ok" } }));
    if (args[0] === "agent" && args[1] === "prompt") throw new Error("a failed start must not prompt the owner");
    throw new Error(`unexpected herdr call: ${cmd}`);
  });

  assert.equal(startOwner(RUN_DIR, 1, CONFIG, herdr), "failed");
  assert.ok(
    !calls.some((args) => args[0] === "agent" && args[1] === "prompt"),
    "the failed start must not prompt the owner",
  );
  assert.deepEqual(calls.at(-1), ["pane", "close", "w1:p2"], "the split pane is closed again");
});

test("startOwner closes the split pane when the pane run fails", () => {
  const { herdr, calls } = fakeHerdr((args) => {
    const cmd = args.join(" ");
    if (cmd === "agent get owner-p1") return fail();
    if (cmd === "workspace list") return ok(json({ result: { workspaces: [{ label: SESSION, workspace_id: "w1" }] } }));
    if (cmd === "pane list --workspace w1") return ok(json({ result: { panes: [{ pane_id: "w1:p1" }] } }));
    if (args[0] === "pane" && args[1] === "split") return ok(json({ result: { pane: { pane_id: "w1:p2" } } }));
    if (args[0] === "pane" && args[1] === "run") return fail("no such pane");
    if (args[0] === "pane" && args[1] === "close") return ok(json({ result: { type: "ok" } }));
    if (args[0] === "agent") throw new Error("a failed pane run must not touch agents");
    throw new Error(`unexpected herdr call: ${cmd}`);
  });

  assert.equal(startOwner(RUN_DIR, 1, CONFIG, herdr), "failed");
  assert.deepEqual(calls.at(-1), ["pane", "close", "w1:p2"]);
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

test("startSupervisor closes the split pane when the pane run fails", () => {
  const runDir = path.resolve(tmpdir(), "ctc-launch-supervisor-runfail");
  const { herdr, calls } = fakeHerdr((args) => {
    const cmd = args.join(" ");
    if (cmd === "workspace list") {
      return ok(json({ result: { workspaces: [{ label: `ctc-${path.basename(runDir)}`, workspace_id: "w1" }] } }));
    }
    if (cmd === "pane list --workspace w1") return ok(json({ result: { panes: [{ pane_id: "w1:p1" }] } }));
    if (args[0] === "pane" && args[1] === "split") return ok(json({ result: { pane: { pane_id: "w1:p4" } } }));
    if (args[0] === "pane" && args[1] === "run") return fail("no such pane");
    if (args[0] === "pane" && args[1] === "close") return ok(json({ result: { type: "ok" } }));
    throw new Error(`unexpected herdr call: ${cmd}`);
  });

  assert.throws(() => startSupervisor(runDir, herdr), /could not run the supervisor/);
  assert.deepEqual(calls.at(-1), ["pane", "close", "w1:p4"], "the split pane is closed again");
});

test("startSupervisor fails fast when no workspace exists and never starts a server", () => {
  const runDir = path.resolve(tmpdir(), "ctc-launch-supervisor-down");
  const { herdr, calls } = fakeHerdr(() => fail("server_not_running"));
  const spy = spyServerStart();
  try {
    assert.throws(() => startSupervisor(runDir, herdr), /workspace/);
  } finally {
    spy.restore();
  }
  assert.deepEqual(spy.calls, [], "startSupervisor never starts a session server");
  assert.deepEqual(calls, [["workspace", "list"]], "no pane split and no pane run");
});

test("readConfig rejects non-canonical phase keys and names the bad key", (t) => {
  for (const key of ["01", "one", "-1"]) {
    const dir = configDir(t);
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ model: "m1", phases: { [key]: "harness/skills/demo-phase1" } }));
    assert.throws(
      () => readConfig(dir),
      new RegExp(`config\\.json: phase key "${key}" must be a whole number like "1"`),
      `phase key ${key} is rejected and named`,
    );
  }
});

test("readConfig accepts canonical non-negative integer phase keys", (t) => {
  const dir = configDir(t);
  const phases = {
    "0": "harness/skills/demo-phase0",
    "1": "harness/skills/demo-phase1",
    "12": "harness/skills/demo-phase12",
  };
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ model: "m1", phases }));
  assert.deepEqual(readConfig(dir), { model: "m1", judgeModel: "m1", ...ANALYSIS_DEFAULTS, phases });
});

test("readConfig reads the model and the phases", (t) => {
  const dir = configDir(t);
  const cfg = { model: "m1", phases: { "1": "harness/skills/demo-phase1" } };
  writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg));
  assert.deepEqual(readConfig(dir), { ...cfg, judgeModel: "m1", ...ANALYSIS_DEFAULTS });
});

test("readConfig reads judgeModel when the run names a different judge model", (t) => {
  const dir = configDir(t);
  const cfg = { model: "worker/model", judgeModel: "judge/model", phases: { "2": "harness/skills/phase-2" } };
  writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg));
  assert.deepEqual(readConfig(dir), { ...cfg, ...ANALYSIS_DEFAULTS });
});

test("readConfig returns the analysis keys with their defaults", (t) => {
  const dir = configDir(t);
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ model: "m1", phases: {} }));
  const cfg = readConfig(dir);
  assert.equal(cfg.analysisImage, "ctc-analysis:1");
  assert.equal(cfg.analysisTimeoutMs, 1_800_000);
  assert.equal(cfg.roundCap, 6);
});

test("readConfig reads the analysis keys when the run sets them", (t) => {
  const dir = configDir(t);
  const cfg = { model: "m1", analysisImage: "ctc-analysis:2", analysisTimeoutMs: 60_000, roundCap: 3, phases: {} };
  writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg));
  assert.deepEqual(readConfig(dir), { ...cfg, judgeModel: "m1" });
});

test("readConfig rejects a non-string analysisImage, naming the key", (t) => {
  const dir = configDir(t);
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ model: "m1", analysisImage: 7, phases: {} }));
  assert.throws(() => readConfig(dir), /config\.json: "analysisImage" must be a string/);
});

test("readConfig rejects a roundCap or analysisTimeoutMs that is not a positive integer", (t) => {
  for (const [key, value] of [
    ["roundCap", 0],
    ["roundCap", 2.5],
    ["roundCap", "6"],
    ["analysisTimeoutMs", -1],
    ["analysisTimeoutMs", 1.5],
  ] as const) {
    const dir = configDir(t);
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ model: "m1", [key]: value, phases: {} }));
    assert.throws(
      () => readConfig(dir),
      new RegExp(`config\\.json: "${key}" must be a positive integer`),
      `${key}=${String(value)} is rejected and named`,
    );
  }
});

test("readConfig defaults judgeModel to model", (t) => {
  const dir = configDir(t);
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ model: "m1", phases: {} }));
  assert.equal(readConfig(dir).judgeModel, "m1");
});

test("readConfig rejects a non-string judgeModel, naming the key", (t) => {
  const dir = configDir(t);
  writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ model: "m1", judgeModel: 7, phases: {} }),
  );
  assert.throws(() => readConfig(dir), /config\.json: "judgeModel" must be a string/);
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

const ANALYSIS_DEFAULTS = { analysisImage: "ctc-analysis:1", analysisTimeoutMs: 1_800_000, roundCap: 6 };

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
