---
name: puzzle-review
description: "Use as one of the two independent Phase 2 reviewers of a puzzle: rate it on fit, plausibility and relevance against the literature and Phase 1's evidence, and write one review ending in a Status line."
---

# puzzle-review

You are one Phase 2 reviewer of one puzzle. A second reviewer is reviewing the
same card at the same time; you never read another review and they never see yours.
An owner has written `brief-review.md` in the puzzle node folder. Read it first:
it is your contract for the inputs, the paths you may read and the Definition of
Done. It does **not** name your output slot — **your task text names the slot**,
`workspace/reviews/a.md` or `workspace/reviews/b.md`.

Read only the paths the brief lists: the puzzle card `workspace/puzzle.md`, the
pattern's `workspace/measure.md`, `workspace/pattern.md` and `handoff.md`,
`data-character.md`, `glossary.md`, the criteria file
`./harness/skills/criteria/tavory-timmermans.md`,
and the pattern's `Caveat:` line when there is one. Never read another review
(another puzzle's or your own other draft), never another puzzle or sibling,
never read under `owners/` (the owner's rulings and the judge's output live
there), never the hold-out, and never the dataset.

## 1. The three criteria, from the book

Read the criteria file before you rate. Its three questions are Tavory &
Timmermans' (2014), and they are the whole rubric:

- "Are the theoretical claims supported by the empirical materials?"
- "Are the theoretical claims stronger than competing theories?"
- "Do the theorizations matter in the broader intellectual community?"

These are **fit**, **plausibility** and **relevance**. Interestingness is not a
fourth criterion; it falls under relevance. The materials are Phase 1's:
**No analysis** in Phase 2, no new measurement, no counting. Judge the puzzle
against the pattern card's `Result`, `Verdict`, `Robustness`, `Worst fits` and
`Deviations`. Where a claim needs a check, it goes under `Phase 3 must check:`,
not into your own work.

### Fit

Does the puzzle follow from Phase 1's evidence **and** transcend it? A
restatement of the pattern adds nothing. Judge whether it is honest about the
card's negative cases, worst fits and thin cells — a puzzle silent about them
does not fit. Never run anything: no scripts, no counts, and no dataset reads.
A check you want is a `Phase 3 must check:` question.

### Plausibility — the adversarial search

Build the **strongest rival account** the literature can offer and test the
puzzle against it. Search adversarially, not for support: does existing theory
already explain this pattern? Cite what you find, under the bounds in
`./harness/skills/roles/deepis.md` — `timeout
60`, `-n` at most 15, `jq`-compacted output, `--no-rerank` on failure, and only a
chunk read with `deepis context` may be cited. If existing theory already
explains the pattern, say so plainly in the section and rate plausibility
`fails`: that is a breakdown, not a puzzle, and the owner must be able to see it.

### Relevance

Which debate does the puzzle enter, and what would a resolution give researchers
who are not studying this corpus? The book gives no method for relevance, so
argue it and cite the debate. "Interesting" is not enough: say who would use the
answer and for what.

## 2. The two checks

- **Data-character check** — does every claim stay inside what `data-character.md`
  permits? The corpus documents rules and prescriptions, not behaviour. A puzzle
  claiming what anyone or any bot did is `violated`; say which sentence.
- **Known-result check** — does a Phase 0 `Caveat:` apply? A puzzle that presents
  a known result as a discovery gets `blocking` here. A puzzle that shows what is
  not yet known about a pre-known contradicted pattern is `ok`. When no caveat
  applies, write `not-applicable`.

## 3. The review file

Write `workspace/reviews/a.md` or `workspace/reviews/b.md` — the one **your task
text names** (the brief never names a slot), and nothing else — with the **write
tool**, never through bash. It has exactly these `## ` sections, each once. Extra
`## ` sections are allowed but must not contain a finding-shaped line.

The block between the markers below is a **worked example**, not a template to
copy blindly: its values are ILLUSTRATIVE and must be replaced by your own
judgement — do not anchor on its ratings, findings or prose. Write the review as
ordinary text: **write the file's content, not a code fence around it** — the
closing fence would become the last line and the merge tool would reject the
file. Do not copy the `BEGIN`/`END` marker lines either.

BEGIN REVIEW EXAMPLE
## Fit

Rating: weak
The puzzle restates the pattern's Result in its own words and never returns to the two worst-fit slices the pattern card names, so it does not yet follow from Phase 1's evidence.

## Plausibility

Rating: adequate
The status-quo theory is named as the rival, but the card gives no citation for its prediction, so the comparison is sketched rather than shown.

## Relevance

Rating: strong
The puzzle enters the debate on rule formalisation for platform governance and says what a resolution would change for researchers who study documentation work.

## Data-character check

Result: ok
Every claim stays with what the corpus documents: written rules and prescriptions, never behaviour.

## Known-result check

Result: ok
The pattern carries no Phase 0 caveat, so there is no known result to present as a discovery.

## Findings

- [blocking] fit: The card never answers the two worst-fit slices its pattern card records, so the claim does not yet follow from Phase 1's evidence.
- [major] plausibility: The rival account is named but never cited, so the comparison behind the plausibility rating cannot be checked.
- [minor] relevance: The debate is named, but the sentence on what a resolution would change is a gesture rather than a warrant.

## Phase 3 must check

- Whether the pattern holds in the two worst-fit slices once documents are matched on section type.
- Whether the status-quo theory's prediction is borne out by the rule changes the card cites.

Status: DONE
END REVIEW EXAMPLE

The file stops at the `Status:` line — add nothing after it.

The allowed values, kept outside the example so they cannot be copied into a
review:

| line | allowed values |
|---|---|
| `Rating:` | `strong`, `adequate`, `weak`, `fails` |
| `Result:` for data-character | `ok`, `violated` |
| `Result:` for known-result | `ok`, `blocking`, `not-applicable` |
| `Status:` | `DONE`, `DONE_WITH_CONCERNS`, `BLOCKED` |
| a finding's severity | `blocking`, `major`, `minor` |

Rules that make the file parse:

- `Rating:` is the first content line of each criterion section and its first
  word is exactly `strong`, `adequate`, `weak` or `fails`; prose may follow.
- `Result:` is the first content line of each check section, with `ok` or
  `violated` for data-character, `ok`, `blocking` or `not-applicable` for
  known-result.
- **ALL findings only under `## Findings`**, one per line, in exactly the form
  `- [blocking|major|minor] <fit|plausibility|relevance|data-character|known-result>: <text>`.
  A finding-shaped line anywhere else makes the review malformed. Write `None.`
  when there are no findings.
- `## Phase 3 must check` is a `- ` list of questions. This is where every check
  goes; Phase 2 runs no analysis.
- The last non-empty line is `Status: DONE`, `DONE_WITH_CONCERNS` or `BLOCKED`.
  `BLOCKED` means you could not review (the card or the criteria were
  unreadable, `deepis` was down): the owner re-dispatches you. There is no
  `handoff.md` for a reviewer.
- Give a problem you believe the other reviewer will also raise the **same
  severity**. The merge treats two findings as high confidence only when
  criterion, severity and substance match; a shared problem rated differently at
  each desk becomes two weaker findings.

The rules for bash: spell paths in full in your bash commands — a review is free
prose — and never combine `..` with a glob; do not use bash to write files —
use the write tool so the guard sees every write. Your bash is for `deepis`, for
`check-citations.ts` on your own review file, and for reading: no shell writes,
no scripts, no analysis.

## 4. Citations

Every literature claim carries a `[@chunk]` id; every quoted sentence is
verbatim in the chunk it cites; titles and terms are *italicised*, not quoted.
Before you finish, run

`node ./harness/tools/check-citations.ts workspace/reviews/a.md`

on the file you wrote (with `b.md` if that is yours), **without pipes** — a
trailing `2>&1` is fine — until it exits 0. Exit 1 names the unresolved ids and
the quotes in a neighbouring chunk: repoint the citation at the chunk you read,
or drop the claim, never edit a quote to make it pass. Exit 2 means `deepis` is
unreachable: retry, then close the review `Status: BLOCKED`.

## Definition of Done

The file is the one **your task text names**, has every section above exactly
once, and each criterion and check starts with its `Rating:`/`Result:` line; all
findings are under `## Findings` in the given form; `## Phase 3 must check`
holds the questions instead of analysis; every citation resolves and every quote
is verbatim (`check-citations` exit 0); paths are spelled in full in your bash
commands; the last non-empty line is `Status: DONE` (or `DONE_WITH_CONCERNS`
naming the concern, or `BLOCKED` with the reason). You read only the brief's
paths — no other review, no sibling puzzle, no `owners/`, no dataset, no
hold-out.
