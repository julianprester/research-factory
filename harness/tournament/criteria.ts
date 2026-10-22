// The Phase 2 rubric: Tavory & Timmermans' three criteria, quoted verbatim.
//
// The judge's prompt and the reviewers' briefs both need the same words, and
// they must be the book's, not a paraphrase. The text lives in one markdown file
// so there is a single copy to quote; `criteria.test.ts` checks every passage it
// quotes against `docs/abduction.md`, so the rubric cannot drift from the book.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The criteria file, relative to the repository root. */
const CRITERIA_FILE = path.join("harness", "skills", "criteria", "tavory-timmermans.md");

/** The criteria file's text: the three definitions, quoted, and how to apply them. */
export function loadCriteria(): string {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  return readFileSync(path.join(repoRoot, CRITERIA_FILE), "utf8");
}
