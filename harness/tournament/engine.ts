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
// **Isolation (Review Focus 3).** `loadEntrant` reads exactly two files: the
// puzzle's `workspace/puzzle.md` and the parent pattern's `workspace/pattern.md`,
// and from the pattern only the four sections the judge is allowed to see. It
// never looks under `workspace/reviews/`, so no review text can reach a judge
// prompt through a Side.
//
// Elo is only ever the scheduler here; what the round reports is the
// Bradley-Terry fit over the whole match log (plus the prior rounds' outcomes),
// which does not depend on the order the log is read in.
import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
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
  const patternText = existsSync(patternFile) ? readFileSync(patternFile, "utf8") : "";
  // Only the four named sections leave the pattern card: the judge gets the
  // evidence, not the whole Phase 1 node. Nothing under workspace/reviews/ is
  // read at all - that is the isolation rule, not an afterthought.
  const evidence = EVIDENCE_SECTIONS.map((heading) => section(patternText, heading))
    .filter((part): part is string => part !== undefined)
    .join("\n\n");

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

/** A crash can leave a half-written last line; drop it before appending. */
function repairTornLine(file: string): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  if (text === "" || text.endsWith("\n")) return;
  const cut = text.lastIndexOf("\n");
  truncateSync(file, cut < 0 ? 0 : cut + 1);
}

/** The log's lines; a line that does not parse is a torn write, not a match. */
function readLog(file: string): LogLine[] {
  if (!existsSync(file)) return [];
  const lines: LogLine[] = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const line = parsed as Partial<LogLine>;
    if (typeof line.batch !== "number" || !Array.isArray(line.pair)) continue;
    const match = line.match;
    if (!match || typeof match.a !== "string" || typeof match.b !== "string") continue;
    lines.push({ batch: line.batch, pair: [line.pair[0]!, line.pair[1]!], match });
  }
  return lines;
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
 * written. A spent `budgetMs` stops new work and returns `complete: false`,
 * keeping everything already judged - a later call resumes from the log. The
 * first batch of a call always runs, so `budgetMs: 0` means "one batch at most".
 */
export async function runRound(o: RoundOptions): Promise<RoundResult> {
  const minMatches = o.minMatches ?? DEFAULT_MIN_MATCHES;
  const batchSize = o.batchSize ?? DEFAULT_BATCH_SIZE;
  const concurrency = Math.max(1, Math.floor(o.concurrency ?? DEFAULT_CONCURRENCY));
  const bootstrap = o.bootstrap ?? DEFAULT_BOOTSTRAP;
  const budgetMs = o.budgetMs ?? Number.POSITIVE_INFINITY;

  const sides = new Map(o.sides.map((side) => [side.id, side]));
  const ids = o.sides.map((side) => side.id);
  mkdirSync(o.dir, { recursive: true });
  const logFile = path.join(o.dir, `round-${o.round}.matches.jsonl`);
  const roundFile = path.join(o.dir, `round-${o.round}.json`);

  const forced: [string, string][] = o.forced.map(([a, b]) => {
    if (!sides.has(a)) throw new Error(`runRound: forced pair names unknown side ${a}`);
    if (!sides.has(b)) throw new Error(`runRound: forced pair names unknown side ${b}`);
    return [a, b];
  });

  repairTornLine(logFile);
  const entries = readLog(logFile);

  const deadline = Date.now() + budgetMs;
  const spent = (): boolean => Date.now() >= deadline;
  let batchesRun = 0;

  /** Judge `pairs` with bounded concurrency; append each match as it finishes. */
  const playBatch = async (batch: number, pairs: [string, string][]): Promise<void> => {
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        // The first batch of a call always runs (budget 0 = one batch); later
        // ones start nothing new once the budget is gone.
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
    if (derived.length === 0) break; // no unseen pair left: nothing can progress
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
    writeFileSync(roundFile, `${JSON.stringify(stored, null, 2)}\n`);
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
