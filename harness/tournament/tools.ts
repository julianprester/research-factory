// The Phase 2 owner's tournament tools, as functions rather than registrations.
//
// `owner-extension.ts` only registers these; everything here takes the run
// directory and its dependencies, so the rules below can be tested against a
// real temp run and a fake judge without a pi session. Three tools live here:
//
// **`judgeRound`** is the pool barrier plus the round runner. Round 0 refuses
// until every Phase 2 puzzle is `submitted` with its card and its merged review
// (design §5.1: the ranking runs only once the pool is closed; a `parked` puzzle
// is outside it), and refuses a pool too small for six matches each instead of
// letting the engine live-lock. Later rounds take the owner's incumbent list and
// the child/parent pairs; the children's head-to-head against their parent is
// forced, and the stop summary records `beatParent` only when the child won both
// orders (engine `result: "a"`, because forced pairs are logged child-first).
// A partial round is not a failure: nothing is recorded and the same call resumes
// from the engine's log. The same seed and the whole `sides` list are passed on
// every call for a round, because the log header fingerprints both.
//
// **`checkDuplicates`** is the light distinctness check (design §7): every pair
// of the owner's candidate ids is judged "same puzzle?" in both orders, and a
// confirmed duplicate keeps the higher Bradley-Terry score from the latest round.
// Its record, `distinct.json`, is a union with any earlier check so re-calling it
// is idempotent; the write is temp-file-and-rename so a crash cannot shred a
// record `promote` will read.
//
// **`promote`** is the code gate on leaving Phase 2 (design §9; design spec §5.2:
// promotion is never self-declared). It refuses, naming the failed gate, unless a
// STOP is recorded, the puzzle is a submitted Phase 2 puzzle ranked in the final
// round with at least six matches, it survived the distinctness check, its merged
// review has no plausibility `fails` and no blocking flag, and `check-puzzle`
// passes. A gate that cannot be read refuses too (fail closed). The owner still
// decides how many to promote; the tool only decides which are eligible.
//
// The judge transport is injected. `owner-extension` calls with no transport and
// gets `piTransport(judgeModel)` from the run's config; tests either pass one in
// `ToolDeps` or install the module-level `setTransportForTests` hook (which the
// extension then uses), so a registration test can exercise the real tool
// registrations without a model.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readConfig } from "../launch.ts";
import { findNode, listNodes, updateNode, type NodeRef } from "../tree.ts";
import { checkPuzzle } from "../tools/check-puzzle.ts";
import { loadEntrant, promotionCandidates, RoundStuckError, runRound, type RoundResult } from "./engine.ts";
import { judgeSame, piTransport, type MatchRecord, type Transport } from "./judge.ts";
import type { Fit } from "./rating.ts";
import { appendRound, readStop, type ChildOutcome, type Decision } from "./stop.ts";

/** The tournament's folder inside the run, relative to the run root. */
const TOURNAMENT = ["owners", "phase-2", "tournament"];

/** Matches every entrant must play in a round (design §7; engine default). */
const MIN_MATCHES = 6;

/** The smallest pool the barrier lets into round 0: six matches each needs seven identities. */
const MIN_POOL = 7;

/** A round's wall-clock budget; a partial result is resumed, never lost. */
const ROUND_BUDGET_MS = 8 * 60 * 1000;

/** How many duplicate-check pairs are judged at once. */
const DUPLICATE_CONCURRENCY = 4;

/** The tournament directory of a run. */
export function tournamentDir(runDir: string): string {
  return path.join(runDir, ...TOURNAMENT);
}

export interface JudgeRoundInput {
  round: number;
  pairs?: { child: string; parent: string }[];
  entrants?: string[];
}

export interface CheckDuplicatesInput {
  ids: string[];
}

export interface PromoteInput {
  nodeId: string;
  note?: string;
}

/** `promote` reads the card and its reviews; tests inject the citation runner. */
export type PromoteDeps = ToolDeps & {
  citations?: (file: string) => string[];
  /** Bounds the per-file citation check; tests pass a tiny value. See PROMOTE_CITATION_TIMEOUT_MS. */
  citationTimeoutMs?: number;
};

/**
 * The promotion path's per-file citation timeout. `check-puzzle`'s default is
 * fifteen minutes for a batch job; a promotion is one owner tool call, so it gets
 * two minutes per file and refuses on a timeout rather than stalling the session.
 */
export const PROMOTE_CITATION_TIMEOUT_MS = 120_000;

/**
 * The injected seams. `transport` is the judge; tests pass a fake. `budgetMs` and
 * `bootstrap` exist so a test can make a real round cheap: production uses the
 * 8-minute budget and the engine's 200 bootstrap resamples.
 */
export interface ToolDeps {
  transport?: Transport;
  budgetMs?: number;
  bootstrap?: number;
}

/** Builds the real transport for a model; tests replace it to observe `judgeModel`. */
type TransportFactory = (model: string) => Transport;

const defaultTransportFactory: TransportFactory = (model) => piTransport(model);

let testTransport: Transport | undefined;
let testTransportFactory: TransportFactory = defaultTransportFactory;
let testBudgetMs: number | undefined;

/**
 * Install the transport the extension's tools should use instead of building one
 * with `piTransport`. Tests call it with a fake and clear it afterwards. It only
 * affects the extension path; a caller passing `ToolDeps.transport` always wins.
 */
export function setTransportForTests(transport: Transport | undefined): void {
  testTransport = transport;
}

/**
 * Replace the transport factory (default `piTransport`). This is how a test
 * observes which model the default path passes: the run's `judgeModel`, falling
 * back to `model`. Clear it with `undefined` to restore `piTransport`.
 */
export function setTransportFactoryForTests(factory: TransportFactory | undefined): void {
  testTransportFactory = factory ?? defaultTransportFactory;
}

/**
 * Override the round budget for extension-path calls (the tool registrations do
 * not pass `ToolDeps`). Tests use 0 so a registered `judge_round` returns PARTIAL
 * after one batch instead of judging a whole round.
 */
export function setBudgetForTests(ms: number | undefined): void {
  testBudgetMs = ms;
}

function transportFor(runDir: string, deps: ToolDeps): Transport {
  if (deps.transport !== undefined) return deps.transport;
  // The hook comes before the factory on purpose: a test that installs a fake
  // must be in control even when it also spies on the factory.
  if (testTransport !== undefined) return testTransport;
  const config = readConfig(runDir);
  return testTransportFactory(config.judgeModel ?? config.model);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One tool's error text, prefixed exactly once. */
function prefixedError(tool: string, error: unknown): Error {
  const text = message(error);
  return new Error(text.startsWith(`${tool}:`) ? text : `${tool}: ${text}`);
}

/** A pair key that ignores order: two ids met or not, whichever was shown first. */
function unorderedPairKey(left: string, right: string): string {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

/**
 * The forced matches already on disk for a partial round. The engine's log
 * header fingerprints the seed and the entrant set but not the child/parent
 * pairs, so a resume with a different `pairs` list would pass the header check
 * and play a new head-to-head while the old one stayed in the log. Reading the
 * batch -1 lines lets the tool refuse that instead of recording a summary for a
 * pair the round was not started with.
 */
function loggedForcedPairs(dir: string, round: number): { child: string; parent: string }[] {
  const file = path.join(dir, `round-${round}.matches.jsonl`);
  if (!existsSync(file)) return [];
  const pairs: { child: string; parent: string }[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // a torn tail: the match it described never landed
    }
    const entry = parsed as { batch?: unknown; pair?: unknown; header?: unknown };
    if (entry.header !== undefined) continue;
    if (entry.batch !== -1 || !Array.isArray(entry.pair)) continue;
    const [child, parent] = entry.pair as unknown[];
    if (typeof child === "string" && typeof parent === "string") pairs.push({ child, parent });
  }
  return pairs;
}

/**
 * Refuse a resume whose logged forced pairs are not all in the current `forced`
 * list. A subset check, not equality: a torn forced batch (a crash mid-write)
 * resumes with the remaining pairs, and the logged ones are what the summary
 * must be computed from.
 */
function ensureForcedUnchanged(dir: string, round: number, forced: [string, string][]): void {
  const current = new Set(forced.map(([child, parent]) => `${child}\u0000${parent}`));
  for (const { child, parent } of loggedForcedPairs(dir, round)) {
    if (!current.has(`${child}\u0000${parent}`)) {
      throw new Error(
        `judge_round: round ${round} was started with child ${child} against parent ${parent}; resume with the same pairs`,
      );
    }
  }
}

/**
 * Refuse a forced pair whose two ids already met in an earlier round. The
 * head-to-head summary reads only this round's log, so an old verdict would not
 * be replayed into `beatParent`; the owner must name a pair the round will
 * actually judge.
 */
function ensurePairsNew(
  prior: { a: string; b: string; result: MatchRecord["result"] }[],
  forced: [string, string][],
): void {
  const met = new Set(prior.map((outcome) => unorderedPairKey(outcome.a, outcome.b)));
  for (const [child, parent] of forced) {
    if (met.has(unorderedPairKey(child, parent))) {
      throw new Error(
        `judge_round: child ${child} and parent ${parent} already met in an earlier round; ` +
          `their old verdict would not be replayed into this round's head-to-head`,
      );
    }
  }
}

/** One stored `round-<n>.json`, validated enough that the tools can read it. */
interface StoredRound {
  round: number;
  /** The round's participants. Older round files have none: then every fit id played. */
  sides?: string[];
  matches: MatchRecord[];
  fit: Fit;
  top: string[];
  played: Record<string, number>;
}

function readStoredRound(file: string, tool: string): StoredRound {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${tool}: ${file} is not valid JSON, so this round cannot be read`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${tool}: ${file} is not a round object`);
  }
  const { round, sides, matches, fit, top, played } = parsed as Partial<StoredRound>;
  if (typeof round !== "number" || !Array.isArray(matches)) {
    throw new Error(`${tool}: ${file} is not a round object with a round number and matches`);
  }
  return {
    round,
    ...(Array.isArray(sides) && sides.every((id) => typeof id === "string") ? { sides: sides as string[] } : {}),
    matches,
    fit: (fit ?? { scores: {}, lower: {}, upper: {} }) as Fit,
    top: Array.isArray(top) ? top : [],
    played: (played ?? {}) as Record<string, number>,
  };
}

/**
 * The round's own participants as a fit/played view. A round file written before
 * `sides` existed has no participant list; then every id in the fit counts, which
 * is exactly what those files claimed. The fit carries prior rounds' outcomes, so
 * without this filter a puzzle eliminated earlier would still look "ranked" in
 * every later round (the review's I1).
 */
function participantView(stored: StoredRound): { fit: Fit; played: Record<string, number> } {
  if (stored.sides === undefined) return { fit: stored.fit, played: stored.played };
  const keep = new Set(stored.sides);
  const pick = (values: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [id, value] of Object.entries(values)) if (keep.has(id)) out[id] = value;
    return out;
  };
  return {
    fit: { scores: pick(stored.fit.scores), lower: pick(stored.fit.lower), upper: pick(stored.fit.upper) },
    played: pick(stored.played),
  };
}

/**
 * The final round: the highest `round-<n>.json` on disk whose number `rounds.json`
 * records. The engine writes the round file before `appendRound` records it, so a
 * crash in that window leaves an orphan that is not a round anyone decided on; it
 * must not become the ranking `promote` or the distinctness check reads.
 */
function finalRound(dir: string, tool: string, none: string): { round: number; stored: StoredRound } {
  const roundsFile = path.join(dir, "rounds.json");
  const latest = roundFiles(dir).sort((left, right) => left.round - right.round).at(-1);
  if (latest === undefined) throw new Error(`${tool}: ${none}`);
  if (!recordedRounds(roundsFile).includes(latest.round)) {
    throw new Error(
      `${tool}: round ${latest.round} is on disk (${latest.file}) but not recorded in ${roundsFile}: ` +
        `an orphan round file is a crash between the round file and its record, not a final round; ` +
        `judge or remove it before relying on it`,
    );
  }
  return { round: latest.round, stored: readStoredRound(latest.file, tool) };
}

/** Every earlier round's outcomes, in round order: the fit's and ratings' prior. */
function priorOutcomes(dir: string, beforeRound: number): { a: string; b: string; result: MatchRecord["result"] }[] {
  const outcomes: { a: string; b: string; result: MatchRecord["result"] }[] = [];
  const files = roundFiles(dir).filter((entry) => entry.round < beforeRound).sort((x, y) => x.round - y.round);
  for (const entry of files) {
    const stored = readStoredRound(entry.file, "judge_round");
    for (const match of stored.matches) outcomes.push({ a: match.a, b: match.b, result: match.result });
  }
  return outcomes;
}

interface RoundFileRef {
  round: number;
  file: string;
}

/** The `round-<n>.json` files present in `dir`, in no particular order. */
function roundFiles(dir: string): RoundFileRef[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: RoundFileRef[] = [];
  for (const name of names) {
    const match = /^round-(\d+)\.json$/.exec(name);
    if (match) files.push({ round: Number(match[1]), file: path.join(dir, name) });
  }
  return files;
}

/** The round numbers recorded in `rounds.json`; a missing file has none. */
function recordedRounds(file: string): number[] {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(parsed)) return [];
  const rounds: number[] = [];
  for (const entry of parsed) {
    const round = (entry as { summary?: { round?: unknown } } | null)?.summary?.round;
    if (typeof round === "number") rounds.push(round);
  }
  return rounds;
}

/** The round whose match log exists without its `round-<n>.json`: a resumable partial round. */
function roundInProgress(dir: string): number | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  let found: number | undefined;
  for (const name of names) {
    const match = /^round-(\d+)\.matches\.jsonl$/.exec(name);
    if (!match) continue;
    const round = Number(match[1]);
    if (existsSync(path.join(dir, `round-${round}.json`))) continue;
    if (found === undefined || round > found) found = round;
  }
  return found;
}

/** The decision as the owner reads it. */
function decisionLabel(decision: Decision): string {
  return decision.stop ? `STOP (${decision.reason})` : "CONTINUE";
}

/** The Phase 2 puzzle nodes, whatever their status. */
function phase2Puzzles(runDir: string): NodeRef[] {
  return listNodes(runDir).filter((node) => node.type === "puzzle" && node.phase === 2);
}

function puzzleProblems(runDir: string, node: NodeRef): string[] {
  const problems: string[] = [];
  const dir = node.dir;
  if (!existsSync(path.join(dir, "workspace", "puzzle.md"))) problems.push(`${node.id} has no workspace/puzzle.md`);
  if (!existsSync(path.join(dir, "workspace", "reviews", "merged.json"))) {
    problems.push(`${node.id} has no workspace/reviews/merged.json`);
  }
  return problems;
}

/**
 * A puzzle id the owner named as an entrant or a child: a node of this run, a
 * puzzle in Phase 2, `submitted`, with its card and merged review. The refusal
 * names the id, what it is, and the file it lacks, because the owner has to fix
 * it in the tree.
 */
function namedPuzzle(runDir: string, id: string, role: string, tool: string): NodeRef {
  let node: NodeRef;
  try {
    node = findNode(runDir, id);
  } catch {
    throw new Error(`${tool}: ${role} ${id} is not a node in this run`);
  }
  if (node.type !== "puzzle") throw new Error(`${tool}: ${role} ${id} is a ${node.type} node, not a puzzle`);
  if (node.phase !== 2) throw new Error(`${tool}: ${role} ${id} is in phase ${node.phase}, not phase 2`);
  if (node.status !== "submitted") throw new Error(`${tool}: ${role} ${id} is ${node.status}, not submitted`);
  const problems = puzzleProblems(runDir, node);
  if (problems.length > 0) throw new Error(`${tool}: ${role} ${id} is not ready for a round: ${problems.join("; ")}`);
  return node;
}

/** The round-0 pool: every submitted Phase 2 puzzle, or a refusal naming what blocks it. */
function roundZeroPool(runDir: string): NodeRef[] {
  const puzzles = phase2Puzzles(runDir);
  const problems: string[] = [];
  for (const puzzle of puzzles) {
    if (puzzle.status === "ready" || puzzle.status === "active") {
      problems.push(`${puzzle.id} is ${puzzle.status}`);
    }
  }
  const pool = puzzles.filter((puzzle) => puzzle.status === "submitted");
  for (const puzzle of pool) problems.push(...puzzleProblems(runDir, puzzle));

  if (problems.length > 0) {
    throw new Error(
      `judge_round: round 0 cannot start, the puzzle pool is not closed: ${problems.join("; ")}. ` +
        `Every Phase 2 puzzle must be submitted with workspace/puzzle.md and workspace/reviews/merged.json; ` +
        `park the puzzles that are outside the pool.`,
    );
  }
  if (pool.length < MIN_POOL) {
    throw new Error(
      `judge_round: round 0 needs at least ${MIN_POOL} submitted puzzles (each entrant plays ${MIN_MATCHES} matches), ` +
        `found ${pool.length}`,
    );
  }
  return pool;
}

/** Validate a later round's entrants and pairs and return the sides and forced matches. */
function laterRoundInput(
  runDir: string,
  round: number,
  input: JudgeRoundInput,
): { ids: string[]; forced: [string, string][] } {
  if (!Array.isArray(input.entrants) || input.entrants.length === 0) {
    throw new Error(`judge_round: round ${round} needs entrants (the incumbent puzzle ids)`);
  }
  if (!Array.isArray(input.pairs)) {
    throw new Error(`judge_round: round ${round} needs pairs (each child and its parent)`);
  }
  if (input.pairs.length === 0) {
    throw new Error(
      `judge_round: round ${round} needs at least one child/parent pair; a round without children latches STOP`,
    );
  }

  const entrants = [...new Set(input.entrants)];
  for (const id of entrants) namedPuzzle(runDir, id, "entrant", "judge_round");
  const entrantSet = new Set(entrants);

  const forced: [string, string][] = [];
  const seen = new Set<string>();
  const children: string[] = [];
  for (const [index, pair] of input.pairs.entries()) {
    if (pair === null || typeof pair !== "object" || typeof pair.child !== "string" || typeof pair.parent !== "string") {
      throw new Error(`judge_round: pairs[${index}] needs a child and a parent id`);
    }
    const child = namedPuzzle(runDir, pair.child, "child", "judge_round");
    if (!entrantSet.has(pair.parent)) {
      throw new Error(`judge_round: child ${child.id}'s parent ${pair.parent} is not among the entrants`);
    }
    const derived = child.derivedFrom ?? [];
    if (!derived.includes(pair.parent)) {
      throw new Error(
        `judge_round: child ${child.id} does not list its parent ${pair.parent} in derivedFrom ` +
          `(got ${derived.length === 0 ? "none" : derived.join(", ")})`,
      );
    }
    const key = `${child.id}\u0000${pair.parent}`;
    if (seen.has(key)) continue;
    seen.add(key);
    children.push(child.id);
    forced.push([child.id, pair.parent]);
  }

  const ids = [...new Set([...entrants, ...children])].sort();
  return { ids, forced };
}

/** The text for a completed round: decision, top eight with intervals, promotion breaks. */
function completeText(round: number, result: RoundResult, decision: Decision): string {
  // Only this round's participants are candidates: the fit also carries prior
  // rounds' outcomes, and a puzzle eliminated earlier is not in this ranking.
  const view = participantView({ fit: result.fit, played: result.played, ...(result.sides.length > 0 ? { sides: result.sides } : {}) });
  const candidates = promotionCandidates(view.fit, view.played, MIN_MATCHES);
  const top = candidates.ranked
    .slice(0, 8)
    .map(
      (candidate, index) =>
        `${index + 1}. ${candidate.id} ${candidate.score.toFixed(3)} ` +
        `[${candidate.lower.toFixed(3)}, ${candidate.upper.toFixed(3)}] (${candidate.matches} matches)`,
    );
  const breaks =
    candidates.breaks.length > 0
      ? candidates.breaks.map((n) => `after rank ${n}`).join(", ")
      : "none (no interval gap separates the top from the rest)";
  const shown = Math.min(8, candidates.ranked.length);
  const lines = [
    `COMPLETE — round ${round}`,
    `Decision: ${decisionLabel(decision)}`,
    ...(decision.stop
      ? ["STOP is final: no more evolution children may be created (tree_create with derivedFrom is refused)."]
      : []),
    `Matches played: ${result.matches.length}`,
    `Top ${shown} (score, 80% interval, matches):`,
    ...top,
    `Promotion breaks (promoting the top n leaves an interval gap): ${breaks}`,
    `Underplayed (<${MIN_MATCHES} matches): ${candidates.underplayed.length > 0 ? candidates.underplayed.join(", ") : "none"}`,
  ];
  return lines.join("\n");
}

/**
 * Judge one round, resumably. Every refusal is an `Error` whose message is the
 * text the owner sees; the extension lets it become a tool error. A round that
 * the engine could not finish is `PARTIAL` text, not an error: the same call
 * resumes it and no state is recorded until it completes.
 */
export async function judgeRound(runDir: string, input: JudgeRoundInput, deps: ToolDeps = {}): Promise<string> {
  const dir = tournamentDir(runDir);
  const roundsFile = path.join(dir, "rounds.json");
  const round = input.round;

  // In this order: a recorded STOP closes the loop whatever round is asked for;
  // then the round number must be the next one (or the resumable partial one).
  let stop: Decision;
  try {
    stop = readStop(roundsFile);
  } catch (error) {
    throw prefixedError("judge_round", error);
  }
  if (stop.stop) throw new Error(`judge_round: STOP already recorded (${stop.reason}): no more rounds`);
  if (!Number.isInteger(round) || round < 0) {
    throw new Error(`judge_round: round must be a whole number >= 0, got ${JSON.stringify(round)}`);
  }

  const recorded = recordedRounds(roundsFile);
  const expected = recorded.length === 0 ? 0 : Math.max(...recorded) + 1;
  const inProgress = roundInProgress(dir);
  if (round !== expected && round !== inProgress) {
    const resumable =
      inProgress !== undefined ? ` (round ${inProgress} is in progress: call judge_round with the same arguments to resume)` : "";
    throw new Error(`judge_round: round ${round} cannot start; expected round ${expected}${resumable}`);
  }

  let sides;
  let forced: [string, string][];
  // A missing card or a pattern with no evidence is an owner-facing refusal like
  // every other: `loadEntrant`'s error must carry the tool prefix too.
  try {
    if (round === 0) {
      const pool = roundZeroPool(runDir);
      sides = pool.map((puzzle) => loadEntrant(runDir, puzzle.id));
      forced = [];
    } else {
      const later = laterRoundInput(runDir, round, input);
      sides = later.ids.map((id) => loadEntrant(runDir, id));
      forced = later.forced;
    }
  } catch (error) {
    throw prefixedError("judge_round", error);
  }

  const prior = priorOutcomes(dir, round);
  ensureForcedUnchanged(dir, round, forced);
  ensurePairsNew(prior, forced);

  mkdirSync(dir, { recursive: true });
  let result: RoundResult;
  try {
    result = await runRound({
      dir,
      round,
      sides,
      forced,
      prior,
      transport: transportFor(runDir, deps),
      seed: 1000 + round,
      budgetMs: deps.budgetMs ?? testBudgetMs ?? ROUND_BUDGET_MS,
      minMatches: MIN_MATCHES,
      ...(deps.bootstrap !== undefined ? { bootstrap: deps.bootstrap } : {}),
    });
  } catch (error) {
    // Every engine failure is an owner-facing refusal, not a crash: a stuck pool
    // (RoundStuckError), a log fingerprint mismatch, and a held round lock all
    // become one clear tool error with the tool's prefix.
    throw prefixedError("judge_round", error);
  }

  if (!result.complete) {
    return (
      `PARTIAL — call judge_round again with the same arguments to resume. ` +
      `Round ${round} is not complete. Matches played so far: ${result.matches.length} over ${sides.length} entrants; nothing was recorded.`
    );
  }

  const pairOutcome = (child: string, parent: string): ChildOutcome => ({
    child,
    parent,
    // Forced matches are logged with the child as `a`; `beatParent` is a win in
    // both orders, which the engine records as result "a". A split is a draw.
    beatParent: result.matches.some((match) => match.a === child && match.b === parent && match.result === "a"),
  });
  const children = forced.map(([child, parent]) => pairOutcome(child, parent));
  let decision: Decision;
  try {
    decision = appendRound(roundsFile, { round, top: result.top, children });
  } catch (error) {
    throw prefixedError("judge_round", error);
  }
  return completeText(round, result, decision);
}

/** `distinct.json`: which ids were checked and which duplicates the check confirmed. */
interface DistinctRecord {
  checked: string[];
  duplicates: { keep: string; drop: string }[];
}

function readDistinct(file: string, tool = "check_duplicates"): DistinctRecord {
  if (!existsSync(file)) return { checked: [], duplicates: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${tool}: ${file} is not valid JSON, so the existing record cannot be read`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${tool}: ${file} is not a { checked, duplicates } object`);
  }
  const { checked, duplicates } = parsed as Partial<DistinctRecord>;
  if (!Array.isArray(checked) || !checked.every((id) => typeof id === "string")) {
    throw new Error(`${tool}: ${file} needs a "checked" array of ids`);
  }
  if (!Array.isArray(duplicates)) throw new Error(`${tool}: ${file} needs a "duplicates" array`);
  const pairs: { keep: string; drop: string }[] = [];
  for (const entry of duplicates) {
    const { keep, drop } = (entry ?? {}) as { keep?: unknown; drop?: unknown };
    if (typeof keep !== "string" || typeof drop !== "string") {
      throw new Error(`${tool}: ${file} has a duplicate entry without string keep/drop ids`);
    }
    pairs.push({ keep, drop });
  }
  return { checked, duplicates: pairs };
}

/** Atomic write: a crash leaves the previous record, never half a JSON file. */
function writeDistinct(file: string, record: DistinctRecord): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temp, file);
}

/** The latest recorded round's Bradley-Terry scores, refusing an id it did not rank. */
function latestScores(dir: string, ids: string[], tool: string): Record<string, number> {
  const { round, stored } = finalRound(dir, tool, `no completed round (round-<n>.json) in ${dir}; judge a round before checking duplicates`);
  const scores = participantView(stored).fit.scores ?? {};
  for (const id of ids) {
    if (typeof scores[id] !== "number") {
      throw new Error(
        `${tool}: ${id} is not ranked in the final round (round ${round}); only that round's participants are, ` +
          `judge a round that includes it first`,
      );
    }
  }
  return scores;
}

/** The higher-rated id wins; an exact tie keeps the lexicographically smaller id. */
function keeper(scores: Record<string, number>, left: string, right: string): { keep: string; drop: string } {
  const leftScore = scores[left]!;
  const rightScore = scores[right]!;
  if (leftScore === rightScore) return left < right ? { keep: left, drop: right } : { keep: right, drop: left };
  return leftScore > rightScore ? { keep: left, drop: right } : { keep: right, drop: left };
}

/**
 * Judge every pair among `ids` for sameness and record the confirmed duplicates.
 * The result is the union with any earlier `distinct.json`: re-calling the tool
 * (or checking an overlapping set) never loses an earlier finding, and never
 * adds the same duplicate twice. A dropped id may still be a keeper in another
 * pair - evolution children resemble their parents, and the record says which
 * one each pair keeps.
 */
export async function checkDuplicates(
  runDir: string,
  input: CheckDuplicatesInput,
  deps: ToolDeps = {},
): Promise<string> {
  const ids = [...new Set(Array.isArray(input.ids) ? input.ids : [])].sort();
  if (ids.length < 2) throw new Error("check_duplicates: needs at least 2 distinct puzzle ids to compare");

  const dir = tournamentDir(runDir);
  // Card and scores are checked before any judge call: a bad id should cost no
  // model call at all.
  for (const id of ids) {
    let node: NodeRef;
    try {
      node = findNode(runDir, id);
    } catch {
      throw new Error(`check_duplicates: ${id} is not a node in this run`);
    }
    if (node.type !== "puzzle") throw new Error(`check_duplicates: ${id} is a ${node.type} node, not a puzzle`);
    if (!existsSync(path.join(node.dir, "workspace", "puzzle.md"))) {
      throw new Error(`check_duplicates: ${id} has no workspace/puzzle.md`);
    }
  }
  const scores = latestScores(dir, ids, "check_duplicates");

  const sides = new Map(ids.map((id) => [id, loadEntrant(runDir, id)]));
  const pairs: [string, string][] = [];
  for (let left = 0; left < ids.length; left++) {
    for (let right = left + 1; right < ids.length; right++) pairs.push([ids[left]!, ids[right]!]);
  }

  const transport = transportFor(runDir, deps);
  const confirmed: { keep: string; drop: string }[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= pairs.length) return;
      const [left, right] = pairs[index]!;
      const verdict = await judgeSame(sides.get(left)!, sides.get(right)!, transport);
      if (verdict.same) confirmed.push(keeper(scores, left, right));
    }
  };
  await Promise.all(Array.from({ length: Math.min(DUPLICATE_CONCURRENCY, pairs.length) }, worker));

  const file = path.join(dir, "distinct.json");
  const existing = readDistinct(file);
  const checked = [...new Set([...existing.checked, ...ids])].sort();
  // Union on the UNORDERED pair: a re-check after a ranking flip replaces the
  // old orientation with the fresh verdict, so the record never carries both
  // `keep A, drop B` and `keep B, drop A` for the same two ids. Pairs not judged
  // this time keep their earlier entries.
  const judged = new Set(pairs.map(([left, right]) => unorderedPairKey(left, right)));
  const kept = existing.duplicates.filter((entry) => !judged.has(unorderedPairKey(entry.keep, entry.drop)));
  const duplicates = [...kept, ...confirmed].sort((x, y) =>
    x.keep === y.keep ? (x.drop < y.drop ? -1 : x.drop > y.drop ? 1 : 0) : x.keep < y.keep ? -1 : 1,
  );

  writeDistinct(file, { checked, duplicates });
  const found =
    duplicates.length > 0 ? duplicates.map((entry) => `keep ${entry.keep}, drop ${entry.drop}`).join("; ") : "none";
  return `check_duplicates: checked ${ids.length} ids (${ids.join(", ")}); duplicates: ${found}`;
}

/** The merged review's blocking flags: each must be present and false to promote. */
const MERGED_FLAGS = ["breakdown", "knownResultBlocking", "dataCharacterViolated", "reviewBlocked"] as const;

/**
 * The merged review's problems for promotion in a fixed order, or [] when it is
 * clean. A field that is missing is a problem, not a silence: a review the gate
 * cannot read completely must not open the gate.
 */
function mergedReviewProblems(id: string, nodeDir: string): string[] {
  const file = path.join(nodeDir, "workspace", "reviews", "merged.json");
  if (!existsSync(file)) return [`${id} has no workspace/reviews/merged.json`];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [`${id}'s merged.json is not valid JSON`];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [`${id}'s merged.json is not an object`];
  }
  const problems: string[] = [];
  const { criteria, flags } = parsed as { criteria?: unknown; flags?: unknown };
  const plausibility =
    criteria !== null && typeof criteria === "object"
      ? ((criteria as { plausibility?: unknown }).plausibility as { rating?: unknown } | undefined)?.rating
      : undefined;
  if (typeof plausibility !== "string") {
    problems.push(`${id}'s merged review has no plausibility rating (fail closed)`);
  } else if (plausibility === "fails") {
    problems.push(`${id}'s merged review rates plausibility fails; a failed puzzle cannot be promoted`);
  }
  if (flags === null || typeof flags !== "object" || Array.isArray(flags)) {
    problems.push(`${id}'s merged review has no flags object (fail closed)`);
    return problems;
  }
  for (const flag of MERGED_FLAGS) {
    const value = (flags as Record<string, unknown>)[flag];
    if (value === undefined) {
      problems.push(`${id}'s merged review has no ${flag} flag (fail closed)`);
    } else if (value !== false) {
      problems.push(`${id}'s merged review sets ${flag} to ${JSON.stringify(value)}; promotion needs it false`);
    }
  }
  return problems;
}

/**
 * Promote one puzzle to Phase 3, through every gate or not at all.
 *
 * The gates are design §9's list, checked in the order that costs least and fails
 * most plainly: the recorded STOP, the node (a submitted Phase 2 puzzle that is
 * not already promoted), the final round's candidate list and match count, the
 * distinctness record, the merged review, and `check-puzzle --reviews`. Each
 * refusal names the gate and the fact that failed it, so the owner can fix the
 * tree or the round rather than guess. Every gate is read fail-closed: an
 * unreadable STOP record, round file or distinct.json is a refusal, never a pass.
 *
 * Promotion is a tree commit by `owner-p2` with the owner's note, because the
 * note is the record of why this one and not another. The tool does not read the
 * owner's promotion `Ruling:`: the owner decides how many to promote, and the
 * return text reminds it to record that ruling and park the rest.
 */
export async function promote(runDir: string, input: PromoteInput, deps: PromoteDeps = {}): Promise<string> {
  const dir = tournamentDir(runDir);
  const id = input?.nodeId;
  if (typeof id !== "string" || id === "") throw new Error("promote: needs a nodeId");

  let node: NodeRef;
  try {
    node = findNode(runDir, id);
  } catch {
    throw new Error(`promote: ${id} is not a node in this run`);
  }
  if (node.type !== "puzzle") throw new Error(`promote: ${id} is a ${node.type} node, not a puzzle`);
  if (node.phase === 3) {
    throw new Error(`promote: ${id} is already in phase 3 (${node.status}); a puzzle is promoted once`);
  }

  // Gate 1: the loop must have stopped, and the record must say so readably.
  const roundsFile = path.join(dir, "rounds.json");
  let stop: Decision;
  try {
    stop = readStop(roundsFile);
  } catch (error) {
    throw new Error(`promote: STOP record unreadable: ${message(error)}`);
  }
  if (!stop.stop) {
    throw new Error(
      `promote: no STOP recorded in ${roundsFile}: promotion waits for the final round's STOP decision`,
    );
  }

  // Gate 2: the pool barrier's successor state.
  if (node.phase !== 2) throw new Error(`promote: ${id} is in phase ${node.phase}, not phase 2`);
  if (node.status !== "submitted") throw new Error(`promote: ${id} is ${node.status}, not submitted`);

  // Gate 3: the final round's candidate list, with enough matches to mean it.
  // The final round is the highest round FILE whose number the record holds; its
  // candidates are its participants only, because the fit also carries prior rounds.
  const final = finalRound(dir, "promote", `no completed round (round-<n>.json) in ${dir}, so there is no final ranking`);
  const view = participantView(final.stored);
  const candidates = promotionCandidates(view.fit, view.played, MIN_MATCHES);
  const rank = candidates.ranked.findIndex((candidate) => candidate.id === id);
  if (rank < 0) throw new Error(`promote: ${id} is not ranked in the final round (round ${final.round})`);
  const candidate = candidates.ranked[rank]!;
  if (candidate.matches < MIN_MATCHES) {
    throw new Error(
      `promote: ${id} played ${candidate.matches} matches in the final round, fewer than the ${MIN_MATCHES} promotion needs`,
    );
  }

  // Gate 4: the distinctness check saw it and did not drop it.
  const distinctFile = path.join(dir, "distinct.json");
  if (!existsSync(distinctFile)) {
    throw new Error(`promote: ${id} is not distinct-checked: ${distinctFile} does not exist, run check_duplicates first`);
  }
  const distinct = readDistinct(distinctFile, "promote");
  if (!distinct.checked.includes(id)) {
    throw new Error(`promote: ${id} is not in ${distinctFile}'s checked list; run check_duplicates on it`);
  }
  const dropped = distinct.duplicates.find((entry) => entry.drop === id);
  if (dropped !== undefined) {
    throw new Error(
      `promote: ${id} is the drop of a confirmed duplicate of ${dropped.keep}; promote the keeper instead`,
    );
  }

  // Gate 5: the merged review has no blocking finding.
  const reviewProblems = mergedReviewProblems(id, node.dir);
  if (reviewProblems.length > 0) throw new Error(`promote: ${reviewProblems.join("; ")}`);

  // Gate 6: the deterministic card/review check, with its real citation runner
  // unless a caller injected one. Promotion caps each file's citation check at
  // two minutes instead of the batch default.
  let problems: string[];
  try {
    problems = checkPuzzle(runDir, node.dir, {
      reviews: true,
      citationTimeoutMs: deps.citationTimeoutMs ?? PROMOTE_CITATION_TIMEOUT_MS,
      ...(deps.citations !== undefined ? { citations: deps.citations } : {}),
    }).problems;
  } catch (error) {
    throw prefixedError("promote", error);
  }
  if (problems.length > 0) throw new Error(`promote: ${id} fails check-puzzle: ${problems.join("; ")}`);

  try {
    updateNode(runDir, id, { phase: 3, status: "ready" }, "owner-p2", input.note);
  } catch (error) {
    throw prefixedError("promote", error);
  }

  return [
    `promoted ${id} to phase 3 (rank ${rank + 1} of ${candidates.ranked.length}, score ${candidate.score.toFixed(3)}, ` +
      `80% interval [${candidate.lower.toFixed(3)}, ${candidate.upper.toFixed(3)}])`,
    "Record the promotion Ruling in your ledger (the code gates each puzzle; you decide how many), and park every puzzle you did not promote.",
  ].join("\n");
}
