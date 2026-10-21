// The Phase 2 judge: one plain model call per judgement, with no tools, no
// files and no literature search. Everything it may know is in the prompt built
// here - two anonymised puzzle cards, the Phase 1 evidence behind each, and the
// Tavory & Timmermans rubric. It never sees a review and never sees a rating, so
// the card itself must carry its best rivals and caveats (design §8).
//
// Position is a hazard: a model asked "which is better, the first or the
// second?" has a documented bias towards one slot. The engine therefore judges
// every match twice, with the cards swapped, and only an entrant that wins both
// orders wins the match. A split is a draw, so a purely positional judge can
// rank nothing. The same two-order rule decides the duplicate check: two cards
// are the same puzzle only if both orders say so.
//
// The model call is injected as `Transport`, so the engine (and these tests)
// never spawn a process. `piTransport` supplies the real one: one
// `pi --print` subprocess with tools, sessions, extensions and skills disabled.
import { execFile } from "node:child_process";

import { loadCriteria } from "./criteria.ts";
import type { Result } from "./rating.ts";

/** One model call: the prompt goes in, the model's raw answer comes out. */
export type Transport = (prompt: string) => Promise<string>;

/** One puzzle as the judge sees it: a card, its Phase 1 evidence, and an id. */
export interface Side {
  /** The entrant id. It is used to attribute the verdict, never shown to the model. */
  id: string;
  /** `workspace/puzzle.md`: the card, with its pattern, expectation and rivals. */
  card: string;
  /** The Phase 1 evidence the card rests on (Result, Verdict, Worst fits). */
  evidence: string;
}

/** One order's verdict; null means the judge named no winner (or said nothing usable). */
interface OrderVerdict {
  winner: "a" | "b" | null;
  reason: string;
}

/** A judged match: both orders and the result they agree on. */
export interface MatchRecord {
  a: string;
  b: string;
  /** `a` was shown as Puzzle 1. */
  order1: OrderVerdict;
  /** `b` was shown as Puzzle 1. */
  order2: OrderVerdict;
  /** The entrant both orders chose, else a draw. */
  result: Result;
}

interface Verdict {
  winner: 1 | 2 | 0;
  reason: string;
}

interface SameVerdict {
  same: boolean;
  reason: string;
}

/** How much of an unparseable answer to keep for the round log. */
const UNPARSEABLE_LIMIT = 500;

/** The default runner's limits: a model call may think for a while and answer at length. */
const PI_TIMEOUT_MS = 5 * 60 * 1000;
const PI_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * The prompt for one match. The two sides are labelled by position; their ids
 * are deliberately absent, so the judge cannot recognise a puzzle it has seen
 * before, and no review text can leak in through this function.
 *
 * The rubric is quoted whole, so what the judge measures is exactly what the
 * reviewers measure. The instruction not to reward length or style is explicit
 * because a card's eloquence is not one of the three criteria.
 */
export function buildJudgePrompt(first: Side, second: Side): string {
  return [
    "You are comparing two puzzle cards written in Phase 2 of an abductive research",
    "pipeline. Each card interprets a Phase 1 pattern; the evidence behind the pattern",
    "is included with the card. Decide which puzzle is stronger on the criteria below.",
    "",
    "## Puzzle 1",
    "",
    first.card,
    "",
    "**Evidence behind Puzzle 1**",
    "",
    first.evidence,
    "",
    "## Puzzle 2",
    "",
    second.card,
    "",
    "**Evidence behind Puzzle 2**",
    "",
    second.evidence,
    "",
    "## The criteria",
    "",
    loadCriteria(),
    "",
    "## How to judge",
    "",
    "Compare the two puzzles only on fit, plausibility and relevance as defined in the",
    "criteria. Do not reward length, verbosity or style: a longer or more elegant card is",
    "not thereby a better puzzle. A puzzle whose strongest rival account already explains",
    "the pattern does not fit, however well it is written.",
    "",
    "Answer with one JSON object only, and nothing else:",
    "",
    '{"winner": 1 | 2 | 0, "reason": "<one paragraph>"}',
    "",
    "Use winner 1 when Puzzle 1 is the stronger puzzle, winner 2 when Puzzle 2 is, and",
    "winner 0 when there is no clear winner. The reason is one paragraph naming the",
    "decisive criterion or defect.",
    "",
  ].join("\n");
}

/**
 * The prompt for the duplicate check. Two cards count as the same puzzle only
 * when they read the pattern the same way, deny the same assumption, and admit
 * the same kinds of explanation; wording, length and style do not change what
 * puzzle a card is.
 */
function buildSamePrompt(first: Side, second: Side): string {
  return [
    "You are deciding whether two puzzle cards are the same puzzle, not which is better.",
    "",
    "Two cards are the same puzzle only when they offer the same reading of the pattern,",
    "deny the same expectation or assumption, and admit the same kinds of explanation.",
    "Different wording, length or style does not make them different puzzles; a different",
    "reading of the pattern, a different violated expectation, or a different set of",
    "admissible explanations does.",
    "",
    "## Puzzle 1",
    "",
    first.card,
    "",
    "**Evidence behind Puzzle 1**",
    "",
    first.evidence,
    "",
    "## Puzzle 2",
    "",
    second.card,
    "",
    "**Evidence behind Puzzle 2**",
    "",
    second.evidence,
    "",
    "Answer with one JSON object only, and nothing else:",
    "",
    '{"same": true | false, "reason": "<one paragraph>"}',
    "",
  ].join("\n");
}

/**
 * The first JSON object in free text, or null. Models wrap their answer in
 * prose or a fenced block, so the parser scans for balanced braces (respecting
 * strings) and tries each candidate until one is a well-formed verdict. A
 * candidate with the wrong shape is skipped, not accepted by accident; prose
 * braces such as `{fit, plausibility}` fail to parse and are skipped too.
 */
export function parseVerdict(output: string): Verdict | null {
  for (let start = output.indexOf("{"); start >= 0; start = output.indexOf("{", start + 1)) {
    const end = matchingBrace(output, start);
    if (end < 0) continue;
    const parsed = parseObject(output.slice(start, end + 1));
    if (parsed === null) continue;
    const winner = parsed.winner;
    if (winner !== 0 && winner !== 1 && winner !== 2) continue;
    if (parsed.reason !== undefined && typeof parsed.reason !== "string") continue;
    return { winner, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
  }
  return null;
}

/** The first `{"same": ...}` object in free text, or null. */
function parseSame(output: string): SameVerdict | null {
  for (let start = output.indexOf("{"); start >= 0; start = output.indexOf("{", start + 1)) {
    const end = matchingBrace(output, start);
    if (end < 0) continue;
    const parsed = parseObject(output.slice(start, end + 1));
    if (parsed === null) continue;
    if (typeof parsed.same !== "boolean") continue;
    return { same: parsed.same, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
  }
  return null;
}

/** JSON.parse as a plain object, or null if it is not one. */
function parseObject(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/** The index of the brace closing the one at `start`, skipping braces inside strings. */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const character = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth++;
    else if (character === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Ask once; if the answer is unparseable, ask once more. The brief allows one
 * retry because a truncated or chatty answer is not evidence about the puzzles.
 * A second failure is recorded as no winner, with the raw text kept short for
 * the round log.
 */
async function askVerdict(prompt: string, transport: Transport): Promise<Verdict | { unparseable: string }> {
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    last = await transport(prompt);
    const parsed = parseVerdict(last);
    if (parsed !== null) return parsed;
  }
  return { unparseable: last.trim().slice(0, UNPARSEABLE_LIMIT) };
}

/** One order: its prompt's verdict mapped back onto the entrant ids. */
async function judgeOrder(
  prompt: string,
  transport: Transport,
  firstEntrant: "a" | "b",
  secondEntrant: "a" | "b",
): Promise<OrderVerdict> {
  const verdict = await askVerdict(prompt, transport);
  if ("unparseable" in verdict) {
    return { winner: null, reason: `unparseable judge answer after one retry: ${verdict.unparseable}` };
  }
  if (verdict.winner === 0) return { winner: null, reason: verdict.reason };
  return { winner: verdict.winner === 1 ? firstEntrant : secondEntrant, reason: verdict.reason };
}

/**
 * Judge one match in both orders and return the record. `a` is Puzzle 1 in
 * order 1, `b` is Puzzle 1 in order 2. An entrant wins only by winning both
 * orders; a split, or a judge that names no winner in either order, is a draw.
 */
export async function judgeMatch(a: Side, b: Side, transport: Transport): Promise<MatchRecord> {
  const order1 = await judgeOrder(buildJudgePrompt(a, b), transport, "a", "b");
  const order2 = await judgeOrder(buildJudgePrompt(b, a), transport, "b", "a");
  const result: Result = order1.winner !== null && order1.winner === order2.winner ? order1.winner : "draw";
  return { a: a.id, b: b.id, order1, order2, result };
}

/**
 * The light distinctness check: are these two cards the same puzzle? Asked in
 * both orders, and only a pair of yeses counts - an order-sensitive answer is
 * treated as an unconfirmed duplicate, so the top set is not pruned on a coin
 * flip. Both orders' reasons are returned for the record.
 */
export async function judgeSame(a: Side, b: Side, transport: Transport): Promise<{ same: boolean; reasons: string[] }> {
  const first = parseSame(await transport(buildSamePrompt(a, b)));
  const second = parseSame(await transport(buildSamePrompt(b, a)));
  const firstVerdict = first ?? { same: false, reason: "unparseable judge answer" };
  const secondVerdict = second ?? { same: false, reason: "unparseable judge answer" };
  return { same: firstVerdict.same && secondVerdict.same, reasons: [firstVerdict.reason, secondVerdict.reason] };
}

/** The real transport's runner: one `pi` process, async, bounded. */
function runPi(args: string[], _input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("pi", args, { timeout: PI_TIMEOUT_MS, maxBuffer: PI_MAX_BUFFER }, (error, stdout, stderr) => {
      if (error) {
        const detail = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim() : error.message;
        reject(new Error(`pi judge call failed: ${detail}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * The real model call: `pi -p --no-session --no-tools --no-extensions
 * --no-skills --model <model> <prompt>`. Tools, sessions, extensions and skills
 * are off so the judge cannot read a file, run a search, or pick up a
 * repository instruction; it sees only the prompt. The process runner is
 * injectable so the argv can be tested without spawning `pi`.
 */
export function piTransport(
  model: string,
  run: (args: string[], input?: string) => Promise<string> = runPi,
): Transport {
  return (prompt) => run(["-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--model", model, prompt]);
}
