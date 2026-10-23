// The container library for analysis scripts: the one place that copies the
// exploration split into a run, builds the `docker run` argv and runs a node's
// script in the analysis image. Workers never call docker themselves (the bash
// guard refuses it); `run_analysis` calls runScript, and the mounts are the
// control: the container has no network, sees only the exploration split
// read-only, and writes only the node's output folder.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { commitFile, readRun } from "../tree.ts";

/** One container run's outcome; `timedOut` is set when the time limit killed it. */
export type Exec = (
  args: string[],
  opts: { timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>;

/** The exit status recorded for a run killed at its limit (the `timeout` command's convention). */
const TIMED_OUT_CODE = 124;
/** The exit status when docker cannot be started at all (the shell's "not found"). */
const NOT_FOUND_CODE = 127;
const MAX_BUFFER = 64 * 1024 * 1024;
/** How long `docker kill` may take on a timed-out container. */
const KILL_TIMEOUT_MS = 30_000;
const OUTPUT_DIRS = ["numbers", "tables", "figures", "logs", "assets"];
/** `B_01.R`-style task scripts and the shared `assets` script, in R or Python. */
const SCRIPT_NAME = /^(?:[A-Z]_\d\d|assets)\.(?:R|py)$/;
const INTERPRETERS = new Map([
  [".R", "Rscript"],
  [".py", "python3"],
]);
/** Scratch the run must never commit; `ignoreScratch` adds these to `.gitignore`. */
const IGNORED = ["analysis-data/", ".analysis/"];

/** The `docker run` argv for one script (everything after `docker`). */
export interface DockerOptions {
  image: string;
  /** Absolute host path of the exploration split, mounted read-only at /data. */
  exploration: string;
  /** Absolute host path of a node's workspace; only its scripts (read) and output (write) are mounted. */
  workspace: string;
  /** The script's file name, for example `B_01.R`; it runs from /work/scripts. */
  script: string;
  uid: number;
  gid: number;
  memory?: string;
}

/** The argv for one script run. Pure: nothing here touches the disk or docker. */
export function dockerArgs(o: DockerOptions): string[] {
  const interpreter = INTERPRETERS.get(path.extname(o.script));
  if (interpreter === undefined || path.basename(o.script) !== o.script) {
    throw new Error(`"${o.script}" is not an .R or .py script name`);
  }
  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--user",
    `${o.uid}:${o.gid}`,
    "-v",
    `${o.exploration}:/data:ro`,
    "-v",
    `${o.workspace}/scripts:/work/scripts:ro`,
    "-v",
    `${o.workspace}/output:/work/output`,
    "-w",
    "/work",
    "-e",
    "CTC_DATA=/data",
    "-e",
    "CTC_OUT=/work/output",
  ];
  if (o.memory !== undefined) args.push("--memory", o.memory);
  args.push(o.image, interpreter, `scripts/${o.script}`);
  return args;
}

/** One `docker` call, resolved (never rejected) with its outcome. */
function dockerCall(args: string[], timeoutMs: number): ReturnType<Exec> {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout, stderr, timedOut: false });
        return;
      }
      if (error.killed === true) {
        resolve({ code: TIMED_OUT_CODE, stdout, stderr, timedOut: true });
        return;
      }
      const code = typeof error.code === "number" ? error.code : NOT_FOUND_CODE;
      resolve({ code, stdout, stderr: stderr === "" ? error.message : stderr, timedOut: false });
    });
  });
}

/**
 * The real Exec. For a `docker run` it adds `--name ctc-<random>` and `--init`
 * after `run`, so a timed-out container can be found and killed by name: the
 * timeout only stops the docker client, and the script (PID 1) would otherwise
 * keep writing to output/. It always resolves, so a missing docker is a failed
 * run, not a throw.
 */
export const realExec: Exec = async (args, opts) => {
  const name = args[0] === "run" ? `ctc-${randomBytes(6).toString("hex")}` : undefined;
  const argv = name === undefined ? args : ["run", "--name", name, "--init", ...args.slice(1)];
  const outcome = await dockerCall(argv, opts.timeoutMs);
  if (outcome.timedOut && name !== undefined) await dockerCall(["kill", name], KILL_TIMEOUT_MS);
  return outcome;
};

/** A node's workspace folder, where its scripts, output and log live. */
export function workspaceOf(nodeDir: string): string {
  return path.join(nodeDir, "workspace");
}

/**
 * The lines of a split list, as dataset-relative paths. A path that is absolute
 * or leaves the dataset is refused. A missing list is refused by name.
 */
function readList(file: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`${file} is missing: the run has no split to analyse`);
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const rel = path.posix.normalize(line);
      if (path.posix.isAbsolute(rel) || rel === ".." || rel.startsWith("../")) {
        throw new Error(`${line}: a listed path must stay inside the dataset`);
      }
      return rel;
    });
}

/**
 * Append the ignore lines `.gitignore` lacks, and commit that file so the run's
 * status stays clean. A second call finds both lines and commits nothing.
 */
function ignoreScratch(runDir: string): void {
  const file = path.join(runDir, ".gitignore");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const present = new Set(current.split("\n").map((line) => line.trim()));
  const missing = IGNORED.filter((line) => !present.has(line));
  if (missing.length === 0) return;
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(file, `${current}${separator}${missing.join("\n")}\n`);
  commitFile(runDir, ".gitignore", "ctc", "chore: ignore analysis data in the run");
}

/** True when `child` (a real path) is strictly inside `root` (a real path). */
function isInside(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** The real path of `file`, or undefined when it does not exist. */
function realPathOrUndefined(file: string): string | undefined {
  try {
    return fs.realpathSync(file);
  } catch {
    return undefined;
  }
}

/**
 * A source file to copy, as its real path: it must exist, stay inside the real
 * dataset and be a regular file. A link can point anywhere, so the check is on
 * the resolved target, not the listed name.
 */
function resolveSource(datasetReal: string, dataset: string, rel: string): string {
  const from = realPathOrUndefined(path.join(dataset, rel));
  if (from === undefined) throw new Error(`${rel} does not exist in the dataset`);
  if (!isInside(datasetReal, from)) throw new Error(`${rel} resolves outside the dataset`);
  if (!fs.statSync(from).isFile()) throw new Error(`${rel} is not a regular file`);
  return from;
}

/**
 * Copy `from` to `to` unless `to` exists. The bytes go to a temp file beside
 * `to` that is renamed into place only once complete, so an interrupted copy
 * never leaves a partial file under the final name.
 */
function copyIntoPlace(from: string, to: string): void {
  if (fs.existsSync(to)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const partial = `${to}.tmp-${process.pid}`;
  try {
    fs.copyFileSync(from, partial);
    fs.renameSync(partial, to);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
}

/**
 * Copy the exploration split into `<runDir>/analysis-data/exploration` and
 * return that folder. Only the files the exploration list names are copied, and
 * a file already present is left as it is. It refuses a run whose split lists
 * are missing, and any listed path that is a hold-out file (by name or by the
 * file a link resolves to), that is not a regular file, or that resolves
 * outside the dataset. Every entry is checked before the first copy, so a
 * refusal copies nothing.
 */
export function prepareExploration(runDir: string): string {
  const dir = path.resolve(runDir);
  const split = path.join(dir, "prep", "Z01-profile", "workspace", "split");
  const exploration = readList(path.join(split, "exploration.txt"));
  const holdoutList = readList(path.join(split, "holdout.txt"));
  const holdout = new Set(holdoutList);
  for (const rel of exploration) {
    if (holdout.has(rel)) throw new Error(`${rel} is in the hold-out list: analyses may not read it`);
  }

  const dataset = readRun(dir).dataset;
  const datasetReal = fs.realpathSync(dataset);
  const holdoutReal = new Set(
    holdoutList
      .map((rel) => realPathOrUndefined(path.join(dataset, rel)))
      .filter((real): real is string => real !== undefined),
  );
  const sources = exploration.map((rel) => {
    const from = resolveSource(datasetReal, dataset, rel);
    if (holdoutReal.has(from)) throw new Error(`${rel} is the same file as a hold-out file: analyses may not read it`);
    return { rel, from };
  });

  const target = path.join(dir, "analysis-data", "exploration");
  for (const { rel, from } of sources) copyIntoPlace(from, path.join(target, rel));
  ignoreScratch(dir);
  return target;
}

export interface ScriptResult {
  code: number;
  /** The text written to the script's log file. */
  log: string;
  timedOut: boolean;
}

/** A text block that ends in a newline, so the next header starts on its own line. */
function block(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Throw unless `dir` is a real folder inside `nodeReal`, not a link. A worker
 * can plant a link where the harness expects a folder, and both the `-v` mounts
 * and the log write would follow it. A folder that does not exist yet is fine:
 * it is created next, and checked then.
 */
function assertRealFolder(dir: string, nodeReal: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || !isInside(nodeReal, fs.realpathSync(dir))) {
    throw new Error(`${dir} must be a real folder inside the node, not a link`);
  }
}

/**
 * Run `workspace/scripts/<script>` in the analysis container and write its log
 * to `workspace/output/logs/<stem>.txt`. The script name must be an analysis
 * name (`X_nn.R|py` or `assets.R|py`) and must exist. The scripts and output
 * folders must be real folders inside the node, checked before anything is
 * created. The output folders are then created, and the exploration split is
 * prepared before docker runs.
 */
export async function runScript(o: {
  runDir: string;
  nodeDir: string;
  script: string;
  image: string;
  timeoutMs: number;
  exec?: Exec;
}): Promise<ScriptResult> {
  if (!SCRIPT_NAME.test(o.script)) {
    throw new Error(`"${o.script}" is not an analysis script name (X_nn.R|py, or assets.R|py)`);
  }
  const node = path.resolve(o.nodeDir);
  const nodeReal = fs.realpathSync(node);
  const workspace = workspaceOf(node);
  const scripts = path.join(workspace, "scripts");
  const output = path.join(workspace, "output");
  assertRealFolder(scripts, nodeReal);
  assertRealFolder(output, nodeReal);
  const scriptFile = path.join(scripts, o.script);
  if (!fs.existsSync(scriptFile)) throw new Error(`${scriptFile} does not exist`);

  for (const dir of OUTPUT_DIRS) fs.mkdirSync(path.join(output, dir), { recursive: true });
  for (const dir of OUTPUT_DIRS) assertRealFolder(path.join(output, dir), nodeReal);
  const exploration = prepareExploration(o.runDir);

  const result = await (o.exec ?? realExec)(
    dockerArgs({
      image: o.image,
      exploration,
      workspace,
      script: o.script,
      // The container writes as the harness user, so the output stays theirs on the host.
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
    }),
    { timeoutMs: o.timeoutMs },
  );

  const header = [`script: ${o.script}`, `exit code: ${result.code}`];
  if (result.timedOut) header.push(`TIMED OUT after ${o.timeoutMs} ms`);
  const log = `${header.join("\n")}\n--- stdout ---\n${block(result.stdout)}--- stderr ---\n${block(result.stderr)}`;
  const stem = path.basename(o.script, path.extname(o.script));
  // The script could have left a link at this name: remove the link itself, then
  // create the file exclusively, so the write never follows a link.
  const logFile = path.join(output, "logs", `${stem}.txt`);
  fs.rmSync(logFile, { force: true });
  fs.writeFileSync(logFile, log, { flag: "wx" });
  return { code: result.code, log, timedOut: result.timedOut };
}
