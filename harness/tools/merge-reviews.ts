// Mechanical merge of a puzzle's two independent reviews.
//
// Two `ctc-reviewer` workers review a puzzle without seeing each other's file
// (the reviewer guard enforces it), and the owner reads only the merge. The
// merge is deterministic: for each criterion the more severe rating wins
// (`fails` > `weak` > `adequate` > `strong`), and any reviewer's flag is the
// merged flag (a `fails` plausibility is a breakdown; a `blocking` known-result
// check blocks; a `violated` data-character check is a violation). A finding
// both reviewers raise is high confidence; a finding only one raises keeps its
// reviewer tag and is single-reviewer.
//
// "Both reviewers raise the same finding" is not defined by the brief, so this
// file defines it: same criterion, same severity, and similar text. Text is
// normalised to lower-case words (punctuation dropped, one-letter words and
// function words removed; negations are kept) and the two word sets are
// compared by Jaccard overlap, `|A and B| / |A or B| >= FINDING_OVERLAP` (0.5). Two
// reviewers rarely phrase a finding identically, but they reuse the finding's
// content words ("existing theory already explains the pattern" vs "existing
// theory already explains the pattern, so it is no puzzle" overlap 5/6), while
// two different findings under one criterion share little ("worst fits are
// never discussed" vs "citation to the rival is the wrong chunk"). The rule is
// deliberately conservative: an unmatched pair stays two single-reviewer
// findings, which understates agreement rather than inventing it. Matching is
// greedy in review order and each finding of `b` pairs at most once, so a
// duplicated finding cannot be counted twice.
//
// The review format is fixed by the Phase 2 plan (Task 10's reviewer role
// teaches it and Task 7's `check-puzzle --reviews` enforces it):
//
//   ## Fit / ## Plausibility / ## Relevance     first line `Rating: strong|adequate|weak|fails`
//   ## Data-character check                     first line `Result: ok|violated`
//   ## Known-result check                       first line `Result: ok|blocking|not-applicable`
//   ## Findings                                 lines `- [blocking|major|minor] <criterion>: <text>`
//   ## Phase 3 must check                       a `- ` list
//   last line                                   `Status: DONE|DONE_WITH_CONCERNS|BLOCKED`
//
// Parsing is strict: a missing heading, an invalid rating or check value, a
// malformed finding line or a last line that is not a Status makes the whole
// review malformed. `reviewProblems` says what is wrong (the CLI prints it with
// the file name); `parseReview` returns only the review or null.
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
  flags: { breakdown: boolean; knownResultBlocking: boolean; dataCharacterViolated: boolean };
  findings: MergedFinding[];
}

/** More severe wins: fails > weak > adequate > strong. */
const RATING_SEVERITY: Record<Rating, number> = { strong: 1, adequate: 2, weak: 3, fails: 4 };
const SEVERITY_ORDER: Record<Severity, number> = { blocking: 3, major: 2, minor: 1 };

/** Jaccard overlap of the two normalised word sets at or above this is the same finding. */
const FINDING_OVERLAP = 0.5;

const CRITERIA: ReviewCriterion[] = ["fit", "plausibility", "relevance"];
const RATINGS: Rating[] = ["strong", "adequate", "weak", "fails"];
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

/** `- [blocking] plausibility: existing theory already explains it` */
const FINDING_LINE = /^-\s*\[(blocking|major|minor)\]\s*(fit|plausibility|relevance|data-character|known-result):\s*(\S.*)$/;

/**
 * Function words dropped before comparing finding texts. Negations ("no", "not")
 * stay: "the card claims no behaviour" and "the card claims behaviour" are
 * different findings.
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

/** True when the two findings are the same finding (criterion, severity, text overlap). */
function sameFinding(one: Finding, other: Finding): boolean {
  if (one.criterion !== other.criterion || one.severity !== other.severity) return false;
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
  /** Content lines (trimmed, non-empty) with their 1-based line numbers. */
  lines: { number: number; text: string }[];
}

/**
 * Every format heading (three criteria, two checks, findings, Phase 3) with its
 * content. A line that starts with `## ` but is not one of the known headings is
 * reported, and ends the section it interrupts. The Status line is never section
 * content: it is the file's last non-empty line, wherever the reviewer put it.
 */
function splitSections(
  lines: string[],
  statusIndex: number,
): { sections: Map<string, Section>; problems: string[] } {
  const problems: string[] = [];
  const starts: { index: number; heading?: string }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const text = (lines[index] ?? "").trim();
    if (!text.startsWith("## ")) continue;
    if (HEADINGS.includes(text)) starts.push({ index, heading: text });
    else {
      problems.push(`has an unknown heading ${JSON.stringify(text)}`);
      starts.push({ index });
    }
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
    const content: { number: number; text: string }[] = [];
    for (let index = start.index + 1; index < end; index++) {
      if (index === statusIndex) continue;
      const text = (lines[index] ?? "").trim();
      if (text.length > 0) content.push({ number: index + 1, text });
    }
    // A duplicated heading keeps its first section; the duplicate is a problem already.
    if (!sections.has(start.heading)) sections.set(start.heading, { heading: start.heading, lines: content });
  }
  return { sections, problems };
}

/** The first content line of a section must be `Rating: <value>` or `Result: <value>`. */
function firstLineValue(
  section: Section,
  keyword: "Rating" | "Result",
  allowed: readonly string[],
  problems: string[],
): string | undefined {
  const first = section.lines[0];
  if (first === undefined) {
    problems.push(`${section.heading} has no ${JSON.stringify(`${keyword}:`)} line`);
    return undefined;
  }
  const parsed = new RegExp(`^${keyword}:\\s*(\\S+)$`).exec(first.text);
  if (parsed === null) {
    problems.push(
      `${section.heading} line ${first.number} is not a ${JSON.stringify(`${keyword}: <value>`)} line: ${JSON.stringify(first.text)}`,
    );
    return undefined;
  }
  const value = parsed[1] as string;
  if (!allowed.includes(value)) {
    const what = keyword === "Rating" ? "rating" : "result";
    problems.push(
      `${section.heading} line ${first.number} has an invalid ${what} ${JSON.stringify(value)} (expected ${allowed.join("|")})`,
    );
    return undefined;
  }
  return value;
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
  const statusLine = /^Status:\s*(\S+)$/.exec(last);
  let status: Status | undefined;
  if (statusLine === null) {
    problems.push(`the last line is not a Status: line (got ${JSON.stringify(last)})`);
  } else if (!STATUSES.includes(statusLine[1] as Status)) {
    problems.push(`the last line has an invalid status ${JSON.stringify(statusLine[1])} (expected ${STATUSES.join("|")})`);
  } else {
    status = statusLine[1] as Status;
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
  for (const line of sections.get(HEADING.findings)?.lines ?? []) {
    const parsed = FINDING_LINE.exec(line.text);
    if (parsed === null) {
      problems.push(
        `${HEADING.findings} line ${line.number} is not a finding line: ${JSON.stringify(line.text)} ` +
          `(expected "- [blocking|major|minor] <${FINDING_CRITERIA.join("|")}>: <text>")`,
      );
      continue;
    }
    findings.push({
      severity: parsed[1] as Severity,
      criterion: parsed[2] as FindingCriterion,
      text: (parsed[3] as string).trim(),
    });
  }

  const phase3MustCheck: string[] = [];
  for (const line of sections.get(HEADING.phase3)?.lines ?? []) {
    if (!line.text.startsWith("-")) {
      problems.push(`${HEADING.phase3} line ${line.number} is not a list item: ${JSON.stringify(line.text)}`);
      continue;
    }
    const text = line.text.replace(/^-\s*/, "").trim();
    if (text.length === 0) {
      problems.push(`${HEADING.phase3} line ${line.number} is an empty list item`);
      continue;
    }
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

/**
 * Merge the two reviews of a puzzle: the more severe rating per criterion
 * (`agree` when they match), the union of the flags, and the findings with
 * their confidence. Findings are listed most severe first; within a severity
 * the order of `a` then the unmatched findings of `b` is kept.
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
    },
    findings,
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
    `breakdown: ${yes(merged.flags.breakdown)}; known-result blocking: ${yes(merged.flags.knownResultBlocking)}; data character violated: ${yes(merged.flags.dataCharacterViolated)}`,
    "",
    "## Findings",
    "",
  ];
  if (merged.findings.length === 0) {
    lines.push("None.");
  } else {
    for (const finding of merged.findings) {
      const who = finding.confidence === "high" ? "high confidence" : `single reviewer, ${finding.reviewer}`;
      lines.push(`- [${finding.severity}] ${finding.criterion} (${who}): ${finding.text}`);
    }
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
