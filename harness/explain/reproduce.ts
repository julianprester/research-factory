// The reproduction check for an explanation node's analysis workspace. The
// container re-runs every script in order into an empty scratch output, and the
// registry it writes must match the owner's: exactly for text and integers,
// within a relative tolerance for floats. The host reads `output/` after the
// analysis scripts and workers have written to it, so nothing here follows a
// link: a link, or a file that is not regular, is refused by name.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { type Exec, runScript, workspaceOf } from "../analysis/run.ts";

export interface Row {
  name: string;
  value: string;
}

/** Resumable state: the scripts that exited 0, and those that failed with the reason. */
interface ReproState {
  done: string[];
  failed: Record<string, string>;
}

interface Entry {
  /** The path the hash and the copy use, relative to the workspace (`scripts/A_01.R`). */
  rel: string;
  /** The file on disk. */
  file: string;
}

/** The analysis script names runScript accepts: `X_nn.R|py` or `assets.R|py`. */
const ANALYSIS_SCRIPT = /^(?:[A-Z]_\d\d|assets)\.(?:R|py)$/;
const INTEGER = /^[+-]?\d+$/;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/**
 * The lines where two registries differ, keyed by file name. A file or a name on
 * one side only is a line; so is a value that differs. Text and integers must be
 * equal; a value that parses as a number compares with relative tolerance `tol`.
 * `a` is the owner's registry and `b` the reproduced one in the messages.
 */
export function compareRegistries(a: Record<string, Row[]>, b: Record<string, Row[]>, tol = 1e-6): string[] {
  const mismatches: string[] = [];
  const files = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(compareText);
  for (const file of files) {
    if (!Object.hasOwn(a, file)) {
      mismatches.push(`${file}: only in the second registry`);
    } else if (!Object.hasOwn(b, file)) {
      mismatches.push(`${file}: only in the first registry`);
    } else {
      mismatches.push(...compareRows(file, a[file] ?? [], b[file] ?? [], tol));
    }
  }
  return mismatches;
}

function compareRows(file: string, first: Row[], second: Row[], tol: number): string[] {
  const mismatches: string[] = [];
  const left = indexRows(file, "first", first, mismatches);
  const right = indexRows(file, "second", second, mismatches);
  for (const [name, value] of left) {
    const other = right.get(name);
    if (other === undefined) {
      mismatches.push(`${file} "${name}": only in the first registry`);
    } else if (!sameValue(value, other, tol)) {
      mismatches.push(`${file} "${name}": ${value} vs ${other}`);
    }
  }
  for (const name of right.keys()) {
    if (!left.has(name)) mismatches.push(`${file} "${name}": only in the second registry`);
  }
  return mismatches;
}

/** A registry's values by name; a name recorded twice is a mismatch, and the first value is kept. */
function indexRows(file: string, side: string, rows: Row[], mismatches: string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const { name, value } of rows) {
    if (index.has(name)) {
      mismatches.push(`${file} "${name}": recorded twice in the ${side} registry`);
    } else {
      index.set(name, value);
    }
  }
  return index;
}

function sameValue(a: string, b: string, tol: number): boolean {
  if (a === b) return true;
  if (INTEGER.test(a) && INTEGER.test(b)) return BigInt(a) === BigInt(b);
  if (NUMBER.test(a) && NUMBER.test(b)) {
    const x = Number(a);
    const y = Number(b);
    return Math.abs(x - y) <= tol * Math.max(Math.abs(x), Math.abs(y));
  }
  return false;
}

/**
 * Every `numbers/*.csv` under `dir` (an output folder), parsed. A link, or a
 * `.csv` that is not a regular file, is refused by name. A missing folder has no
 * registry.
 */
export function readRegistry(dir: string): Record<string, Row[]> {
  const output = path.resolve(dir);
  const numbers = path.join(output, "numbers");
  if (!folderExists(output) || !folderExists(numbers)) return {};
  const registry: Record<string, Row[]> = {};
  for (const entry of fs.readdirSync(numbers, { withFileTypes: true })) {
    const rel = `numbers/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`${rel} is a link: refusing to read it`);
    if (!entry.name.endsWith(".csv")) continue;
    if (!entry.isFile()) throw new Error(`${rel} is not a regular file`);
    registry[entry.name] = parseRegistry(rel, readRegularFile(path.join(numbers, entry.name)).toString("utf8"));
  }
  return registry;
}

/** The name and value of each row, by the header's columns; a note is not compared. */
function parseRegistry(rel: string, text: string): Row[] {
  const [header = [], ...body] = parseCsv(text);
  const nameAt = header.indexOf("name");
  const valueAt = header.indexOf("value");
  if (nameAt === -1 || valueAt === -1) throw new Error(`${rel}: the header must have name and value columns`);
  const rows: Row[] = [];
  for (const fields of body) {
    if (fields.length === 1 && fields[0] === "") continue;
    if (fields.length <= Math.max(nameAt, valueAt)) throw new Error(`${rel}: a row has fewer fields than the header`);
    rows.push({ name: fields[nameAt] ?? "", value: fields[valueAt] ?? "" });
  }
  return rows;
}

/** RFC 4180 rows: a quoted field may hold commas, doubled quotes and newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (quoted) {
      if (ch !== '"') {
        field += ch;
      } else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
      }
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error("a quoted field is never closed");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * A hash over the sorted relative paths and contents of the node's
 * `workspace/scripts/**` and `workspace/output/numbers/**`. `submit` compares it
 * with the one `reproduce` recorded, so an edit to either after the check
 * invalidates the check. `argument.md` and the rest are not hashed.
 */
export function workspaceHash(nodeDir: string): string {
  const workspace = workspaceOf(path.resolve(nodeDir));
  return digest([...entriesIn(workspace, "scripts"), ...entriesIn(workspace, "output/numbers")]);
}

/** The order scripts run in: letter, then number, with `assets.*` last. */
export function scriptOrder(files: string[]): string[] {
  return [...files].sort((x, y) => {
    const a = orderOf(x);
    const b = orderOf(y);
    return a.group - b.group || compareText(a.letter, b.letter) || a.number - b.number || compareText(a.file, b.file);
  });
}

function orderOf(file: string): { group: number; letter: string; number: number; file: string } {
  if (file.startsWith("assets.")) return { group: 1, letter: "", number: 0, file };
  const match = /^([A-Za-z])_(\d+)/.exec(file);
  if (match === null) return { group: 0, letter: "", number: 0, file };
  return { group: 0, letter: match[1] ?? "", number: Number(match[2]), file };
}

/**
 * Re-run the node's scripts in the container and compare the registry they
 * write with the owner's. The scripts run in a scratch workspace under
 * `<runDir>/.analysis/repro/<node>/`, whose output starts empty. Each finished
 * script is recorded in `statePath`, so a call stopped by `budgetMs` (checked
 * between scripts) resumes where it stopped. A script that exits non-zero is
 * recorded as failed and is not re-run; the reproduction is then not ok. The
 * scripts are digested: an edit between calls starts the reproduction again.
 * `workspaceHash` is taken before the first script runs, so `submit` refuses any
 * edit made after the check.
 */
export async function reproduceWorkspace(o: {
  runDir: string;
  nodeDir: string;
  image: string;
  timeoutMs: number;
  budgetMs: number;
  exec?: Exec;
  statePath: string;
}): Promise<{ complete: boolean; ok: boolean; mismatches: string[]; workspaceHash: string }> {
  const started = Date.now();
  const runDir = path.resolve(o.runDir);
  const node = path.resolve(o.nodeDir);
  const id = path.basename(node);
  const workspace = workspaceOf(node);
  const hash = workspaceHash(node);

  const scratch = path.join(runDir, ".analysis", "repro", id);
  const scratchWorkspace = workspaceOf(scratch);
  const marker = path.join(scratch, "scripts.sha256");
  const scripts = entriesIn(workspace, "scripts");
  const digestNow = digest(scripts);
  const resuming = realFolderPath(runDir, ".analysis", "repro", id) && readMarker(marker) === digestNow;
  let state: ReproState;
  if (resuming) {
    state = readState(o.statePath);
  } else {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(o.statePath, { force: true });
    for (const entry of scripts) {
      const to = path.join(scratchWorkspace, entry.rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(entry.file, to);
    }
    fs.mkdirSync(path.join(scratchWorkspace, "output"), { recursive: true });
    fs.writeFileSync(marker, digestNow);
    state = { done: [], failed: {} };
  }

  // Only the top-level analysis names run; other files in scripts/ are copied so scripts can source them.
  const runnable = scriptOrder(
    scripts
      .map((entry) => entry.rel.slice("scripts/".length))
      .filter((name) => !name.includes("/") && ANALYSIS_SCRIPT.test(name)),
  );
  const remaining = (): string[] => runnable.filter((script) => !state.done.includes(script) && !Object.hasOwn(state.failed, script));
  for (const script of remaining()) {
    if (Date.now() - started >= o.budgetMs) break;
    const result = await runScript({
      runDir,
      nodeDir: scratch,
      script,
      image: o.image,
      timeoutMs: o.timeoutMs,
      exec: o.exec,
    });
    if (result.code === 0 && !result.timedOut) {
      state.done.push(script);
    } else {
      state.failed[script] = result.timedOut ? `timed out after ${o.timeoutMs} ms` : `exit code ${result.code}`;
    }
    writeState(o.statePath, state);
  }

  const failedLines = Object.entries(state.failed).map(([script, reason]) => `${script}: ${reason}`);
  if (remaining().length > 0) return { complete: false, ok: false, mismatches: failedLines, workspaceHash: hash };

  const owner = readRegistry(path.join(workspace, "output"));
  const reproduced = readRegistry(path.join(scratchWorkspace, "output"));
  const differences = compareRegistries(owner, reproduced);
  return {
    complete: true,
    ok: failedLines.length === 0 && differences.length === 0,
    mismatches: [...failedLines, ...differences],
    workspaceHash: hash,
  };
}

/** The digest of a set of workspace files: each path, its length and its bytes, in path order. */
function digest(entries: Entry[]): string {
  const hash = createHash("sha256");
  const sorted = [...entries].sort((x, y) => compareText(x.rel, y.rel));
  for (const { rel, file } of sorted) {
    const bytes = readRegularFile(file);
    hash.update(`${rel}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

/**
 * The regular files under `workspace/<folder>` (`scripts`, or `output/numbers`),
 * none of whose folders may be a link. A folder that is missing has no files.
 */
function entriesIn(workspace: string, folder: string): Entry[] {
  const parts = folder.split("/");
  if (!realFolderPath(workspace, ...parts)) return [];
  const dir = path.join(workspace, ...parts);
  return filesUnder(dir).map((rel) => ({ rel: `${folder}/${rel}`, file: path.join(dir, rel) }));
}

/** Every regular file under `dir` as a `/`-separated path; a link or another kind of entry is refused by name. */
function filesUnder(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`${rel} is a link: refusing to read it`);
    if (entry.isDirectory()) {
      found.push(...filesUnder(dir, rel));
    } else if (entry.isFile()) {
      found.push(rel);
    } else {
      throw new Error(`${rel} is not a regular file or folder`);
    }
  }
  return found.sort(compareText);
}

/**
 * True when every folder along `parts` exists and is real; false when the path
 * stops short. Each step is checked, so a link anywhere along the path is refused.
 */
function realFolderPath(...parts: string[]): boolean {
  let dir = "";
  for (const part of parts) {
    dir = dir === "" ? part : path.join(dir, part);
    if (!folderExists(dir)) return false;
  }
  return true;
}

/** True when `dir` is a real folder; false when it is absent; a link or a file is refused by name. */
function folderExists(dir: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${dir} must be a real folder, not a link or a file`);
  }
  return true;
}

/** A file's bytes, opened without following a link on the last component. */
function readRegularFile(file: string): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${file} is not a regular file`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readMarker(marker: string): string | undefined {
  return fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : undefined;
}

function readState(file: string): ReproState {
  if (!fs.existsSync(file)) return { done: [], failed: {} };
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isState(parsed)) throw new Error(`${file} is not a reproduction state`);
  return parsed;
}

function isState(value: unknown): value is ReproState {
  if (typeof value !== "object" || value === null) return false;
  const { done, failed } = value as Record<string, unknown>;
  return (
    Array.isArray(done) &&
    done.every((script) => typeof script === "string") &&
    typeof failed === "object" &&
    failed !== null &&
    Object.values(failed).every((reason) => typeof reason === "string")
  );
}

/** Write the state through a temp file, so an interrupted write never leaves a partial state. */
function writeState(file: string, state: ReproState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const partial = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(partial, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(partial, file);
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

