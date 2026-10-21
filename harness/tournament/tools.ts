// The Phase 2 owner's tournament tools, as functions rather than registrations.
//
// `owner-extension.ts` only registers these; everything here takes the run
// directory and its dependencies, so the rules below can be tested against a
// real temp run and a fake judge without a pi session. Two tools live here:
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
// The judge transport is injected. `owner-extension` calls with no transport and
// gets `piTransport(judgeModel)` from the run's config; tests either pass one in
// `ToolDeps` or install the module-level `setTransportForTests` hook (which the
// extension then uses), so a registration test can exercise the real tool
// registrations without a model.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readConfig } from "../launch.ts";
import { findNode, listNodes, type NodeRef } from "../tree.ts";
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

/**
 * The injected seams. `transport` is the judge; tests pass a fake. `budgetMs` and
 * `bootstrap` exist so a test can make a real round cheap: production uses the
 * 8-minute budget and the engine's 200 bootstrap resamples. `now` is reserved for
 * callers that need a deterministic clock.
 */
export interface ToolDeps {
  transport?: Transport;
  now?: () => number;
  budgetMs?: number;
  bootstrap?: number;
}

let testTransport: Transport | undefined;

/**
 * Install the transport the extension's tools should use instead of
 * `piTransport(judgeModel)`. Tests call it with a fake and clear it afterwards.
 * It only affects the extension path; a caller passing `ToolDeps.transport`
 * always wins.
 */
export function setTransportForTests(transport: Transport | undefined): void {
  testTransport = transport;
}

function transportFor(runDir: string, deps: ToolDeps): Transport {
  if (deps.transport !== undefined) return deps.transport;
  if (testTransport !== undefined) return testTransport;
  const config = readConfig(runDir);
  return piTransport(config.judgeModel ?? config.model);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One stored `round-<n>.json`, validated enough that the tools can read it. */
interface StoredRound {
  round: number;
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
  const { round, matches, fit, top, played } = parsed as Partial<StoredRound>;
  if (typeof round !== "number" || !Array.isArray(matches)) {
    throw new Error(`${tool}: ${file} is not a round object with a round number and matches`);
  }
  return {
    round,
    matches,
    fit: (fit ?? { scores: {}, lower: {}, upper: {} }) as Fit,
    top: Array.isArray(top) ? top : [],
    played: (played ?? {}) as Record<string, number>,
  };
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
  const candidates = promotionCandidates(result.fit, result.played, MIN_MATCHES);
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
  const lines = [
    `COMPLETE — round ${round}`,
    `Decision: ${decisionLabel(decision)}`,
    ...(decision.stop
      ? ["STOP is final: no more evolution children may be created (tree_create with derivedFrom is refused)."]
      : []),
    `Matches played: ${result.matches.length}`,
    "Top 8 (score, 80% interval, matches):",
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
  const stop = readStop(roundsFile);
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
  if (round === 0) {
    const pool = roundZeroPool(runDir);
    sides = pool.map((puzzle) => loadEntrant(runDir, puzzle.id));
    forced = [];
  } else {
    const later = laterRoundInput(runDir, round, input);
    sides = later.ids.map((id) => loadEntrant(runDir, id));
    forced = later.forced;
  }

  mkdirSync(dir, { recursive: true });
  let result: RoundResult;
  try {
    result = await runRound({
      dir,
      round,
      sides,
      forced,
      prior: priorOutcomes(dir, round),
      transport: transportFor(runDir, deps),
      seed: 1000 + round,
      budgetMs: deps.budgetMs ?? ROUND_BUDGET_MS,
      minMatches: MIN_MATCHES,
      ...(deps.bootstrap !== undefined ? { bootstrap: deps.bootstrap } : {}),
    });
  } catch (error) {
    // RoundStuckError (the pool cannot reach the minimum) and the round lock
    // ("another round is already running") are both owner-facing refusals, not
    // crashes, so their messages become the tool error unchanged.
    if (error instanceof RoundStuckError || !(error instanceof Error)) {
      throw new Error(`judge_round: ${message(error)}`);
    }
    throw error;
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
  const decision = appendRound(roundsFile, { round, top: result.top, children });
  return completeText(round, result, decision);
}

/** `distinct.json`: which ids were checked and which duplicates the check confirmed. */
interface DistinctRecord {
  checked: string[];
  duplicates: { keep: string; drop: string }[];
}

function readDistinct(file: string): DistinctRecord {
  if (!existsSync(file)) return { checked: [], duplicates: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`check_duplicates: ${file} is not valid JSON, so the existing record cannot be extended`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`check_duplicates: ${file} is not a { checked, duplicates } object`);
  }
  const { checked, duplicates } = parsed as Partial<DistinctRecord>;
  if (!Array.isArray(checked) || !checked.every((id) => typeof id === "string")) {
    throw new Error(`check_duplicates: ${file} needs a "checked" array of ids`);
  }
  if (!Array.isArray(duplicates)) throw new Error(`check_duplicates: ${file} needs a "duplicates" array`);
  const pairs: { keep: string; drop: string }[] = [];
  for (const entry of duplicates) {
    const { keep, drop } = (entry ?? {}) as { keep?: unknown; drop?: unknown };
    if (typeof keep !== "string" || typeof drop !== "string") {
      throw new Error(`check_duplicates: ${file} has a duplicate entry without string keep/drop ids`);
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

/** The latest round's Bradley-Terry scores, refusing an id the round does not rank. */
function latestScores(dir: string, ids: string[], tool: string): Record<string, number> {
  const files = roundFiles(dir);
  const latest = files.sort((x, y) => x.round - y.round).at(-1);
  if (latest === undefined) {
    throw new Error(`${tool}: no completed round (round-<n>.json) in ${dir}; judge a round before checking duplicates`);
  }
  const stored = readStoredRound(latest.file, tool);
  const scores = stored.fit.scores ?? {};
  for (const id of ids) {
    if (typeof scores[id] !== "number") {
      throw new Error(`${tool}: ${id} has no Bradley-Terry score in ${latest.file}; judge a round that includes it first`);
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
  const key = (entry: { keep: string; drop: string }): string => `${entry.keep}\u0000${entry.drop}`;
  const byPair = new Map(existing.duplicates.map((entry) => [key(entry), entry]));
  for (const entry of confirmed) byPair.set(key(entry), entry);
  const duplicates = [...byPair.values()].sort((x, y) =>
    x.keep === y.keep ? (x.drop < y.drop ? -1 : x.drop > y.drop ? 1 : 0) : x.keep < y.keep ? -1 : 1,
  );

  writeDistinct(file, { checked, duplicates });
  const found =
    duplicates.length > 0 ? duplicates.map((entry) => `keep ${entry.keep}, drop ${entry.drop}`).join("; ") : "none";
  return `check_duplicates: checked ${ids.length} ids (${ids.join(", ")}); duplicates: ${found}`;
}
