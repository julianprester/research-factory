// Mechanical merge of a puzzle's two independent reviews.
//
// Two `ctc-reviewer` workers review a puzzle without seeing each other's file
// (the reviewer guard enforces it), and the owner reads only the merge. The
// merge is deterministic: for each criterion the more severe rating wins
// (`fails` > `weak` > `adequate` > `strong`), and any reviewer's flag is the
// merged flag (a `fails` plausibility is a breakdown; a `blocking` known-result
// check blocks; a `violated` data-character check is a violation). A finding
// both reviewers raise is high confidence; a finding only one raises keeps its
// reviewer tag and is single-reviewer. A review's own closing `Status` and its
// `Phase 3 must check` questions are carried into the merge: the owner must be
// able to see that one reviewer stopped early before ranking on the result.
//
// "Both reviewers raise the same finding" is not defined by the brief, so this
// file defines it: same criterion, same severity, one shared polarity, and
// similar text. Text is normalised to lower-case words (punctuation dropped,
// one-letter words and function words removed) and the two word sets are
// compared by Jaccard overlap, `|A and B| / |A or B| >= FINDING_OVERLAP` (0.5).
// Two reviewers rarely phrase a finding identically, but they reuse the
// finding's content words ("existing theory already explains the pattern" vs
// "existing theory already explains the pattern, so it is a restatement"
// overlap 5/6), while two different findings under one criterion share little ("worst
// fits are never discussed" vs "citation to the rival is the wrong chunk").
//
// Exactly one side containing `no`, `not`, `never` or `without` blocks a match,
// so "the claim is supported" and "the claim is not supported" stay two
// findings. That is a narrow guard, not a full polarity test: an evaluative
// opposite without a negation word ("the claim is supported" vs "the claim is
// rejected") still shares enough other words to merge, and the merged text is
// the `a` review's. Findings are supposed to voice problems, so this is rare;
// it is the remaining limitation of a word-overlap rule.
//
// The rule is deliberately conservative: an unmatched pair stays two
// single-reviewer findings, which understates agreement rather than inventing
// it. Matching is greedy in review order and each finding of `b` pairs at most
// once, so a duplicated finding cannot be counted twice.
//
// The review format is fixed by the Phase 2 plan (Task 10's reviewer role
// teaches it and Task 7's `check-puzzle --reviews` enforces it):
//
//   ## Fit / ## Plausibility / ## Relevance     first line `Rating: strong|adequate|weak|fails`
//   ## Data-character check                     first line `Result: ok|violated`
//   ## Known-result check                       first line `Result: ok|blocking|not-applicable`
//   ## Findings                                 lines `- [blocking|major|minor] <criterion>: <text>`
//   ## Phase 3 must check                       a list
//   last line                                   `Status: DONE|DONE_WITH_CONCERNS|BLOCKED`
//
// The parser is strict about the *content* and forgiving about the *formatting*
// a worker will produce. The seven headings must each appear exactly once (a
// missing or duplicated known heading is a problem), a rating/result/status
// value must be in its allowed set after normalising, the last non-empty line
// must be a `Status:` line, and a top-level line in `## Findings` must be a
// finding (a prose paragraph where a finding belongs is named). Otherwise it
// bends: only an exact level-2 `## ` heading starts a section, so `### …` (and
// deeper) headings are body text — inside `## Findings` they are skipped and the
// bullets beneath them still count; unknown `## …` sections are ignored;
// `Rating:`/`Result:`/`Status:` keys and their values are case-insensitive; a
// value is the *first word* after the key (emphasis and trailing punctuation
// stripped, anything else on the line ignored, so `Status: DONE — no concerns`
// and `Result: not applicable` parse); an empty `## Findings` or
// `## Phase 3 must check` may say `None.`, `None`, `n/a` or `-`; emphasis (`*`,
// `_`, `` ` ``) around keys, values, severity brackets and criteria is dropped;
// bullets may be `-`, `*`, `+`, `1.` or `1)`; and an indented line under a
// finding is a continuation appended to that finding's text. Rejecting a review
// costs a completed adversarial literature search; ignoring extra formatting
// costs nothing.
//
// CLI: `node harness/tools/merge-reviews.ts <puzzleNodeDir>` reads
// `workspace/reviews/a.md` and `b.md`, writes `merged.json` and `merged.md`
// beside them, and prints `ok` (exit 0) or one problem per line (exit 1; a
// missing or malformed review, each problem prefixed with its file). Usage
// errors exit 2, as in `check-pattern.ts`.
import * as fs from "node:fs";
import * as path from "node:path";

export type Rating = "strong" | "adequate" | "weak" | "fails";
export type ReviewCriterion = "fit" | "plausibility" | "relevance";
export type Severity = "blocking" | "major" | "minor";
/** Where a finding points: the three criteria, or one of the two checks. */
export type FindingCriterion = ReviewCriterion | "data-character" | "known-result";
export type Status = "DONE" | "DONE_WITH_CONCERNS" | "BLOCKED";

export interface Finding {
  severity: Severity;
  criterion: FindingCriterion;
  text: string;
}

export interface Review {
  criteria: Record<ReviewCriterion, Rating>;
  dataCharacter: "ok" | "violated";
  knownResult: "ok" | "blocking" | "not-applicable";
  findings: Finding[];
  phase3MustCheck: string[];
  status: Status;
}

/**
 * A merged finding. `reviewer` is `"both"` when the two reviews raised it (they
 * then produce one entry, at `confidence: "high"`); a single-reviewer finding
 * carries `"a"` or `"b"`. The union is widened by `"both"` on purpose: tagging
 * a shared finding as `"a"` would misreport who raised it.
 */
export interface MergedFinding {
  reviewer: "a" | "b" | "both";
  severity: Severity;
  criterion: FindingCriterion;
  text: string;
  confidence: "high" | "single-reviewer";
}

export interface Merged {
  criteria: Record<ReviewCriterion, { rating: Rating; agreement: "agree" | "split" }>;
  flags: {
    breakdown: boolean;
    knownResultBlocking: boolean;
    dataCharacterViolated: boolean;
    /** Either reviewer closed with `Status: BLOCKED`: do not rank or promote on this merge. */
    reviewBlocked: boolean;
  };
  findings: MergedFinding[];
  /** Each reviewer's own closing status, so a review that stopped early is visible. */
  status: { a: Status; b: Status };
  /** Both reviews' `Phase 3 must check` questions, de-duplicated by normalised text. */
  phase3: string[];
}

/** More severe wins: fails > weak > adequate > strong. */
const RATING_SEVERITY: Record<Rating, number> = { strong: 1, adequate: 2, weak: 3, fails: 4 };
const SEVERITY_ORDER: Record<Severity, number> = { blocking: 3, major: 2, minor: 1 };

/** Jaccard overlap of the two normalised word sets at or above this is the same finding. */
const FINDING_OVERLAP = 0.5;

const CRITERIA: ReviewCriterion[] = ["fit", "plausibility", "relevance"];
const RATINGS: Rating[] = ["strong", "adequate", "weak", "fails"];
const SEVERITIES: Severity[] = ["blocking", "major", "minor"];
const FINDING_CRITERIA: FindingCriterion[] = [...CRITERIA, "data-character", "known-result"];
const DATA_CHARACTER: Review["dataCharacter"][] = ["ok", "violated"];
const KNOWN_RESULT: Review["knownResult"][] = ["ok", "blocking", "not-applicable"];
const STATUSES: Status[] = ["DONE", "DONE_WITH_CONCERNS", "BLOCKED"];

const HEADING: Record<ReviewCriterion | "data-character" | "known-result" | "findings" | "phase3", string> = {
  fit: "## Fit",
  plausibility: "## Plausibility",
  relevance: "## Relevance",
  "data-character": "## Data-character check",
  "known-result": "## Known-result check",
  findings: "## Findings",
  phase3: "## Phase 3 must check",
};
const HEADINGS = Object.values(HEADING);

/** Only an exact level-2 `## ` heading starts a section; `###` and deeper are body text. */
const SECTION_HEADING = /^##\s/;
/** `###` and deeper: body text, never a section boundary (skipped inside `## Findings`). */
const SUBHEADING = /^#{3,}\s/;
/** What a section says when it has nothing in it. */
const EMPTY_MARKERS = new Set(["none", "n/a", "-"]);
/** A list marker: `-`, `*`, `+`, `1.` or `1)`, indented or not. */
const BULLET = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;
/** Leading/trailing `*`, `_` or backticks are formatting (`**adequate**`), never content. */
function unemphasise(token: string): string {
  let value = token.trim();
  let previous: string;
  do {
    previous = value;
    value = value
      .replace(/^[*_`]+/, "")
      .replace(/[*_`]+$/, "")
      .trim();
  } while (value !== previous);
  return value;
}
/** One of these on exactly one side of a pair keeps two findings apart. */
const NEGATION = /\b(?:no|not|never|without)\b/;

/**
 * Function words dropped before comparing finding texts. Negations ("no", "not")
 * stay in the word sets; `sameFinding` also compares their presence directly.
 */
const STOPWORDS = new Set([
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "their",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "was",
  "were",
  "what",
  "when",
  "which",
  "while",
  "with",
  "would",
]);

/** True for a `### …` (or deeper) line: body text, not a section boundary. */
function isSubheading(text: string): boolean {
  return SUBHEADING.test(text);
}

/**
 * `None.`, `None`, `n/a` or `-` (also as a bullet's whole text) means the
 * section is empty. Emphasis and a trailing full stop are formatting.
 */
function isEmptyMarker(text: string): boolean {
  const value = unemphasise(text.replace(BULLET, ""))
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .trim();
  return EMPTY_MARKERS.has(value);
}

/**
 * The first word after a key, with surrounding emphasis and trailing
 * punctuation stripped: `**Adequate**.` → `Adequate`, `DONE.` → `DONE`.
 * `Result: not applicable` (a space instead of the hyphen) is combined back
 * into `not-applicable` when `combineNot` is set.
 */
function firstWordValue(rest: string, combineNot: boolean): string {
  const clean = (token: string): string => {
    let value = token;
    for (;;) {
      const next = value
        .replace(/^[*_`]+/, "")
        .replace(/[.,;:!?]+$/, "")
        .replace(/[*_`]+$/, "")
        .trim();
      if (next === value) return value;
      value = next;
    }
  };
  // `** _ADEQUATE_` splits into an emphasis-only token first: skip those.
  const tokens = rest.trim().split(/\s+/);
  let index = 0;
  while (index < tokens.length && clean(tokens[index] ?? "").length === 0) index++;
  const first = clean(tokens[index] ?? "");
  if (combineNot && first.toLowerCase() === "not") {
    let next = index + 1;
    while (next < tokens.length && clean(tokens[next] ?? "").length === 0) next++;
    if (next < tokens.length) return `not-${clean(tokens[next] ?? "")}`;
  }
  return first;
}

function normaliseText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function words(text: string): Set<string> {
  const set = new Set<string>();
  for (const word of normaliseText(text).split(" ")) {
    if (word.length >= 2 && !STOPWORDS.has(word)) set.add(word);
  }
  return set;
}

/** True when the two findings are the same finding (criterion, severity, polarity, text overlap). */
function sameFinding(one: Finding, other: Finding): boolean {
  if (one.criterion !== other.criterion || one.severity !== other.severity) return false;
  if (NEGATION.test(normaliseText(one.text)) !== NEGATION.test(normaliseText(other.text))) return false;
  if (normaliseText(one.text) === normaliseText(other.text)) return true;
  const a = words(one.text);
  const b = words(other.text);
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared) >= FINDING_OVERLAP;
}

interface Section {
  heading: string;
  /** Content lines with their 1-based line numbers; `raw` keeps indentation, `text` is trimmed. */
  lines: { number: number; raw: string; text: string }[];
}

/**
 * Every format heading (three criteria, two checks, findings, Phase 3) with its
 * content. Any other level-2 heading ends a section and is otherwise ignored;
 * `###` and deeper headings are ordinary content lines (the Findings parser
 * skips them). A known heading that is missing or repeated is a problem. The
 * Status line is never section content: it is the file's last non-empty line,
 * wherever the reviewer put it.
 */
function splitSections(lines: string[], statusIndex: number): { sections: Map<string, Section>; problems: string[] } {
  const problems: string[] = [];
  const starts: { index: number; heading?: string }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const text = (lines[index] ?? "").trim();
    if (!SECTION_HEADING.test(text)) continue;
    if (HEADINGS.includes(text)) starts.push({ index, heading: text });
    // Unknown `## …` sections (`## Summary`) are ignored: extra prose in a
    // completed review must not cost the owner a re-run of the reviewer.
    else starts.push({ index });
  }

  const seen = new Map<string, number>();
  for (const start of starts) {
    if (start.heading === undefined) continue;
    seen.set(start.heading, (seen.get(start.heading) ?? 0) + 1);
  }
  for (const heading of HEADINGS) {
    const count = seen.get(heading) ?? 0;
    if (count === 0) problems.push(`lacks the heading ${JSON.stringify(heading)}`);
    else if (count > 1) problems.push(`has the heading ${JSON.stringify(heading)} twice`);
  }

  const sections = new Map<string, Section>();
  for (let position = 0; position < starts.length; position++) {
    const start = starts[position] as { index: number; heading?: string };
    if (start.heading === undefined) continue;
    const end = starts[position + 1]?.index ?? lines.length;
    const content: Section["lines"] = [];
    for (let index = start.index + 1; index < end; index++) {
      if (index === statusIndex) continue;
      const raw = (lines[index] ?? "").trimEnd();
      if (raw.trim().length === 0) continue;
      content.push({ number: index + 1, raw, text: raw.trim() });
    }
    // A duplicated heading keeps its first section; the duplicate is a problem already.
    if (!sections.has(start.heading)) sections.set(start.heading, { heading: start.heading, lines: content });
  }
  return { sections, problems };
}

/** The canonical spelling of `value` in `allowed` (case-insensitive), or undefined. */
function canonical(allowed: readonly string[], value: string): string | undefined {
  const normalised = value.toLowerCase();
  return allowed.find((candidate) => candidate.toLowerCase() === normalised);
}

/** The first content line of a section must be `Rating: <value>` or `Result: <value>`. */
function firstLineValue(
  section: Section,
  keyword: "Rating" | "Result",
  allowed: readonly string[],
  problems: string[],
): string | undefined {
  // A `### …` sub-heading before the value is body text, not the value line.
  const first = section.lines.find((line) => !isSubheading(line.text));
  if (first === undefined) {
    problems.push(`${section.heading} has no ${JSON.stringify(`${keyword}:`)} line`);
    return undefined;
  }
  // Emphasis and backticks are formatting, not content: `**Rating:** _ADEQUATE_`.
  const parsed = new RegExp(`^[*_\\s]*${keyword}[*_\\s]*:\\s*(.+)$`, "i").exec(first.text);
  if (parsed === null) {
    problems.push(
      `${section.heading} line ${first.number} is not a ${JSON.stringify(`${keyword}: <value>`)} line: ${JSON.stringify(first.text)}`,
    );
    return undefined;
  }
  const raw = firstWordValue(parsed[1] as string, keyword === "Result");
  const value = canonical(allowed, raw);
  if (value === undefined) {
    const what = keyword === "Rating" ? "rating" : "result";
    problems.push(
      `${section.heading} line ${first.number} has an invalid ${what} ${JSON.stringify(raw)} (expected ${allowed.join("|")})`,
    );
    return undefined;
  }
  return value;
}

/**
 * `- **[major] fit:** text` → a finding, or null when the line is not one.
 * Emphasis around the bracket, the criterion and the colon is dropped; the
 * finding's text keeps its own emphasis.
 */
function parseFinding(text: string): Finding | null {
  const body = text.replace(BULLET, "");
  if (body === text) return null; // no list marker
  const severityMatch = /^[*_`\s]*\[\s*([A-Za-z-]+)\s*\][*_`\s]*/.exec(body);
  if (severityMatch === null) return null;
  const severity = canonical(SEVERITIES, severityMatch[1] as string);
  if (severity === undefined) return null;
  const rest = body.slice(severityMatch[0].length);
  const criterionMatch = /^[*_`\s]*([A-Za-z-]+)[*_`\s]*:[*_`\s]*([\s\S]*)$/.exec(rest);
  if (criterionMatch === null) return null;
  const criterion = canonical(FINDING_CRITERIA, criterionMatch[1] as string);
  if (criterion === undefined) return null;
  const findingText = (criterionMatch[2] as string).trim();
  if (findingText.length === 0) return null;
  return { severity: severity as Severity, criterion: criterion as FindingCriterion, text: findingText };
}

interface Parsed {
  review: Review | null;
  problems: string[];
}

/** The review and every problem with it, in one pass (the two exports below split it). */
function parseDetailed(markdown: string): Parsed {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let statusIndex = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if ((lines[index] ?? "").trim().length > 0) {
      statusIndex = index;
      break;
    }
  }
  if (statusIndex < 0) return { review: null, problems: ["the file is empty"] };

  const problems: string[] = [];
  const { sections, problems: headingProblems } = splitSections(lines, statusIndex);
  problems.push(...headingProblems);

  // The last non-empty line is the Status line; nothing may follow it.
  const last = (lines[statusIndex] ?? "").trim();
  const statusLine = /^[*_\s]*Status[*_\s]*:\s*(.+)$/i.exec(last);
  let status: Status | undefined;
  if (statusLine === null) {
    problems.push(`the last line is not a Status: line (got ${JSON.stringify(last)})`);
  } else {
    const raw = firstWordValue(statusLine[1] as string, false);
    const value = canonical(STATUSES, raw);
    if (value === undefined) {
      problems.push(`the last line has an invalid status ${JSON.stringify(raw)} (expected ${STATUSES.join("|")})`);
    } else {
      status = value as Status;
    }
  }

  const criteria = {} as Record<ReviewCriterion, Rating>;
  for (const criterion of CRITERIA) {
    const section = sections.get(HEADING[criterion]);
    const value = section === undefined ? undefined : firstLineValue(section, "Rating", RATINGS, problems);
    if (value !== undefined) criteria[criterion] = value as Rating;
  }
  const dataSection = sections.get(HEADING["data-character"]);
  const dataCharacter =
    dataSection === undefined ? undefined : firstLineValue(dataSection, "Result", DATA_CHARACTER, problems);
  const knownSection = sections.get(HEADING["known-result"]);
  const knownResult =
    knownSection === undefined ? undefined : firstLineValue(knownSection, "Result", KNOWN_RESULT, problems);

  const findings: Finding[] = [];
  let current: Finding | undefined;
  for (const line of sections.get(HEADING.findings)?.lines ?? []) {
    if (isSubheading(line.text)) {
      // `### Finding 1` is a label, not a finding: skip it, keep the bullets under it.
      current = undefined;
      continue;
    }
    const parsed = parseFinding(line.text);
    if (parsed !== null) {
      findings.push(parsed);
      current = parsed;
      continue;
    }
    if (isEmptyMarker(line.text)) {
      current = undefined;
      continue;
    }
    const indented = /^[ \t]/.test(line.raw);
    if (indented && current !== undefined) {
      // An indented sub-bullet or continuation belongs to the finding above it.
      current.text = `${current.text} ${line.text.replace(BULLET, "").trim()}`.trim();
      continue;
    }
    problems.push(
      `${HEADING.findings} line ${line.number} is not a finding line: ${JSON.stringify(line.text)} ` +
        `(expected "- [blocking|major|minor] <${FINDING_CRITERIA.join("|")}>: <text>")`,
    );
    current = undefined;
  }

  const phase3MustCheck: string[] = [];
  for (const line of sections.get(HEADING.phase3)?.lines ?? []) {
    if (isSubheading(line.text) || isEmptyMarker(line.text)) continue;
    if (BULLET.exec(line.raw) === null) {
      problems.push(`${HEADING.phase3} line ${line.number} is not a list item: ${JSON.stringify(line.text)}`);
      continue;
    }
    const text = line.text.replace(BULLET, "").trim();
    if (text.length === 0) {
      problems.push(`${HEADING.phase3} line ${line.number} is an empty list item`);
      continue;
    }
    if (isEmptyMarker(text)) continue;
    phase3MustCheck.push(text);
  }

  if (problems.length > 0) return { review: null, problems };
  return {
    review: {
      criteria,
      dataCharacter: dataCharacter as Review["dataCharacter"],
      knownResult: knownResult as Review["knownResult"],
      findings,
      phase3MustCheck,
      status: status as Status,
    },
    problems,
  };
}

/**
 * Every problem with `markdown` as a review, in file order: headings, status
 * line, then each section's content. An empty list means it parses.
 */
export function reviewProblems(markdown: string): string[] {
  return parseDetailed(markdown).problems;
}

/** A review file, or null when it is malformed (`reviewProblems` says why). */
export function parseReview(markdown: string): Review | null {
  return parseDetailed(markdown).review;
}

function moreSevere(one: Rating, other: Rating): Rating {
  return RATING_SEVERITY[one] >= RATING_SEVERITY[other] ? one : other;
}

/** The two reviews' questions, first-seen spelling kept, de-duplicated on normalised text. */
function unionPhase3(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const union: string[] = [];
  for (const question of [...a, ...b]) {
    const key = normaliseText(question);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    union.push(question);
  }
  return union;
}

/**
 * Merge the two reviews of a puzzle: the more severe rating per criterion
 * (`agree` when they match), the union of the flags, the findings with their
 * confidence, both reviewers' closing statuses, and the union of their Phase 3
 * questions. Findings are listed most severe first; within a severity the order
 * of `a` then the unmatched findings of `b` is kept.
 */
export function mergeReviews(a: Review, b: Review): Merged {
  const criteria = {} as Merged["criteria"];
  for (const criterion of CRITERIA) {
    const one = a.criteria[criterion];
    const other = b.criteria[criterion];
    criteria[criterion] = { rating: moreSevere(one, other), agreement: one === other ? "agree" : "split" };
  }

  const matched = new Set<number>();
  const findings: MergedFinding[] = [];
  for (const finding of a.findings) {
    const index = b.findings.findIndex((other, at) => !matched.has(at) && sameFinding(finding, other));
    if (index < 0) {
      findings.push({ reviewer: "a", ...finding, confidence: "single-reviewer" });
      continue;
    }
    matched.add(index);
    // The text of `a` is kept: a fixed choice keeps the merge deterministic.
    findings.push({ reviewer: "both", ...finding, confidence: "high" });
  }
  for (let index = 0; index < b.findings.length; index++) {
    if (matched.has(index)) continue;
    findings.push({ reviewer: "b", ...(b.findings[index] as Finding), confidence: "single-reviewer" });
  }
  findings.sort((one, other) => SEVERITY_ORDER[other.severity] - SEVERITY_ORDER[one.severity]);

  return {
    criteria,
    flags: {
      breakdown: a.criteria.plausibility === "fails" || b.criteria.plausibility === "fails",
      knownResultBlocking: a.knownResult === "blocking" || b.knownResult === "blocking",
      dataCharacterViolated: a.dataCharacter === "violated" || b.dataCharacter === "violated",
      reviewBlocked: a.status === "BLOCKED" || b.status === "BLOCKED",
    },
    findings,
    status: { a: a.status, b: b.status },
    phase3: unionPhase3(a.phase3MustCheck, b.phase3MustCheck),
  };
}

function yes(flag: boolean): string {
  return flag ? "yes" : "no";
}

/** The owner-facing file: the same information as `merged.json`, in prose. */
function renderMarkdown(merged: Merged): string {
  const lines = [
    "# Merged review",
    "",
    "Two independent reviews, merged mechanically: a finding both raise is high confidence,",
    "the more severe rating wins, and a flag set by either reviewer is set.",
    "",
    "| criterion | rating | agreement |",
    "| --- | --- | --- |",
    ...CRITERIA.map(
      (criterion) => `| ${criterion} | ${merged.criteria[criterion].rating} | ${merged.criteria[criterion].agreement} |`,
    ),
    "",
    `Statuses: a: ${merged.status.a}; b: ${merged.status.b}`,
    "",
  ];
  // A review that stopped early is the first thing the owner must see.
  for (const [who, status] of [
    ["a", merged.status.a],
    ["b", merged.status.b],
  ] as const) {
    if (status === "BLOCKED") {
      lines.push(
        `**Review ${who} is BLOCKED; its review did not finish, so do not rank, evolve or promote on this merge alone.**`,
        "",
      );
    } else if (status === "DONE_WITH_CONCERNS") {
      lines.push(`**Review ${who} is DONE_WITH_CONCERNS; read its findings before ranking.**`, "");
    }
  }
  lines.push(
    `breakdown: ${yes(merged.flags.breakdown)}; known-result blocking: ${yes(merged.flags.knownResultBlocking)}; ` +
      `data character violated: ${yes(merged.flags.dataCharacterViolated)}; review blocked: ${yes(merged.flags.reviewBlocked)}`,
    "",
    "## Findings",
    "",
  );
  if (merged.findings.length === 0) {
    lines.push("None.");
  } else {
    for (const finding of merged.findings) {
      const who = finding.confidence === "high" ? "high confidence" : `single reviewer, ${finding.reviewer}`;
      lines.push(`- [${finding.severity}] ${finding.criterion} (${who}): ${finding.text}`);
    }
  }
  lines.push("", "## Phase 3 must check", "");
  if (merged.phase3.length === 0) {
    lines.push("None.");
  } else {
    for (const question of merged.phase3) lines.push(`- ${question}`);
  }
  lines.push("");
  return lines.join("\n");
}

function usage(message: string): number {
  console.error(`merge-reviews: ${message}`);
  console.error("usage: node harness/tools/merge-reviews.ts <puzzleNodeDir>");
  return 2;
}

/** The reviews of the puzzle node at `nodeDir`, or the problems that prevent a merge. */
function readReviews(nodeDir: string): { problems: string[]; reviews?: [Review, Review] } {
  const reviewsDir = path.join(nodeDir, "workspace", "reviews");
  const problems: string[] = [];
  const reviews: Review[] = [];
  for (const name of ["a.md", "b.md"] as const) {
    const file = path.join(reviewsDir, name);
    const shown = `workspace/reviews/${name}`;
    if (!fs.existsSync(file)) {
      problems.push(`${shown} is missing`);
      continue;
    }
    const markdown = fs.readFileSync(file, "utf8");
    const review = parseReview(markdown);
    if (review === null) {
      for (const problem of reviewProblems(markdown)) problems.push(`${shown}: ${problem}`);
      continue;
    }
    reviews.push(review);
  }
  if (problems.length > 0) return { problems };
  return { problems: [], reviews: [reviews[0] as Review, reviews[1] as Review] };
}

function main(argv: string[]): number {
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--")) return usage(`unknown option ${arg}`);
    positional.push(arg);
  }
  const [nodeDirArg] = positional;
  if (nodeDirArg === undefined || positional.length > 1) return usage("expected a puzzle node directory");

  const nodeDir = path.resolve(nodeDirArg);
  if (!fs.existsSync(nodeDir) || !fs.statSync(nodeDir).isDirectory()) return usage(`${nodeDirArg} is not a directory`);

  const { problems, reviews } = readReviews(nodeDir);
  if (reviews === undefined) {
    for (const problem of problems) console.log(problem);
    return 1;
  }

  const merged = mergeReviews(reviews[0], reviews[1]);
  const reviewsDir = path.join(nodeDir, "workspace", "reviews");
  fs.writeFileSync(path.join(reviewsDir, "merged.json"), `${JSON.stringify(merged, null, 2)}\n`);
  fs.writeFileSync(path.join(reviewsDir, "merged.md"), renderMarkdown(merged));
  console.log("ok");
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
