// Ratings drive two decisions: Elo schedules the next matches, and a
// Bradley-Terry fit with bootstrap intervals decides promotion and stopping.
// These tests pin the arithmetic (Elo conserves the pool's total; a draw between
// equals is a no-op; K halves after five matches), then check the fit recovers a
// known ordering from a synthetic pool. The pool's outcomes are simulated with
// the seeded generator, so every number here is fixed and the test cannot flake.
import assert from "node:assert/strict";
import test from "node:test";

import {
  ELO_START,
  fitBradleyTerry,
  kFactor,
  mulberry32,
  eloUpdate,
  type Outcome,
} from "../tournament/rating.ts";

/** Competitors ordered by rank; ranks are what Spearman reads. */
function ranks(values: number[]): number[] {
  const order = values.map((value, index) => ({ value, index }));
  order.sort((x, y) => x.value - y.value);
  const result = new Array<number>(values.length).fill(0);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]!.value === order[start]!.value) end++;
    const tied = (start + end) / 2 + 1;
    for (let k = start; k <= end; k++) result[order[k]!.index] = tied;
    start = end + 1;
  }
  return result;
}

/** Spearman correlation: Pearson on ranks, ties averaged. */
function spearman(xs: number[], ys: number[]): number {
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mean = (values: number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length;
  const mx = mean(rx);
  const my = mean(ry);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < rx.length; i++) {
    const dx = rx[i]! - mx;
    const dy = ry[i]! - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  return cov / Math.sqrt(vx * vy);
}

/** An engine at every strength: what the winner's name should correlate with. */
const POOL = Array.from({ length: 12 }, (_, i) => ({ id: `e${String(i).padStart(2, "0")}`, strength: -1.65 + 0.3 * i }));

/** 600 outcomes drawn from the Bradley-Terry model the fit should recover. */
function syntheticPool(seed: number, matches: number): Outcome[] {
  const rng = mulberry32(seed);
  const outcomes: Outcome[] = [];
  for (let m = 0; m < matches; m++) {
    const a = Math.floor(rng() * POOL.length);
    let b = Math.floor(rng() * POOL.length);
    if (b === a) b = (b + 1) % POOL.length;
    const first = POOL[a]!;
    const second = POOL[b]!;
    const winA = 1 / (1 + Math.exp(-(first.strength - second.strength)));
    outcomes.push({ a: first.id, b: second.id, result: rng() < winA ? "a" : "b" });
  }
  return outcomes;
}

test("kFactor is 32 for the first five matches, then 16", () => {
  assert.equal(kFactor(0), 32);
  assert.equal(kFactor(4), 32);
  assert.equal(kFactor(5), 16);
  assert.equal(kFactor(50), 16);
});

test("eloUpdate moves the winner up and conserves the pool's total", () => {
  const [afterWin, afterLoss] = eloUpdate(ELO_START, ELO_START, "a", kFactor(0));
  assert.ok(afterWin! > ELO_START, `winner gained: ${afterWin}`);
  assert.ok(afterLoss! < ELO_START, `loser lost: ${afterLoss}`);
  assert.ok(Math.abs(afterWin! + afterLoss! - 2 * ELO_START) < 1e-9);

  // The same update read from the other side is the mirror image.
  const [bFirst, bSecond] = eloUpdate(ELO_START, ELO_START, "b", 32);
  assert.ok(bFirst! < ELO_START);
  assert.ok(bSecond! > ELO_START);
});

test("a draw between equals changes nothing, and a draw between unequals splits", () => {
  assert.deepEqual(eloUpdate(ELO_START, ELO_START, "draw", 32), [ELO_START, ELO_START]);

  const [lower, higher] = eloUpdate(1200, 1400, "draw", 16);
  assert.ok(lower! > 1200, `underdog gained: ${lower}`);
  assert.ok(higher! < 1400, `favourite lost: ${higher}`);
  assert.ok(Math.abs(lower! + higher! - 2600) < 1e-9);
});

test("mulberry32 is seeded: the same seed replays and different seeds differ", () => {
  const first = mulberry32(1);
  const again = mulberry32(1);
  const other = mulberry32(2);
  const series = Array.from({ length: 8 }, () => first());
  for (const value of series) assert.ok(value >= 0 && value < 1, `in [0, 1): ${value}`);
  assert.deepEqual(
    series,
    Array.from({ length: 8 }, () => again()),
  );
  assert.notDeepEqual(series, Array.from({ length: 8 }, () => other()));
});

test("fitBradleyTerry recovers a synthetic pool's ordering with usable intervals", () => {
  const outcomes = syntheticPool(1, 600);
  const fit = fitBradleyTerry(outcomes, { seed: 7, bootstrap: 100 });
  const ids = POOL.map((entry) => entry.id);
  for (const id of ids) {
    assert.ok(Number.isFinite(fit.scores[id]), `${id} has a finite score`);
    assert.ok(fit.lower[id]! <= fit.scores[id]! + 1e-12, `${id} lower bound`);
    assert.ok(fit.upper[id]! >= fit.scores[id]! - 1e-12, `${id} upper bound`);
  }

  // An interval that is empty or absurdly wide would make the coverage check
  // below pass for the wrong reason, so width gets checked on its own.
  const widths = ids.map((id) => fit.upper[id]! - fit.lower[id]!);
  assert.ok(widths.every((width) => Number.isFinite(width)), "every interval is finite");
  const informative = widths.filter((width) => width > 0).length;
  assert.ok(informative >= 10, `intervals have width for ${informative} of ${ids.length} entrants`);
  const widest = Math.max(...widths);
  assert.ok(widest < 6, `widest interval ${widest.toFixed(2)} log-units stays usable`);

  const scores = ids.map((id) => fit.scores[id]!);
  assert.ok(Math.abs(scores.reduce((sum, s) => sum + s, 0)) < 1e-9, "scores are centred at mean 0");

  const truths = POOL.map((entry) => entry.strength);
  const meanTruth = truths.reduce((sum, s) => sum + s, 0) / truths.length;
  const centred = truths.map((s) => s - meanTruth);
  assert.ok(spearman(scores, truths) >= 0.9, `Spearman ${spearman(scores, truths)} on the true order`);

  const covered = ids.filter((id, i) => fit.lower[id]! <= centred[i]! && centred[i]! <= fit.upper[id]!);
  assert.ok(covered.length >= 8, `80% intervals cover ${covered.length} of ${ids.length} (need 8)`);
  const meanWidth = widths.reduce((sum, width) => sum + width, 0) / widths.length;
  assert.ok(meanWidth > 0.2 && meanWidth < 2, `mean interval width ${meanWidth.toFixed(2)} log-units`);
});

test("an all-draw schedule gives everyone the same score", () => {
  const outcomes: Outcome[] = [];
  for (let i = 0; i < 6; i++) {
    for (let j = i + 1; j < 6; j++) outcomes.push({ a: `p${i}`, b: `p${j}`, result: "draw" });
  }
  const fit = fitBradleyTerry(outcomes, { seed: 3, bootstrap: 20 });
  const scores = Object.values(fit.scores);
  assert.equal(scores.length, 6);
  const spread = Math.max(...scores) - Math.min(...scores);
  assert.ok(spread < 1e-6, `all draws are level: spread ${spread}`);
});

test("an entrant that only wins has a finite score and leads the pool", () => {
  const outcomes: Outcome[] = [];
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 4; i++) outcomes.push({ a: "ace", b: `p${i}`, result: "a" });
  }
  const fit = fitBradleyTerry(outcomes, { seed: 5, bootstrap: 20 });
  assert.ok(Number.isFinite(fit.scores.ace), `ace scores ${fit.scores.ace}`);
  assert.ok(Number.isFinite(fit.lower.ace) && Number.isFinite(fit.upper.ace));
  for (let i = 0; i < 4; i++) assert.ok(fit.scores.ace! > fit.scores[`p${i}`]!);
});

test("a draw counts half a win, not a full one", () => {
  // Same two opponents for everyone, so the ordering is decided by the win
  // total alone: X has a win and a draw, Y a win and a loss, W two wins. Half a
  // win puts X strictly between Y and W; counting a draw as a full win would
  // tie X with W, and counting it as nothing would tie X with Y.
  const outcomes: Outcome[] = [
    { a: "X", b: "P", result: "a" },
    { a: "X", b: "Q", result: "draw" },
    { a: "Y", b: "P", result: "a" },
    { a: "Q", b: "Y", result: "a" },
    { a: "W", b: "P", result: "a" },
    { a: "W", b: "Q", result: "a" },
  ];
  const fit = fitBradleyTerry(outcomes, { bootstrap: 0 });
  assert.ok(
    fit.scores.X! > fit.scores.Y!,
    `a draw beats a loss: X ${fit.scores.X} vs Y ${fit.scores.Y}`,
  );
  assert.ok(
    fit.scores.X! < fit.scores.W!,
    `a draw falls short of a win: X ${fit.scores.X} vs W ${fit.scores.W}`,
  );
});

test("the ridge shrinks the fit towards a mean opponent at a pinned value", () => {
  // 3 wins against 1: the plain MLE is ln 3, and the ridge pulls the gap in.
  const outcomes: Outcome[] = [
    { a: "x", b: "y", result: "a" },
    { a: "x", b: "y", result: "a" },
    { a: "x", b: "y", result: "a" },
    { a: "y", b: "x", result: "a" },
  ];
  const plain = fitBradleyTerry(outcomes, { bootstrap: 0, ridge: 1e-12 }).scores;
  assert.ok(
    Math.abs(plain.x! - plain.y! - Math.log(3)) < 1e-6,
    `without the ridge the gap is ln 3: got ${plain.x! - plain.y!}`,
  );

  // The pinned value is what the virtual games against a mean opponent produce;
  // dropping that denominator term moves the gap to ln 2.6 and fails here.
  const shrunk = fitBradleyTerry(outcomes, { bootstrap: 0 }).scores;
  const gap = shrunk.x! - shrunk.y!;
  assert.ok(Math.abs(gap - 1.017264) < 1e-6, `default ridge gap ${gap}`);
  assert.ok(gap < Math.log(3), `the ridge shrinks the gap: ${gap} < ${Math.log(3)}`);
});

test("fitBradleyTerry rejects an impossible level or ridge", () => {
  const outcomes: Outcome[] = [{ a: "x", b: "y", result: "a" }];
  assert.throws(() => fitBradleyTerry(outcomes, { level: 0 }), /level/);
  assert.throws(() => fitBradleyTerry(outcomes, { level: 1 }), /level/);
  assert.throws(() => fitBradleyTerry(outcomes, { level: 2 }), /level/);
  assert.throws(() => fitBradleyTerry(outcomes, { level: Number.NaN }), /level/);
  assert.throws(() => fitBradleyTerry(outcomes, { ridge: 0 }), /ridge/);
  assert.throws(() => fitBradleyTerry(outcomes, { ridge: -1 }), /ridge/);
});

test("the same outcomes and seed fit identically", () => {
  const outcomes = syntheticPool(2, 120);
  assert.deepEqual(fitBradleyTerry(outcomes), fitBradleyTerry(outcomes));
  assert.deepEqual(fitBradleyTerry(outcomes, { seed: 9 }), fitBradleyTerry(outcomes, { seed: 9 }));
});

test("an empty pool fits nothing and does not throw", () => {
  assert.deepEqual(fitBradleyTerry([]), { scores: {}, lower: {}, upper: {} });
});
