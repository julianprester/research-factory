// Ratings for the Phase 2 tournament, in two halves.
//
// Elo is the scheduler: it is online and cheap, so pairing can read a fresh
// number after every match. It is not what promotion reads - online Elo drifts
// with the order matches are played in (Boubdir et al. 2023). Promotion and
// stopping read the Bradley-Terry fit, which uses the whole match log at once
// and carries bootstrap intervals, so a gap between two entries can be stated
// as a gap between intervals rather than as a rating difference.
//
// Draws count half a win each in both halves. The Bradley-Terry fit carries a
// ridge prior - `ridge` virtual draws against a mean opponent - so a pool where
// somebody has won everything still has a finite fit (the unregularised MLE runs
// off to infinity), and a small pool does not overfit.
//
// Scores are natural-log strengths, centred at mean 0: the model is
// P(a beats b) = sigmoid(s_a - s_b), so only differences carry meaning and the
// centre is arbitrary. `fitBradleyTerry` fixes it at 0 for reproducibility.

/** Which side of a match won; "draw" is a split verdict or an unparseable one. */
export type Result = "a" | "b" | "draw";

/** One judged match: entrant ids in the order they were shown. */
export interface Outcome {
  a: string;
  b: string;
  result: Result;
}

/** Every entrant starts here. */
export const ELO_START = 1200;

/** The Elo rating distribution the update assumes (a 400-point gap is 10:1). */
const ELO_SCALE = 400;

/**
 * The Elo step size: 32 for the first five matches, then 16. Early matches move
 * a rating a long way (few matches, little information), later ones nudge it.
 */
export function kFactor(matchesPlayed: number): number {
  return matchesPlayed < 5 ? 32 : 16;
}

/**
 * One Elo update: the winner gains exactly what the loser drops, so the pool's
 * total is conserved; a draw between equals (or any equal-expectation pair)
 * matches expectation and changes nothing. A draw between unequals moves the
 * underdog up.
 */
export function eloUpdate(ra: number, rb: number, result: Result, k: number): [number, number] {
  const expectedA = 1 / (1 + 10 ** ((rb - ra) / ELO_SCALE));
  const scoreA = result === "a" ? 1 : result === "b" ? 0 : 0.5;
  const delta = k * (scoreA - expectedA);
  return [ra + delta, rb - delta];
}

/** mulberry32: a small, well-distributed 32-bit PRNG, in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A Bradley-Terry fit: point scores and percentile bounds, all log strengths. */
export interface Fit {
  /** Natural-log strength per entrant, centred so the mean is 0. */
  scores: Record<string, number>;
  /** Lower bootstrap bound per entrant. */
  lower: Record<string, number>;
  /** Upper bootstrap bound per entrant. */
  upper: Record<string, number>;
}

export interface FitOptions {
  /** Seed for the bootstrap resampling; same seed and outcomes, same fit. */
  seed?: number;
  /** Bootstrap resamples; 0 gives point estimates as both bounds. */
  bootstrap?: number;
  /** Virtual draws against a mean opponent (log strength 0). */
  ridge?: number;
  /** Interval level: 0.8 gives the 10th and 90th percentiles. */
  level?: number;
}

const DEFAULT_SEED = 1;
const DEFAULT_BOOTSTRAP = 200;
const DEFAULT_RIDGE = 0.5;
const DEFAULT_LEVEL = 0.8;

/** MM stops when no log strength moves by more than this. */
const TOLERANCE = 1e-10;
const MAX_ITERATIONS = 1000;

/**
 * Match tallies in dense form: `wins[i]` and `games[i * n + j]`, where
 * `games[i * n + j]` counts the matches i and j played in either direction.
 * Draws contribute half a win to each side.
 */
interface Tally {
  ids: string[];
  wins: number[];
  games: number[];
}

function tally(outcomes: Outcome[]): Tally {
  const index = new Map<string, number>();
  const ids: string[] = [];
  const admit = (id: string): number => {
    const seen = index.get(id);
    if (seen !== undefined) return seen;
    const at = ids.length;
    index.set(id, at);
    ids.push(id);
    return at;
  };
  for (const outcome of outcomes) {
    admit(outcome.a);
    admit(outcome.b);
  }

  const n = ids.length;
  const wins = new Array<number>(n).fill(0);
  const games = new Array<number>(n * n).fill(0);
  for (const outcome of outcomes) {
    const a = index.get(outcome.a)!;
    const b = index.get(outcome.b)!;
    if (a === b) continue;
    games[a * n + b] += 1;
    games[b * n + a] += 1;
    if (outcome.result === "a") wins[a] += 1;
    else if (outcome.result === "b") wins[b] += 1;
    else {
      wins[a] += 0.5;
      wins[b] += 0.5;
    }
  }
  return { ids, wins, games };
}

/**
 * The MM (minorisation-maximisation) fit for one tally, in strength space:
 * p_i <- W_i / sum_j n_ij / (p_i + p_j), which never decreases the likelihood
 * and is the textbook Bradley-Terry iteration (Hunter 2004). The ridge prior
 * enters as extra wins and an extra denominator term against a strength-1
 * (log 0) opponent, which is what keeps an unbeaten entrant finite.
 *
 * Only log strengths are identifiable, so convergence is measured on the logs
 * and the answer is centred: the returned scores sum to 0. The ridge is
 * validated to be positive by the caller, so the denominator below is always
 * positive - an unbeaten entrant gets a large finite strength, not infinity.
 */
function fitTally(counts: Tally, ridge: number): Record<string, number> {
  const { ids, wins, games } = counts;
  const n = ids.length;
  const strength = new Array<number>(n).fill(1);
  const next = new Array<number>(n).fill(1);

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let biggestMove = 0;
    for (let i = 0; i < n; i++) {
      let denominator = 0;
      const row = i * n;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const played = games[row + j]!;
        if (played === 0) continue;
        denominator += played / (strength[i]! + strength[j]!);
      }
      denominator += ridge / (strength[i]! + 1);
      next[i] = (wins[i]! + ridge / 2) / denominator;
    }
    for (let i = 0; i < n; i++) {
      const move = Math.abs(Math.log(next[i]! / strength[i]!));
      if (move > biggestMove) biggestMove = move;
      strength[i] = next[i]!;
    }
    if (biggestMove < TOLERANCE) break;
  }

  const logs = strength.map((value) => Math.log(value));
  const mean = logs.reduce((sum, value) => sum + value, 0) / n;
  const scores: Record<string, number> = {};
  for (let i = 0; i < n; i++) scores[ids[i]!] = logs[i]! - mean;
  return scores;
}

/** Linear-interpolated quantile of an ascending array; q in [0, 1]. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const position = q * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const weight = position - low;
  return sorted[low]! * (1 - weight) + sorted[high]! * weight;
}

/**
 * Fit Bradley-Terry strengths to a match log, with percentile bootstrap
 * intervals. Draws count half a win each; every entrant that appears in the log
 * gets a score; the ridge prior (default 0.5 virtual draws against a mean
 * opponent) keeps unbeaten entrants finite.
 *
 * Each bootstrap resample draws `outcomes.length` matches from the log with
 * replacement using the seeded generator, refits, and the intervals are the
 * `level` percentiles of those refits, widened to include the point estimate so
 * a fit's own score never sits outside its interval. The widening can only
 * lower a lower bound and raise an upper bound, so it can hide a natural break
 * (`lower_i > upper_{i+1}`, which promotion reads) but never invent one: the
 * fit errs towards saying less than the data does.
 *
 * `level` outside (0, 1) and `ridge` of zero or less are rejected rather than
 * silently producing NaN or infinite bounds.
 */
export function fitBradleyTerry(outcomes: Outcome[], opts: FitOptions = {}): Fit {
  const seed = opts.seed ?? DEFAULT_SEED;
  const bootstrap = opts.bootstrap ?? DEFAULT_BOOTSTRAP;
  const ridge = opts.ridge ?? DEFAULT_RIDGE;
  const level = opts.level ?? DEFAULT_LEVEL;

  if (!(level > 0 && level < 1)) {
    throw new Error(`fitBradleyTerry: level must be strictly between 0 and 1, got ${level}`);
  }
  if (!(ridge > 0)) {
    throw new Error(`fitBradleyTerry: ridge must be positive, got ${ridge}`);
  }

  const base = tally(outcomes);
  if (base.ids.length === 0) return { scores: {}, lower: {}, upper: {} };

  const scores = fitTally(base, ridge);
  const ids = base.ids;
  const replicates = new Map<string, number[]>(ids.map((id) => [id, []]));

  const rng = mulberry32(seed);
  for (let b = 0; b < bootstrap; b++) {
    const resampled: Outcome[] = [];
    for (let m = 0; m < outcomes.length; m++) resampled.push(outcomes[Math.floor(rng() * outcomes.length)]!);
    const fit = fitTally(tally(resampled), ridge);
    for (const id of ids) {
      const value = fit[id];
      if (value !== undefined) replicates.get(id)!.push(value);
    }
  }

  const tailFraction = (1 - level) / 2;
  const lower: Record<string, number> = {};
  const upper: Record<string, number> = {};
  for (const id of ids) {
    const point = scores[id]!;
    const values = replicates.get(id)!.sort((x, y) => x - y);
    if (values.length === 0) {
      lower[id] = point;
      upper[id] = point;
      continue;
    }
    lower[id] = Math.min(point, quantile(values, tailFraction));
    upper[id] = Math.max(point, quantile(values, 1 - tailFraction));
  }
  return { scores, lower, upper };
}
