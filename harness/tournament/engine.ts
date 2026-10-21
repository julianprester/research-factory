// The round runner: it pairs entrants, judges the pairs, and can be restarted.
//
// Two things here are load-bearing beyond "run the matches".
//
// **Resumability (Review Focus 2).** Every finished match is appended to
// `<dir>/round-<n>.matches.jsonl` the moment it is judged, and a restarted call
// replays that log: ratings, match counts and the seen-pairs set come back from
// the lines on disk. The concurrency is only about how many judge calls are in
// flight, so the log's order is the completion order and cannot be trusted; the
// replay therefore groups the log by batch and sorts each batch's pairs, which
// makes the reconstructed state a function of *which* matches happened, not of
// the order they finished in. Batch k's pairs are then a pure function of
// (state after batches -1..k-1, seed, k), so a crash inside batch k is repaired
// by re-deriving the same pairs and skipping the ones already on disk, and later
// batches are untouched. A torn last line (a crash mid-write) is dropped before
// anything is appended, so a partial line can never swallow the next match.
//
// Three smaller rules keep the log honest. Every log starts with a header line
// naming its seed and entrant set, and a resume whose options disagree is
// refused: without it, two schedules would silently interleave. `readLog` counts
// each (batch, pair) once even when a line is on disk twice, so an already
// damaged log heals on the next replay; and it tolerates a damaged line only at
// the tail, where a crash can produce one - a damaged line in the middle is an
// error naming the line, because silently dropping a match would change the
// ranking. `runRound` also holds an O_EXCL `round-<n>.lock` for its round, so two
// overlapping calls cannot both append batch 0 and double-count it.
//
// **Isolation (Review Focus 3).** `loadEntrant` reads exactly two files: the
// puzzle's `workspace/puzzle.md` and the parent pattern's `workspace/pattern.md`,
// and from the pattern only the four sections the judge is allowed to see. It
// never looks under `workspace/reviews/`, so no review text can reach a judge
// prompt through a Side.
//
// Elo is only ever the scheduler here; what the round reports is the
// Bradley-Terry fit over the whole match log (plus the prior rounds' outcomes),
// which does not depend on the order the log is read in.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { findNode } from "../tree.ts";
import { judgeMatch, type MatchRecord, type Side, type Transport } from "./judge.ts";
import {
  ELO_START,
  eloUpdate,
  fitBradleyTerry,
  kFactor,
  mulberry32,
  type Fit,
  type Outcome,
  type Result,
} from "./rating.ts";

/** The pattern sections the judge may see behind a puzzle, in reading order. */
const EVIDENCE_SECTIONS = ["## Measure", "## Result", "## Verdict", "## Worst fits"];

/** Matches each entrant must have played, counting the prior rounds, to finish a round. */
const DEFAULT_MIN_MATCHES = 6;

/** Pairs judged per batch; a batch is also the crash-recovery unit. */
const DEFAULT_BATCH_SIZE = 8;

/** Judge calls in flight at once. */
const DEFAULT_CONCURRENCY = 4;

/** Bootstrap resamples for the round's fit; tests shorten it. */
const DEFAULT_BOOTSTRAP = 200;

/** The share of a batch that fills the newcomer and the close-rated slots. */
const NEWCOMER_SHARE = 0.4;
const CLOSE_SHARE = 0.4;

/** A pair key that does not depend on which entrant was shown first. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * The round cannot make progress: no unseen pair is left and the round is not
 * done. Distinct from a budget stop (`complete: false`, which means "there is
 * work left, run me again"): here running again would add nothing, because the
 * pool is too small for `minMatches`. `short` names the entrants still short, so
 * the caller can say what to fix (add puzzles, or lower the minimum).
 */
export class RoundStuckError extends Error {
  /** The entrants still short of `minMatches` when the pool ran out. */
  short: string[];

  constructor(message: string, short: string[]) {
    super(message);
    this.name = "RoundStuckError";
    this.short = short;
  }
}

/** A side's card and evidence, or a puzzle with no card, is a caller error. */
export function loadEntrant(runDir: string, puzzleId: string): Side {
  const puzzle = findNode(runDir, puzzleId);
  if (puzzle.type !== "puzzle") {
    throw new Error(`loadEntrant: ${puzzleId} is a ${puzzle.type} node, not a puzzle`);
  }
  const cardFile = path.join(puzzle.dir, "workspace", "puzzle.md");
  if (!existsSync(cardFile)) throw new Error(`loadEntrant: ${puzzleId} has no workspace/puzzle.md`);
  const card = readFileSync(cardFile, "utf8");

  if (!puzzle.parent) throw new Error(`loadEntrant: ${puzzleId} has no parent pattern`);
  const pattern = findNode(runDir, puzzle.parent);
  const patternFile = path.join(pattern.dir, "workspace", "pattern.md");
  // Empty evidence would send the judge a card with no pattern context and no
  // signal that anything is wrong, so a broken pattern node stops the round here.
  if (!existsSync(patternFile)) {
    throw new Error(`loadEntrant: ${puzzleId}'s parent ${pattern.id} has no workspace/pattern.md`);
  }
  const patternText = readFileSync(patternFile, "utf8");
  // Only the four named sections leave the pattern card: the judge gets the
  // evidence, not the whole Phase 1 node. Nothing under workspace/reviews/ is
  // read at all - that is the isolation rule, not an afterthought.
  const evidence = EVIDENCE_SECTIONS.map((heading) => section(patternText, heading))
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
  if (evidence === "") {
    throw new Error(
      `loadEntrant: ${pattern.id} has none of the sections ${EVIDENCE_SECTIONS.join(", ")} to give the judge`,
    );
  }

  return { id: puzzleId, card, evidence };
}

/**
 * One `## Heading` section of a markdown file, heading included, ending before
 * the next heading of level 1 or 2 (so `###` sub-headings stay inside). Absent
 * heading means no section.
 */
function section(markdown: string, heading: string): string | undefined {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2} /.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

/** The state the scheduler reads: who is in the pool, how rated and how busy. */
export interface ScheduleState {
  ids: string[];
  /** Elo ratings; a missing entrant starts at ELO_START. */
  ratings: Record<string, number>;
  /** Matches played so far; a missing entrant has played none. */
  played: Record<string, number>;
  /** Pair keys already judged this round. */
  seen: Set<string>;
}

/**
 * A batch of pairs: about 40% newcomer (least-played) against its nearest
 * rating, 40% between close ratings, 20% random, then filled to `size` with any
 * pair not yet seen. Deterministic in (state, batch, seed, size): the batch
 * number is folded into the seed, so later batches differ while a re-derived
 * batch is identical. Seen pairs, self-pairs and duplicates inside the batch are
 * never returned; an exhausted pool returns fewer pairs, or none.
 *
 * Pairs come back in a canonical (sorted) orientation. Orientation only decides
 * who is `a` in the record; the judge sees both orders regardless.
 */
export function schedulePairs(state: ScheduleState, batch: number, seed: number, size: number): [string, string][] {
  const { ids, ratings, played } = state;
  if (ids.length < 2 || size <= 0) return [];

  const rng = mulberry32(((seed >>> 0) + Math.imul(batch + 1, 0x9e3779b1)) >>> 0);
  const taken = new Set(state.seen);
  const pairs: [string, string][] = [];

  const ratingOf = (id: string): number => ratings[id] ?? ELO_START;
  const playedOf = (id: string): number => played[id] ?? 0;

  const shuffle = (values: string[]): string[] => {
    const out = values.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  const fresh = (id: string): string[] => ids.filter((other) => other !== id && !taken.has(pairKey(id, other)));
  const add = (first: string, second: string): boolean => {
    if (first === second) return false;
    const key = pairKey(first, second);
    if (taken.has(key)) return false;
    taken.add(key);
    pairs.push(first < second ? [first, second] : [second, first]);
    return true;
  };
  /** The unseen partner whose rating is closest; ties go to the pool's order. */
  const nearest = (id: string): string | undefined => {
    const options = fresh(id);
    let best: string | undefined;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const option of options) {
      const gap = Math.abs(ratingOf(option) - ratingOf(id));
      if (gap < bestGap) {
        best = option;
        bestGap = gap;
      }
    }
    return best;
  };
  /** Any unseen pair at all, scanned in a seeded order. */
  const anyPair = (): boolean => {
    const pool = shuffle(ids);
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        if (add(pool[i]!, pool[j]!)) return true;
      }
    }
    return false;
  };

  const newcomerCount = Math.round(size * NEWCOMER_SHARE);
  const closeCount = Math.round(size * CLOSE_SHARE);
  const randomCount = Math.max(0, size - newcomerCount - closeCount);

  // 1. Newcomers: the least-played entrants, each against its nearest rating.
  // The shuffle breaks ties in match count, so batch to batch this rotates.
  const thinness = shuffle(ids).sort((x, y) => playedOf(x) - playedOf(y));
  let newcomers = 0;
  for (const id of thinness) {
    if (newcomers >= newcomerCount) break;
    const partner = nearest(id);
    if (partner !== undefined && add(id, partner)) newcomers++;
  }

  // 2. Close ratings: a seeded walk over the pool, each against its nearest.
  let close = 0;
  for (const id of shuffle(ids)) {
    if (close >= closeCount) break;
    const partner = nearest(id);
    if (partner !== undefined && add(id, partner)) close++;
  }

  // 3. Random pairs, then fill whatever is left up to the batch size.
  for (let i = 0; i < randomCount; i++) if (!anyPair()) break;
  while (pairs.length < size) if (!anyPair()) break;

  return pairs;
}

export interface RoundOptions {
  /** Where `round-<n>.matches.jsonl` and `round-<n>.json` live. */
  dir: string;
  round: number;
  sides: Side[];
  /** (child, parent) pairs played first as batch -1; `a` is the child. */
  forced: [string, string][];
  /** Earlier rounds' outcomes: they seed ratings and match counts, never `seen`. */
  prior: Outcome[];
  transport: Transport;
  seed: number;
  minMatches?: number;
  batchSize?: number;
  concurrency?: number;
  /** Wall-clock budget; spent means "start no new work", not "lose work". */
  budgetMs?: number;
  /** Bootstrap resamples for the round's fit. */
  bootstrap?: number;
}

export interface RoundResult {
  complete: boolean;
  matches: MatchRecord[];
  fit: Fit;
  top: string[];
  played: Record<string, number>;
}

export interface Candidate {
  id: string;
  score: number;
  lower: number;
  upper: number;
  matches: number;
}

/**
 * One line of the match log: which batch the match belonged to, the pair as it
 * was judged (so a forced match keeps child-then-parent), and the record.
 */
interface LogLine {
  batch: number;
  pair: [string, string];
  match: MatchRecord;
}

/** Ratings, counts and seen pairs as the scheduler needs them. */
interface State {
  ratings: Record<string, number>;
  played: Record<string, number>;
  seen: Set<string>;
}

function emptyState(): State {
  return { ratings: {}, played: {}, seen: new Set<string>() };
}

/**
 * Apply one match to the state. The k-factor is read from the entrant with more
 * matches, so it halves once both are past their fifth - a rating that has been
 * around a while should not jump as far as a new one.
 */
function applyMatch(state: State, a: string, b: string, result: Result, seen: boolean): void {
  const playedA = state.played[a] ?? 0;
  const playedB = state.played[b] ?? 0;
  const k = kFactor(Math.max(playedA, playedB));
  const [nextA, nextB] = eloUpdate(state.ratings[a] ?? ELO_START, state.ratings[b] ?? ELO_START, result, k);
  state.ratings[a] = nextA;
  state.ratings[b] = nextB;
  state.played[a] = playedA + 1;
  state.played[b] = playedB + 1;
  if (seen) state.seen.add(pairKey(a, b));
}

/** The batch order: forced matches first (-1), then the scheduled batches. */
function batchOrder(x: LogLine, y: LogLine): number {
  if (x.batch !== y.batch) return x.batch - y.batch;
  const left = pairKey(x.pair[0], x.pair[1]);
  const right = pairKey(y.pair[0], y.pair[1]);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Rebuild the state from the prior rounds and the log's lines with
 * `batch < belowBatch`, replayed in canonical batch-then-pair order. This is why
 * the completion order of the concurrent judge calls cannot matter.
 */
function replay(prior: Outcome[], entries: LogLine[], belowBatch: number): State {
  const state = emptyState();
  for (const outcome of prior) applyMatch(state, outcome.a, outcome.b, outcome.result, false);
  const lines = entries.filter((entry) => entry.batch < belowBatch).sort(batchOrder);
  for (const line of lines) applyMatch(state, line.match.a, line.match.b, line.match.result, true);
  return state;
}

/**
 * Drop a torn or damaged **tail** before anything is appended.
 *
 * A crash can leave the last write half-landed: no trailing newline, or a line
 * that is not a match record. Leaving it there would be worse than losing the
 * match it described - the next append would glue a new record onto the fragment,
 * and a later call would find the fragment in the middle of the log and refuse
 * the file. So the damaged tail is cut and the truncated match is played again.
 * Damage anywhere else is not repaired: `readLog` refuses it, because silently
 * dropping a judged match would change the ranking.
 */
function repairTornLine(file: string): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  const raw = text.split("\n");
  let lastContent = -1;
  for (let i = 0; i < raw.length; i++) if (raw[i]!.trim() !== "") lastContent = i;
  if (lastContent < 0) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw[lastContent]!.trim());
  } catch {
    parsed = undefined;
  }
  const sound = lastContent === 0 ? headerOf(parsed) !== undefined : lineOf(parsed) !== undefined;
  if (text.endsWith("\n") && sound) return;

  const kept = raw.slice(0, lastContent);
  writeFileSync(file, kept.length === 0 ? "" : `${kept.join("\n")}\n`);
}

/** The log's first line: which schedule the file belongs to. */
interface LogHeader {
  seed: number;
  /** Every entrant id, sorted, so the fingerprint does not depend on caller order. */
  ids: string[];
}

interface LogContents {
  header: LogHeader | undefined;
  lines: LogLine[];
}

/** The header a line carries, or undefined when the line is not a header. */
function headerOf(value: unknown): LogHeader | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const wrapper = (value as { header?: unknown }).header;
  if (typeof wrapper !== "object" || wrapper === null) return undefined;
  const { seed, ids } = wrapper as { seed?: unknown; ids?: unknown };
  if (typeof seed !== "number" || !Array.isArray(ids)) return undefined;
  if (!ids.every((id) => typeof id === "string")) return undefined;
  return { seed, ids: ids as string[] };
}

/** One line as a match record, or undefined when it is not one. */
function lineOf(value: unknown): LogLine | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const line = value as Partial<LogLine>;
  if (typeof line.batch !== "number" || !Array.isArray(line.pair)) return undefined;
  if (typeof line.pair[0] !== "string" || typeof line.pair[1] !== "string") return undefined;
  const match = line.match;
  if (!match || typeof match.a !== "string" || typeof match.b !== "string") return undefined;
  return { batch: line.batch, pair: [line.pair[0], line.pair[1]], match };
}

/**
 * The log's header and lines.
 *
 * A line that is not a match record is tolerated only as the last line with
 * content: that is where a crash can tear a write, and the match it described
 * never landed. Anywhere else an unreadable line means the file was damaged, and
 * skipping it would silently drop a judged match, so it throws naming the line.
 *
 * Lines are de-duplicated on (batch, pair), keeping the first: two overlapping
 * calls (before the lock existed, or a hand-repaired log) can have appended the
 * same match twice, and a match must never count twice.
 */
function readLog(file: string): LogContents {
  if (!existsSync(file)) return { header: undefined, lines: [] };
  const raw = readFileSync(file, "utf8").split("\n");
  let lastContent = -1;
  for (let i = 0; i < raw.length; i++) if (raw[i]!.trim() !== "") lastContent = i;

  let header: LogHeader | undefined;
  const lines: LogLine[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const trimmed = raw[i]!.trim();
    if (trimmed === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = undefined;
    }
    if (i === 0) {
      const first = headerOf(parsed);
      if (first !== undefined) {
        header = first;
        continue;
      }
    }
    const line = lineOf(parsed);
    if (line === undefined) {
      if (i === lastContent) continue; // a torn tail: that match never landed
      throw new Error(`runRound: ${file} line ${i + 1} is not a match record: ${trimmed.slice(0, 120)}`);
    }
    const key = `${line.batch}\u0000${pairKey(line.pair[0], line.pair[1])}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return { header, lines };
}

/**
 * Fingerprint a new log, or check the fingerprint of an existing one. A resume
 * with a different seed or a different entrant set would silently interleave two
 * schedules, so it is refused rather than quietly producing a ranking over
 * matches no run planned.
 */
function ensureLogHeader(file: string, seed: number, ids: string[], header: LogHeader | undefined): void {
  const expected: LogHeader = { seed, ids: ids.slice().sort() };
  if (header === undefined) {
    if (existsSync(file) && readFileSync(file, "utf8").trim() !== "") {
      throw new Error(`runRound: ${file} has no header line, so its seed and entrant set are unknown`);
    }
    appendFileSync(file, `${JSON.stringify({ header: expected })}\n`);
    return;
  }
  if (header.seed !== expected.seed) {
    throw new Error(`runRound: ${file} was started with seed ${header.seed}, this call uses ${expected.seed}`);
  }
  if (header.ids.length !== expected.ids.length || header.ids.some((id, at) => id !== expected.ids[at])) {
    throw new Error(
      `runRound: ${file} was started with a different entrant set (${header.ids.join(", ")}), ` +
        `this call has (${expected.ids.join(", ")})`,
    );
  }
}

/** Whether a lock's recorded pid is still alive (EPERM means it exists, we may not signal it). */
function holderAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take `file` as an O_EXCL lockfile holding this process's pid, and return the
 * release. A lock whose holder is gone is stale (a crashed run) and is broken
 * once; a lock whose holder is alive fails fast, because the alternative is two
 * calls judging and appending the same batch - which is exactly the double count
 * this lock exists to stop. The lock is per round file, so two rounds of the same
 * pool may run side by side.
 */
function acquireRoundLock(file: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" });
      return () => {
        try {
          rmSync(file, { force: true });
        } catch {
          /* the lock is already gone */
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    if (Number.isInteger(holder) && holder > 0 && holderAlive(holder)) {
      throw new Error(`runRound: ${file} is held by pid ${holder} - another round is already running on this directory`);
    }
    rmSync(file, { force: true }); // stale: its writer is gone
  }
  throw new Error(`runRound: could not take ${file}`);
}

function sortedRecord(values: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(values).sort()) out[key] = values[key]!;
  return out;
}

/**
 * Judge one round, resumably.
 *
 * Forced pairs are played first as batch -1 (a = child, b = parent). Then, batch
 * by batch, pairs are scheduled from the state left by the batches before it,
 * judged with at most `concurrency` calls in flight, and appended to the log as
 * they finish. The round is complete when the forced pairs are done and every
 * side has `minMatches` matches counting `prior`; then `round-<n>.json` is
 * written.
 *
 * A spent `budgetMs` stops new work and returns `complete: false`, keeping
 * everything already judged - a later call resumes from the log. The first batch
 * of a call always runs (the forced batch counts as one), so the budget means
 * "plus at most one batch", and `budgetMs: 0` means "one batch at most". The
 * forced batch is exempt from the budget on purpose: the stopping rule needs
 * every child's head-to-head against its parent, so those matches are never
 * postponed to another call.
 *
 * A pool too small for `minMatches` is not a partial round: no restart can add a
 * match, so it throws `RoundStuckError` naming the entrants still short instead
 * of returning a result that looks like a budget stop. The round is serialised
 * by a `round-<n>.lock`, so two overlapping calls fail fast rather than doubling
 * the log.
 */
export async function runRound(o: RoundOptions): Promise<RoundResult> {
  mkdirSync(o.dir, { recursive: true });
  const release = acquireRoundLock(path.join(o.dir, `round-${o.round}.lock`));
  try {
    return await runRoundLocked(o);
  } finally {
    release();
  }
}

async function runRoundLocked(o: RoundOptions): Promise<RoundResult> {
  const minMatches = o.minMatches ?? DEFAULT_MIN_MATCHES;
  const batchSize = o.batchSize ?? DEFAULT_BATCH_SIZE;
  const concurrency = Math.max(1, Math.floor(o.concurrency ?? DEFAULT_CONCURRENCY));
  const bootstrap = o.bootstrap ?? DEFAULT_BOOTSTRAP;
  const budgetMs = o.budgetMs ?? Number.POSITIVE_INFINITY;

  const sides = new Map(o.sides.map((side) => [side.id, side]));
  const ids = o.sides.map((side) => side.id);
  const logFile = path.join(o.dir, `round-${o.round}.matches.jsonl`);
  const roundFile = path.join(o.dir, `round-${o.round}.json`);

  // Duplicates in `forced` would judge and log the same match twice, so the
  // list is collapsed on the pair, first occurrence winning.
  const forced: [string, string][] = [];
  const forcedKeys = new Set<string>();
  for (const [a, b] of o.forced) {
    if (!sides.has(a)) throw new Error(`runRound: forced pair names unknown side ${a}`);
    if (!sides.has(b)) throw new Error(`runRound: forced pair names unknown side ${b}`);
    const key = pairKey(a, b);
    if (forcedKeys.has(key)) continue;
    forcedKeys.add(key);
    forced.push([a, b]);
  }

  repairTornLine(logFile);
  const log = readLog(logFile);
  ensureLogHeader(logFile, o.seed, ids, log.header);
  const entries = log.lines;

  const deadline = Date.now() + budgetMs;
  const spent = (): boolean => Date.now() >= deadline;
  let batchesRun = 0;

  /** Judge `pairs` with bounded concurrency; append each match as it finishes. */
  const playBatch = async (batch: number, pairs: [string, string][]): Promise<void> => {
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        // The first batch of a call always runs, so `budgetMs: 0` is "one batch"
        // and a spent budget means "plus at most one batch"; later batches start
        // nothing new once it is gone. The forced batch has already run by then
        // and is exempt on purpose (see runRound).
        if (batchesRun > 0 && spent()) return;
        const index = next++;
        if (index >= pairs.length) return;
        const [a, b] = pairs[index]!;
        const sideA = sides.get(a)!;
        const sideB = sides.get(b)!;
        const match = await judgeMatch(sideA, sideB, o.transport);
        const line: LogLine = { batch, pair: [a, b], match };
        appendFileSync(logFile, `${JSON.stringify(line)}\n`);
        entries.push(line);
      }
    };
    // allSettled, not all: a judge failure must not leave a worker still writing
    // to the log after this call has rejected.
    const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, pairs.length) }, worker));
    const failure = settled.find((outcome) => outcome.status === "rejected");
    if (failure && failure.status === "rejected") throw failure.reason;
  };

  const done = (state: State): boolean => ids.every((id) => (state.played[id] ?? 0) >= minMatches);
  const forcedDone = (state: State): boolean => forced.every(([a, b]) => state.seen.has(pairKey(a, b)));

  // Batch -1: the forced (child, parent) matches, in the order given.
  const beforeForced = replay(o.prior, entries, 0);
  const pendingForced = forced.filter(([a, b]) => !beforeForced.seen.has(pairKey(a, b)));
  if (pendingForced.length > 0) {
    await playBatch(-1, pendingForced);
    batchesRun++;
  }

  let complete = false;
  // A runaway pairing would otherwise never end; this is far more batches than
  // a pool needs to reach minMatches.
  const batchLimit = ids.length * minMatches + DEFAULT_BATCH_SIZE;
  for (let batch = 0; batch <= batchLimit; batch++) {
    const whole = replay(o.prior, entries, Number.POSITIVE_INFINITY);
    // Completion is checked first: a resumed round whose matches are all on disk
    // finishes even with no budget left.
    if (done(whole) && forcedDone(whole)) {
      complete = true;
      break;
    }
    // The base state deliberately excludes this batch's own lines: the pairs are
    // recomputed from the state before the batch, so re-deriving them after a
    // crash gives the same pairs. Whatever this batch already judged is dropped
    // by the seen set of the whole log - that is the only filter that keeps a
    // partially finished batch from being played twice.
    const base = replay(o.prior, entries, batch);
    const derived = schedulePairs(
      { ids, ratings: base.ratings, played: base.played, seen: base.seen },
      batch,
      o.seed,
      batchSize,
    );
    if (derived.length === 0) {
      // No unseen pair is left and the round is not done, so no amount of
      // re-running adds a match: say so, naming who is short. A budget stop is
      // the opposite case - work left, no time - and stays `complete: false`.
      const short = ids.filter((id) => (whole.played[id] ?? 0) < minMatches);
      const detail =
        short.length > 0
          ? short.map((id) => `${id} has ${whole.played[id] ?? 0}`).join(", ")
          : `missing forced pairs: ${forced.map(([a, b]) => `${a}/${b}`).join(", ")}`;
      throw new RoundStuckError(
        `round ${o.round} cannot progress: the pool of ${ids.length} identities is too small for ` +
          `minMatches ${minMatches} (${detail}); add puzzles or lower the minimum`,
        short,
      );
    }
    const pairs = derived.filter(([a, b]) => !whole.seen.has(pairKey(a, b)));
    if (pairs.length === 0) continue; // this batch is entirely on disk already
    if (batchesRun > 0 && spent()) break;
    await playBatch(batch, pairs);
    batchesRun++;
  }

  const matches = entries.slice().sort(batchOrder).map((entry) => entry.match);
  const outcomes: Outcome[] = [
    ...o.prior,
    ...matches.map((match) => ({ a: match.a, b: match.b, result: match.result })),
  ];
  const raw = fitBradleyTerry(outcomes, { seed: o.seed, bootstrap });
  const fit: Fit = {
    scores: sortedRecord(raw.scores),
    lower: sortedRecord(raw.lower),
    upper: sortedRecord(raw.upper),
  };
  const top = Object.keys(fit.scores).sort((x, y) => {
    const gap = fit.scores[y]! - fit.scores[x]!;
    if (gap !== 0) return gap;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const played = sortedRecord(replay(o.prior, entries, Number.POSITIVE_INFINITY).played);

  const result: RoundResult = { complete, matches, fit, top, played };
  if (complete) {
    const stored = { round: o.round, matches, fit, top, played };
    // Rename, not in-place write: a crash must not leave half a JSON file for the
    // next round's `prior` reader to choke on.
    const tempFile = `${roundFile}.${process.pid}.tmp`;
    writeFileSync(tempFile, `${JSON.stringify(stored, null, 2)}\n`);
    renameSync(tempFile, roundFile);
  }
  return result;
}

/**
 * The promotion list. `ranked` is the fit's order (score descending, id to break
 * ties); `breaks` lists every `n` where promoting the top `n` leaves a gap -
 * `ranked[n-1].lower > ranked[n].upper`, so the interval of the last promoted
 * entrant sits entirely above the next one's. `underplayed` lists entrants with
 * fewer than `minMatches` matches, which the owner must not promote on thin
 * evidence. There is no preferred `n` here: the owner reads the breaks and rules.
 */
export function promotionCandidates(
  fit: Fit,
  played: Record<string, number>,
  minMatches: number,
): { ranked: Candidate[]; breaks: number[]; underplayed: string[] } {
  const ranked: Candidate[] = Object.keys(fit.scores)
    .map((id) => {
      const score = fit.scores[id]!;
      return {
        id,
        score,
        lower: fit.lower[id] ?? score,
        upper: fit.upper[id] ?? score,
        matches: played[id] ?? 0,
      };
    })
    .sort((x, y) => {
      const gap = y.score - x.score;
      if (gap !== 0) return gap;
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
    });

  const breaks: number[] = [];
  for (let n = 1; n < ranked.length; n++) {
    if (ranked[n - 1]!.lower > ranked[n]!.upper) breaks.push(n);
  }
  const underplayed = ranked.filter((candidate) => candidate.matches < minMatches).map((candidate) => candidate.id);
  return { ranked, breaks, underplayed };
}
