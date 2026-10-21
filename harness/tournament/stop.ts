// The stop decision: when the evolution rounds are done.
//
// The loop of puzzle children improving on their parents would keep going until
// the owner got bored or the budget ran out. The design says the **code** decides
// instead (design §6), so the owner's tools call this after every `judge_round`
// and a STOP decision refuses further `tree_create`s for derived puzzles. Three
// signals, evaluated in this order, because they mean different things:
//
// 1. **No child beat its parent.** A child beats its parent only when it wins
//    both orders of the head-to-head; a split is a draw, not a win. If no child in
//    the round beat its parent - including the case of a round with no children -
//    the loop has stopped producing improvements: `no-child-beat-parent`.
// 2. **The top set is stable.** The top `TOP_SIZE` (5) puzzles by Bradley-Terry
//    score are the same set as the previous round's. Order does not matter
//    (a fit reorders on noise), and the set is compared, so a different 6th
//    entrant does not count as change. `top-stable`.
// 3. **Hard cap.** `EVOLUTION_CAP` (4) rounds, a cost backstop. A round at the
//    cap whose children did improve reports `cap` - "truncated, not converged" -
//    which is a different finding for the owner than rule 1's "converged".
//
// Round 0 is the initial generation, so it never stops. The order is load-bearing:
// a capped round whose children failed to beat their parents is rule 1's finding,
// and reporting `cap` there would hide that the loop had already converged.
//
// **The record.** Decisions live in `rounds.json`, an array of
// `{ summary, decision }`. Three properties keep it trustworthy across crashes,
// repeated calls and resumed rounds. Writes are temp-file-then-rename, so a failed
// or interrupted write leaves the previous record intact rather than a half-written
// one that a later reader could mistake for a decided round. An append is
// idempotent per round number: a re-called `judge_round` replaces its round's entry
// instead of adding a second, contradictory one. And rounds are contiguous from 0,
// so rule 2 never compares across a round that never happened.
//
// **STOP is a latch.** The design's wording ("while the latest recorded decision is
// STOP") would let a resumed `judge_round` record a later round, or a re-called one
// rewrite its summary, and quietly reopen the gate the loop had closed. So the
// recorded stop, once made, is final: `readStop` returns the earliest stop however
// later rounds would read, `appendRound` refuses every round after it, and a
// re-record is refused if it would change any stop/continue outcome up to and
// including the latch - so it can neither lift the stop nor move it earlier.
// Re-recording a stopped round with the same outcome is still allowed: that is the
// idempotent re-call the brief demands. `appendRound` reports the latch decision
// whenever one stands, because that is what the owner's `tree_create` gate reads.
//
// Stored decisions are never trusted as the source of truth: every read and every
// append recomputes them from the summaries with `decideStop`, so a hand-altered
// `decision` field self-corrects instead of opening the gate. A damaged record is an
// error, not a fresh start: silently rewriting it as "continue" would drop a stop
// the loop already made. Only an absent file reads as `{ stop: false }`, which is
// the correct answer for a tournament that has not run a round yet.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Evolution rounds after which the loop stops whether or not it is improving. */
export const EVOLUTION_CAP = 4;

/** The monitoring set size: the top N by score, compared as a set between rounds. */
export const TOP_SIZE = 5;

/** One child's head-to-head against its parent; `beatParent` means it won both orders. */
export interface ChildOutcome {
  child: string;
  parent: string;
  beatParent: boolean;
}

/** What a finished round contributes to the stop decision. */
export interface RoundSummary {
  round: number;
  /** Every entrant id, best Bradley-Terry score first. */
  top: string[];
  children: ChildOutcome[];
}

/** Yes or no, and for a yes the rule that fired. */
export type Decision = { stop: false } | { stop: true; reason: "no-child-beat-parent" | "top-stable" | "cap" };

/** One line of `rounds.json`. */
export interface RoundRecord {
  summary: RoundSummary;
  decision: Decision;
}

const CONTINUE: Decision = { stop: false };

/**
 * Whether two rounds' monitoring sets are the same set of the first `TOP_SIZE`
 * entrants. A pool smaller than `TOP_SIZE` compares what is there; a set that
 * differs in size is never equal, so "both lists short" cannot fake stability.
 */
function sameTopSet(left: string[], right: string[]): boolean {
  const a = new Set(left.slice(0, TOP_SIZE));
  const b = new Set(right.slice(0, TOP_SIZE));
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * The stop decision for a round history, `history[0]` being round 0.
 *
 * The latest round (highest round number, so caller order does not matter) is the
 * one judged: round 0 never stops; then no-child-beat-parent; then top-stable
 * against round r-1 when that round is in the history; then the cap. An empty
 * history is continue - nothing has been played to stop on.
 */
export function decideStop(history: RoundSummary[]): Decision {
  if (history.length === 0) return CONTINUE;

  let latest = history[0]!;
  for (const entry of history) if (entry.round >= latest.round) latest = entry;
  if (latest.round === 0) return CONTINUE;

  if (!latest.children.some((outcome) => outcome.beatParent)) {
    return { stop: true, reason: "no-child-beat-parent" };
  }

  let previous: RoundSummary | undefined;
  for (const entry of history) if (entry.round === latest.round - 1) previous = entry;
  if (previous !== undefined && sameTopSet(latest.top, previous.top)) return { stop: true, reason: "top-stable" };

  if (latest.round >= EVOLUTION_CAP) return { stop: true, reason: "cap" };
  return CONTINUE;
}

/** A `RoundSummary` as read back from disk, or undefined when it is not one. */
function summaryOf(value: unknown): RoundSummary | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { round, top, children } = value as Partial<RoundSummary>;
  if (typeof round !== "number" || !Number.isInteger(round) || round < 0) return undefined;
  if (!Array.isArray(top) || !top.every((id) => typeof id === "string")) return undefined;
  if (!Array.isArray(children)) return undefined;
  const outcomes: ChildOutcome[] = [];
  for (const entry of children as unknown[]) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { child, parent, beatParent } = entry as Partial<ChildOutcome>;
    if (typeof child !== "string" || typeof parent !== "string" || typeof beatParent !== "boolean") return undefined;
    outcomes.push({ child, parent, beatParent });
  }
  return { round, top, children: outcomes };
}

/** A `Decision` as stored, or undefined when it is not one of the four answers. */
function decisionOf(value: unknown): Decision | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { stop, reason } = value as { stop?: unknown; reason?: unknown };
  if (stop === false) return CONTINUE;
  if (stop !== true) return undefined;
  if (reason === "no-child-beat-parent" || reason === "top-stable" || reason === "cap") return { stop: true, reason };
  return undefined;
}

/**
 * The record's entries, in file order. A missing file is an empty record. Anything
 * else unreadable is an error naming the file and entry: a stop that cannot be
 * read is not a stop that did not happen.
 */
function readRounds(file: string): RoundRecord[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`stop: ${file} is not valid JSON, so the recorded stop decisions cannot be read`);
  }
  if (!Array.isArray(parsed)) throw new Error(`stop: ${file} is not an array of { summary, decision } records`);

  return parsed.map((value, index) => {
    const entry = value as { summary?: unknown; decision?: unknown } | null;
    const summary = typeof entry === "object" && entry !== null ? summaryOf(entry.summary) : undefined;
    const decision = typeof entry === "object" && entry !== null ? decisionOf(entry.decision) : undefined;
    if (summary === undefined || decision === undefined) {
      throw new Error(
        `stop: ${file} entry ${index} is not a { summary, decision } record: ${JSON.stringify(value)?.slice(0, 160)}`,
      );
    }
    return { summary, decision };
  });
}

/** Write the whole record through a temp file and a rename: a crash cannot tear it. */
function writeRounds(file: string, records: RoundRecord[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(records, null, 2)}\n`);
  renameSync(temp, file);
}

/** A stop, and the round it was first recorded at: the latch. */
type StopRecord = { round: number; decision: Extract<Decision, { stop: true }> };

/**
 * Pair each summary with the decision its own history produces, in round order. A
 * decision is a pure function of the history, so re-recording an earlier round
 * must not leave a later round's stale answer behind it: the record either agrees
 * with `decideStop` or it is lying about a stop.
 */
function recordedDecisions(summaries: RoundSummary[]): RoundRecord[] {
  const ordered = summaries.slice().sort((left, right) => left.round - right.round);
  const history: RoundSummary[] = [];
  return ordered.map((summary) => {
    history.push(summary);
    return { summary, decision: decideStop(history) };
  });
}

/**
 * The earliest recorded STOP, in round order, or undefined when the record has not
 * stopped. This is the latch: it is what `readStop` reports and what refuses any
 * later round, whatever the latest round's own decision says.
 */
function latchOf(records: RoundRecord[]): StopRecord | undefined {
  for (const record of records) {
    if (record.decision.stop) return { round: record.summary.round, decision: record.decision };
  }
  return undefined;
}

/**
 * The decision that stands for `file`: the earliest recorded STOP, or the latest
 * round's decision when the record has not stopped, or continue when there is no
 * record yet. Decisions are recomputed from the summaries, so an edited `decision`
 * field cannot open a gate the summaries had closed. Throws on a file that exists
 * but cannot be read: reporting continue there would let the owner create a child
 * after a stop the loop had already decided.
 */
export function readStop(file: string): Decision {
  const records = recordedDecisions(readRounds(file).map((record) => record.summary));
  const latch = latchOf(records);
  if (latch !== undefined) return latch.decision;
  return records.length === 0 ? CONTINUE : records[records.length - 1]!.decision;
}

/**
 * The summary to record, or a thrown error naming what is wrong with it. The round
 * number gets its own message: a fractional round (0.5, say) would otherwise slip
 * between two recorded rounds and make the round set meaningless.
 */
function checkedSummary(value: unknown): RoundSummary {
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `stop: appendRound needs a summary { round, top, children }: ${JSON.stringify(value)?.slice(0, 160)}`,
    );
  }
  const { round } = value as { round?: unknown };
  if (typeof round !== "number" || !Number.isInteger(round) || round < 0) {
    throw new Error(
      `stop: appendRound needs an integer round number >= 0, got ${JSON.stringify(round)}: ` +
        `${JSON.stringify(value)?.slice(0, 160)}`,
    );
  }
  const checked = summaryOf(value);
  if (checked === undefined) {
    throw new Error(
      `stop: appendRound needs a summary { round, top, children } with string ids and a boolean beatParent: ` +
        `${JSON.stringify(value)?.slice(0, 160)}`,
    );
  }
  return checked;
}

/**
 * Record `summary` and return the decision that stands after it.
 *
 * Three refusals protect the record. A round after a recorded STOP is refused (the
 * loop is over). A record whose resulting round set is not 0..max is refused (a
 * hole, even one above the round being recorded, would silently skip rule 2 for the
 * rounds after it). And once a STOP is recorded, a re-record that would change any
 * stop/continue outcome up to and including the latch is refused - re-running a
 * round may correct its data but may never lift the stop.
 *
 * An append that survives is written atomically with every decision recomputed from
 * the summaries, and the returned decision is the latch's when one stands, so the
 * caller's gate reads the same answer as `readStop`.
 */
export function appendRound(file: string, summary: RoundSummary): Decision {
  const checked = checkedSummary(summary);

  // One entry per round, the last occurrence winning: a hand-damaged record with a
  // duplicated round heals here instead of growing another entry.
  const byRound = new Map<number, RoundSummary>();
  for (const record of readRounds(file)) byRound.set(record.summary.round, record.summary);

  const before = recordedDecisions([...byRound.values()]);
  const latch = latchOf(before);
  if (latch !== undefined && checked.round > latch.round) {
    throw new Error(`stop: STOP already recorded at round ${latch.round} (${latch.decision.reason}): no more rounds`);
  }

  byRound.set(checked.round, checked);
  const next = recordedDecisions([...byRound.values()]);

  // The resulting round set must be 0..max with no hole anywhere, not just below the
  // round being recorded: a hand-edited record with a gap above it would otherwise
  // survive, and rule 2 would skip the comparison for every round past the gap.
  const rounds = next.map((record) => record.summary.round);
  const missing: number[] = [];
  for (let round = 0; round < rounds[rounds.length - 1]!; round++) if (!byRound.has(round)) missing.push(round);
  if (missing.length > 0) {
    const holes = missing.length === 1 ? `round ${missing[0]} is` : `rounds ${missing.join(", ")} are`;
    throw new Error(
      `stop: cannot record round ${checked.round} in ${file}: ${holes} missing; record the rounds in order`,
    );
  }

  // A recorded stop stands: the re-record may correct the data of a round but not
  // the fact that the loop stopped. Both directions are refused - lifting a stop and
  // adding one earlier than the latch - because the recorded decision is what the
  // owner has already acted on.
  if (latch !== undefined) {
    for (const record of before) {
      if (record.summary.round > latch.round) continue;
      const recomputed = next.find((entry) => entry.summary.round === record.summary.round);
      if (recomputed === undefined || recomputed.decision.stop === record.decision.stop) continue;
      const was = record.decision.stop ? `STOP (${record.decision.reason})` : "continue";
      const now = recomputed.decision.stop ? `STOP (${recomputed.decision.reason})` : "continue";
      throw new Error(
        `stop: re-recording round ${checked.round} would change round ${record.summary.round} from ${was} to ` +
          `${now}, but STOP is a latch and stands at round ${latch.round} (${latch.decision.reason})`,
      );
    }
  }

  writeRounds(file, next);
  const settled = latchOf(next);
  if (settled !== undefined) return settled.decision;
  return next.find((record) => record.summary.round === checked.round)!.decision;
}
