// Reopens: the records of a reopen and the stop of each loop (design §9).
//
// A reopen sends a finished explanation back to Phase 3 for a short extra loop. The original loop
// (loop 0) stops as it always did, and that stop is a latch a reopen never lifts. Each reopen is a
// loop of its own, bounded by `reopenRounds` and ended early by the same two-quiet rule. Round numbers
// keep counting across loops, and a reopen's round records carry its number (`RoundRecord.reopen`).
//
// `reopens.json` is the tools' record of the reopens, one `ReopenRecord` per reopen, numbered 1..k with
// no hole. It is read and written the way `rounds.json` is (`readRegular`, `writeAtomic`): a link or a
// damaged file is an error, never "no reopens".
import * as path from "node:path";

import {
  ROUND_CAP,
  loopDir,
  readRegular,
  readRounds,
  stopOf,
  writeAtomic,
  type Decision,
  type RoundRecord,
} from "./rounds.ts";

/** Rounds in one reopen's loop (the config's default, `reopenRounds`). */
export const REOPEN_ROUNDS = 2;

/** One reopen: its number, the request the writer sent, and the round it followed. */
export interface ReopenRecord {
  n: number;
  /** The sha-256 of the writer's `workspace/reopen-request.md` when the reopen was made. */
  requestSha: string;
  /** The last recorded round when the reopen was made: loop `n` begins after it. */
  afterRound: number;
}

/** The loop that is current, and whether it has stopped. Reopen 0 is the original loop. */
export interface CurrentLoop {
  reopen: number;
  decision: Decision;
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The loop that is current for `history`, given the reopens recorded. Loop 0 is `stopOf` over the
 * records without a `reopen`; loop n is `stopOf` over its own records with `reopenRounds` as the cap.
 * A recorded `stop` stands in either loop, so a later change of the config cannot reopen a loop.
 *
 * Input that the tools could not have written throws, so the caller fails closed: a reopen with loop 0
 * still running, a round whose reopen has no entry, an original round after a reopen round, or a
 * reopen recorded while an earlier one has not stopped.
 */
export function currentLoop(
  history: RoundRecord[],
  reopens: ReopenRecord[],
  cap: number = ROUND_CAP,
  reopenRounds: number = REOPEN_ROUNDS,
): CurrentLoop {
  const original = stopOf(
    history.filter((record) => record.reopen === undefined),
    cap,
  );
  let inReopen = false;
  for (const record of history) {
    if (record.reopen === undefined) {
      if (inReopen) throw new Error(`reopens: original round ${record.round} follows a reopen round`);
      continue;
    }
    inReopen = true;
    if (!reopens.some((entry) => entry.n === record.reopen)) {
      throw new Error(`reopens: round ${record.round} is in reopen ${record.reopen}, which has no entry`);
    }
  }
  const reopen = reopens.reduce((highest, entry) => Math.max(highest, entry.n), 0);
  if (reopen === 0) return { reopen, decision: original };
  if (!original.stop) throw new Error("reopens: a reopen is recorded while loop 0 has not stopped");
  for (let earlier = 1; earlier < reopen; earlier++) {
    if (!stopOf(segment(history, earlier), reopenRounds).stop) {
      throw new Error(`reopens: reopen ${earlier + 1} is recorded while reopen ${earlier} has not stopped`);
    }
  }
  return { reopen, decision: stopOf(segment(history, reopen), reopenRounds) };
}

function segment(history: RoundRecord[], reopen: number): RoundRecord[] {
  return history.filter((record) => record.reopen === reopen);
}

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

function reopenOf(value: unknown): ReopenRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { n, requestSha, afterRound } = value as Partial<ReopenRecord>;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return undefined;
  if (typeof requestSha !== "string" || !SHA256.test(requestSha)) return undefined;
  if (typeof afterRound !== "number" || !Number.isInteger(afterRound) || afterRound < 1) return undefined;
  return { n, requestSha, afterRound };
}

/**
 * Record reopen `rec.n`. It must be the next one and within `maxReopens`; it must follow the last
 * recorded round; and the loop before it must have stopped. Written atomically.
 */
export function appendReopen(
  runDir: string,
  nodeId: string,
  rec: ReopenRecord,
  maxReopens: number,
  cap: number = ROUND_CAP,
  reopenRounds: number = REOPEN_ROUNDS,
): void {
  const record = reopenOf(rec);
  if (record === undefined) throw new Error(`reopens: not a reopen record: ${JSON.stringify(rec)?.slice(0, 160)}`);
  const history = readRounds(runDir, nodeId);
  const reopens = readReopens(runDir, nodeId);
  if (record.n !== reopens.length + 1) {
    throw new Error(`reopens: cannot record reopen ${record.n}: the next reopen is ${reopens.length + 1}`);
  }
  if (record.n > maxReopens) throw new Error(`reopens: cannot record reopen ${record.n}: maxReopens is ${maxReopens}`);
  if (record.afterRound !== history.length) {
    throw new Error(`reopens: afterRound must be the last recorded round (${history.length}), not ${record.afterRound}`);
  }
  const current = currentLoop(history, reopens, cap, reopenRounds);
  if (!current.decision.stop) throw new Error(`reopens: cannot record reopen ${record.n}: loop ${current.reopen} has not stopped`);
  writeAtomic(path.join(loopDir(runDir, nodeId), "reopens.json"), `${JSON.stringify([...reopens, record], null, 2)}\n`);
}
