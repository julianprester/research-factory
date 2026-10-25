// The Phase 3 loop's records: round history, the stop decision, the plan format.
//
// The owner plans a round, workers run it, and the owner closes it with a
// verdict (design §6). Three things here are the **code's** to decide, so the
// owner's `open_round` and `close_round` tools call them and the owner's write
// tool cannot touch the files they rest on (`owners/phase-3/loop/` is protected
// in `ownerMayWrite`):
//
// - **The stop.** Two consecutive closed rounds with `changed: false` stop the
//   loop (`two-quiet`), and so does the `roundCap`th round (`cap`); two quiet
//   rounds are checked first, so a quiet sixth round reports the finding that
//   the argument settled, not the cost backstop. **A STOP is a latch**:
//   `stopOf` scans every prefix of the history, so a record that stops at some
//   round stops the loop for good however later records would read. The round
//   that stops the loop stores the reason in its own record (`stop`), so editing
//   `roundCap` afterwards cannot reopen it.
// - **The record.** `rounds.json` is an array of `RoundRecord`, rounds 1..n with
//   no hole, written through a temp file and a rename so a crash cannot tear
//   it. A file that exists but cannot be read is an error, not a fresh start:
//   reading it as "no rounds" would drop a stop the loop had already made.
// - **The plan.** `parsePlan` is the one reading of `plan.md`: a `## Questions`
//   section and a `## Tasks` section of `### Task <L>: <aim>` headings. `open_round`
//   refuses a plan that does not parse, and `close_round` reads the same plan to
//   learn which tasks the round owed.
//
// Everything under the node's `workspace/` and `tasks/` is written by workers
// and scripts, so a host-side read goes through `locate` (every component
// `lstat`ed, a link refused) and `readRegular` (opened without following a link).
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { maskFences, normaliseHeading } from "../tools/check-puzzle.ts";
import { ANALYSIS_TASK } from "./names.ts";

/** Rounds after which the loop stops whether or not it is still changing (the config's default). */
export const ROUND_CAP = 6;

/** One closed round: whether the argument changed substantially, and what it was then. */
export interface RoundRecord {
  round: number;
  changed: boolean;
  argumentSha: string;
  summary: string;
  letters: string[];
  /**
   * Why the loop stopped, when this is the round that stopped it. Stored when the stop occurs, so a later
   * change of `roundCap` cannot un-latch it. Records written before this field existed have none; their
   * stop is derived from the history and the cap, as it always was.
   */
  stop?: "two-quiet" | "cap";
  /**
   * The reopen loop this round belongs to (`reopen.ts`), when it is a reopen's round. Absent for the
   * original loop, which is what every record written before reopens existed is.
   */
  reopen?: number;
}

/** Yes or no, and for a yes the rule that fired. */
export type Decision = { stop: false } | { stop: true; reason: "two-quiet" | "cap" };

/**
 * The stop decision for a round history (rounds 1..n, in order). `two-quiet`
 * when the last two records are consecutive rounds with `changed: false`;
 * otherwise `cap` when the history holds `cap` rounds. The order is load-bearing:
 * a quiet round at the cap is the argument having settled, not a truncation.
 */
export function decideStop(history: RoundRecord[], cap: number = ROUND_CAP): Decision {
  const last = history[history.length - 1];
  const before = history[history.length - 2];
  if (last !== undefined && before !== undefined && !last.changed && !before.changed && last.round === before.round + 1) {
    return { stop: true, reason: "two-quiet" };
  }
  if (history.length >= cap) return { stop: true, reason: "cap" };
  return { stop: false };
}

/**
 * The decision that stands for `history`: the earliest prefix that stops, else
 * continue. This is the latch - what `open_round` reads - so a record that once
 * stopped can never read as "continue" because of what follows it. A stop recorded
 * in a round's own record (`stop`) stands as written, whatever `cap` is now.
 */
export function stopOf(history: RoundRecord[], cap: number = ROUND_CAP): Decision {
  for (let length = 1; length <= history.length; length++) {
    const recorded = history[length - 1]?.stop;
    if (recorded !== undefined) return { stop: true, reason: recorded };
    const decision = decideStop(history.slice(0, length), cap);
    if (decision.stop) return decision;
  }
  return { stop: false };
}

/** A round number as its folder and file names write it: `01`. */
export function roundName(round: number): string {
  return String(round).padStart(2, "0");
}

const TASK_HEADING = /^###\s+Task\b/i;
const TASK_LINE = /^###\s+Task\s+([^:\s]*)\s*:\s*(\S.*?)\s*$/i;

/**
 * A round plan: its questions and its tasks. Headings are the `##` sections
 * `Questions` and `Tasks` (case, emphasis and a trailing colon bend), and each
 * task is a `### Task <L>: <aim>` heading inside `## Tasks`, `L` an analysis task name:
 * a plain capital letter, or a reopen task `R<n><L>`. Fenced code is not structure. Null
 * when either section is missing, a task heading is not of that form, or no task is
 * listed. A repeated letter is returned as written: `open_round` names it.
 */
export function parsePlan(markdown: string): { questions: string; tasks: { letter: string; aim: string }[] } | null {
  const lines = markdown.split(/\r?\n/);
  const masked = maskFences(markdown);
  let section: "questions" | "tasks" | "other" | undefined;
  let sawQuestions = false;
  let sawTasks = false;
  const questions: string[] = [];
  const tasks: { letter: string; aim: string }[] = [];
  for (const [index, line] of masked.entries()) {
    if (/^##\s/.test(line)) {
      const heading = normaliseHeading(line);
      section = heading === "questions" ? "questions" : heading === "tasks" ? "tasks" : "other";
      if (section === "questions") sawQuestions = true;
      if (section === "tasks") sawTasks = true;
      continue;
    }
    if (section === "questions") questions.push(lines[index] ?? "");
    if (section === "tasks" && TASK_HEADING.test(line)) {
      const task = TASK_LINE.exec(line);
      const letter = task?.[1] ?? "";
      if (task === null || !ANALYSIS_TASK.test(letter)) return null;
      tasks.push({ letter, aim: task[2] ?? "" });
    }
  }
  if (!sawQuestions || !sawTasks || tasks.length === 0) return null;
  return { questions: questions.join("\n").trim(), tasks };
}

/** The folder holding a node's loop records: `owners/phase-3/loop/<nodeId>/`. */
export function loopDir(runDir: string, nodeId: string): string {
  return path.join(runDir, "owners", "phase-3", "loop", nodeId);
}

/** The closed rounds of `nodeId`, rounds 1..n. Absent file: none yet. Anything unreadable throws. */
export function readRounds(runDir: string, nodeId: string): RoundRecord[] {
  const file = path.join(loopDir(runDir, nodeId), "rounds.json");
  // No-follow, regular files only: a link or a folder at this name is an error, not "no rounds".
  const bytes = readRegular(runDir, path.relative(runDir, file).split(path.sep).join("/"));
  if (bytes === undefined) return [];
  const text = bytes.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`rounds: ${file} is not valid JSON, so the recorded rounds cannot be read`);
  }
  if (!Array.isArray(parsed)) throw new Error(`rounds: ${file} is not an array of round records`);
  return parsed.map((value, index) => {
    const record = recordOf(value);
    if (record === undefined || record.round !== index + 1) {
      throw new Error(`rounds: ${file} entry ${index} is not the record of round ${index + 1}: ${JSON.stringify(value)?.slice(0, 160)}`);
    }
    return record;
  });
}

function recordOf(value: unknown): RoundRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { round, changed, argumentSha, summary, letters, stop, reopen } = value as Partial<RoundRecord>;
  if (typeof round !== "number" || !Number.isInteger(round) || round < 1) return undefined;
  if (typeof changed !== "boolean" || typeof argumentSha !== "string" || typeof summary !== "string") return undefined;
  if (!Array.isArray(letters) || !letters.every((letter) => typeof letter === "string")) return undefined;
  const record: RoundRecord = { round, changed, argumentSha, summary, letters };
  if (stop !== undefined) {
    if (stop !== "two-quiet" && stop !== "cap") return undefined;
    record.stop = stop;
  }
  if (reopen !== undefined) {
    if (typeof reopen !== "number" || !Number.isInteger(reopen) || reopen < 1) return undefined;
    record.reopen = reopen;
  }
  return record;
}

/**
 * Record a closed round. It must be the next one (rounds are contiguous from 1 across every loop).
 *
 * The stop applies per loop. A loop-0 round (no `reopen`) is refused once loop 0 has stopped, as it
 * always was. A reopen-`n` round is refused once reopen `n` has stopped; it may follow a stopped loop 0
 * or a stopped reopen `n - 1`, and it may not start while loop 0 or reopen `n - 1` is still running. When
 * a reopen round is the one that stops its loop, the reason is stored in its record, so a later change of
 * `reopenRounds` cannot un-latch it; a `stop` the record brings must be the reason the loop decides.
 *
 * It reads `reopens.json` itself, through the same no-follow reader, and refuses what the file rules out: an
 * original round once any reopen is recorded, and a reopen-`n` round whose entry `n` is not recorded.
 * The caller consults `currentLoop` for the decision it reports; `appendReopen` enforces `maxReopens`.
 * `reopenRounds` is the config's default (`reopen.ts`'s `REOPEN_ROUNDS`). Written atomically.
 */
export function appendRound(
  runDir: string,
  nodeId: string,
  record: RoundRecord,
  cap: number = ROUND_CAP,
  reopenRounds: number = 2,
): void {
  // Validated with the reader's rules first, so a record the reader would refuse is never written.
  const checked = recordOf(record);
  if (checked === undefined) {
    throw new Error(`rounds: cannot record round ${String(record.round)}: not a round record: ${JSON.stringify(record)?.slice(0, 160)}`);
  }
  const history = readRounds(runDir, nodeId);
  // Read here, not left to the caller: a damaged or linked reopens.json throws, so nothing is written.
  const reopens = readReopens(runDir, nodeId);
  if (checked.round !== history.length + 1) {
    throw new Error(`rounds: cannot record round ${checked.round}: the next round is ${history.length + 1}`);
  }
  const loop = checked.reopen ?? 0;
  if (loop === 0) {
    const stopped = stopOf(segment(history, 0), cap);
    if (stopped.stop) throw new Error(`STOP recorded (${stopped.reason}): no more rounds`);
    // Once a reopen is recorded (in reopens.json, or by a reopen-tagged round), the original loop is over whatever
    // the cap now says, even before the reopen's first round. The second test is what currentLoop would reject anyway.
    if (reopens.length > 0 || history.some((earlier) => earlier.reopen !== undefined)) {
      throw new Error(`rounds: cannot record original round ${checked.round}: a reopen is recorded, so the original rounds are closed`);
    }
  } else {
    const current = history[history.length - 1]?.reopen ?? 0;
    if (loop === current) {
      const stopped = stopOf(segment(history, loop), reopenRounds);
      if (stopped.stop) throw new Error(`STOP recorded (${stopped.reason}) in reopen ${loop}: no more rounds`);
    } else if (loop === current + 1) {
      const before = current === 0 ? stopOf(segment(history, 0), cap) : stopOf(segment(history, current), reopenRounds);
      if (!before.stop) throw new Error(`rounds: cannot record reopen ${loop}: loop ${current} has not stopped`);
    } else {
      throw new Error(`rounds: cannot record round ${checked.round} in reopen ${loop}: the current loop is ${current}`);
    }
    // A reopen round needs its reopen recorded first: an unrecorded reopen leaves the node unreadable by currentLoop.
    if (!reopens.some((entry) => entry.n === loop)) {
      throw new Error(
        `rounds: cannot record round ${checked.round} in reopen ${loop}: reopen ${loop} is not recorded in reopens.json: record the reopen first`,
      );
    }
  }

  // A stop the record brings must be the reason its loop decides, on loop 0 as on a reopen.
  const decided = decideStop([...segment(history, loop), checked], loop === 0 ? cap : reopenRounds);
  const label = loop === 0 ? "the original loop" : `reopen ${loop}`;
  if (checked.stop !== undefined && (!decided.stop || decided.reason !== checked.stop)) {
    throw new Error(`rounds: stop ${JSON.stringify(checked.stop)} is not what ${label} decides`);
  }
  const stored: RoundRecord = loop > 0 && decided.stop ? { ...checked, stop: decided.reason } : checked;
  writeAtomic(path.join(loopDir(runDir, nodeId), "rounds.json"), `${JSON.stringify([...history, stored], null, 2)}\n`);
}

/** The records of one loop: `n` 0 is the original loop (those with no `reopen`), `n` ≥ 1 is reopen `n`. */
function segment(history: RoundRecord[], n: number): RoundRecord[] {
  return history.filter((record) => (record.reopen ?? 0) === n);
}

// The reopen record, read from `reopens.json` (see `reopen.ts`). It lives here, not in `reopen.ts`, so
// `appendRound` can refuse an original round while a reopen is recorded: `reopen.ts` imports this module.
/** One reopen: its number, the request the writer sent, and the round it followed. */
export interface ReopenRecord {
  n: number;
  /** The sha-256 of the writer's `workspace/reopen-request.md` when the reopen was made. */
  requestSha: string;
  /** The last recorded round when the reopen was made: loop `n` begins after it. */
  afterRound: number;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** The reopens of `nodeId`, numbered 1..k. Absent file: none yet. Anything unreadable throws. */
export function readReopens(runDir: string, nodeId: string): ReopenRecord[] {
  const file = path.join(loopDir(runDir, nodeId), "reopens.json");
  // No-follow, regular files only, as `readRounds` reads `rounds.json`.
  const bytes = readRegular(runDir, path.relative(runDir, file).split(path.sep).join("/"));
  if (bytes === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`reopens: ${file} is not valid JSON, so the recorded reopens cannot be read`);
  }
  if (!Array.isArray(parsed)) throw new Error(`reopens: ${file} is not an array of reopen records`);
  return parsed.map((value, index) => {
    const record = reopenOf(value);
    if (record === undefined || record.n !== index + 1) {
      throw new Error(`reopens: ${file} entry ${index} is not the record of reopen ${index + 1}: ${JSON.stringify(value)?.slice(0, 160)}`);
    }
    return record;
  });
}

export function reopenOf(value: unknown): ReopenRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { n, requestSha, afterRound } = value as Partial<ReopenRecord>;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return undefined;
  if (typeof requestSha !== "string" || !SHA256.test(requestSha)) return undefined;
  if (typeof afterRound !== "number" || !Number.isInteger(afterRound) || afterRound < 1) return undefined;
  return { n, requestSha, afterRound };
}

/** The sha-256 of the node's `workspace/argument.md`, a regular file read without following a link. */
export function argumentSha(nodeDir: string): string {
  const content = readRegular(nodeDir, "workspace/argument.md");
  if (content === undefined) throw new Error("workspace/argument.md is missing");
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Write through a temp file and a rename: a crash leaves the old file or the new,
 * never half of one. The temp name is unpredictable and created exclusively
 * (`wx`), because some targets sit in folders workers can write: a link planted at
 * a guessed temp name must not be written through. `content` may be bytes, so a
 * copied file is exact.
 */
export function writeAtomic(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  fs.rmSync(temp, { force: true });
  try {
    fs.writeFileSync(temp, content, { flag: "wx" });
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** What is at a path under a node. */
export type Located =
  | { kind: "absent" }
  | { kind: "file" }
  | { kind: "folder" }
  | { kind: "refused"; problem: string };

/**
 * What is at `rel` (a `/`-separated path under `node`), walking each step with
 * `lstat`: a link on the way, a file where a folder belongs, or something that is
 * neither file nor folder is refused by the path that is wrong; a missing step is
 * absent. The node folder itself is trusted.
 */
export function locate(node: string, rel: string): Located {
  const parts = rel.split("/");
  let current = node;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const shown = parts.slice(0, index + 1).join("/");
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
      throw error;
    }
    if (stat.isSymbolicLink()) return { kind: "refused", problem: `${shown} is a link: refusing to use it` };
    if (index < parts.length - 1) {
      if (!stat.isDirectory()) return { kind: "refused", problem: `${shown} is not a folder` };
      continue;
    }
    if (stat.isFile()) return { kind: "file" };
    if (stat.isDirectory()) return { kind: "folder" };
    return { kind: "refused", problem: `${shown} is not a regular file or folder` };
  }
  return { kind: "folder" };
}

/**
 * The bytes of the regular file at `rel` under `node`, or undefined when it is
 * absent. A link on the path, a folder where the file belongs, or a file that
 * is swapped for a link between the check and the open throws.
 */
export function readRegular(node: string, rel: string): Buffer | undefined {
  const found = locate(node, rel);
  if (found.kind === "absent") return undefined;
  if (found.kind === "refused") throw new Error(found.problem);
  if (found.kind === "folder") throw new Error(`${rel} is not a regular file`);
  const file = path.join(node, ...rel.split("/"));
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`${rel} is a link: refusing to use it`);
    throw error;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${rel} is not a regular file`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
