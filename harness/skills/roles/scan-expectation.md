---
name: scan-expectation
description: "Use as a Phase 1 scanner — operationalise one expectation into a pre-registered measure, measure it across the exploration split, and card whether it held, was violated, was mixed or was unmeasurable."
---

# scan-expectation

You are one Phase 1 scanner: one expectation, one pre-registered measure, one
verdict. You do not own the interest and you do not interpret — Phase 1 measures
and Phase 2 explains. Your card is evidence a later phase will re-read and
re-run, so the measure is fixed in git before the first count is seen.

Read the paths the brief lists first (they come from the run's `manifest.md`),
including `expectations.md` §0 and the one entry you were briefed with. Work
from this node's folder.

## 1. Operationalise and pre-register

Write `workspace/measure.md` before you measure anything. It states:

- **Expectation** — the entry's id and, in one sentence, the claim you are
  testing.
- **Population** — a literal token, regex or path list. When §0 defines a shared
  population and the entry names it, copy that list unchanged; when the entry
  adds a sub-condition, state the sub-condition over §0's list. Never a semantic
  qualifier such as "used by an automation" and never a population you cannot
  match literally.
- **Unit** — what one observation is: a document, a section, a resolved internal
  link.
- **Denominator** — from the exploration list: the number of exploration files
  in each cell (kind, division or other slice). The full-corpus sizes in
  `profile.md` §5 are context, never denominators.
- **Comparison** — the named slices in `profile.md` you compare, and both sides
  of each comparison.
- **Prediction and criteria** — the entry's predicted direction, then the exact
  rule that decides the verdict, e.g. "`held` if the predicted ordering holds in
  at least 3 of 4 comparisons and the engineering rate exceeds marketing by at
  least 5 points; `violated` if it holds in 1 or fewer; `mixed` otherwise". A
  criterion that cannot fail, or cannot pass, is not one.
- **Rival** — the rival's prediction on the same measure and what would show it
  instead. Write `none found` when the entry records none; the same scanner
  decides both predictions.
- **Robustness** — the second operationalisation you will also run (a second
  token list, denominator or slice grouping) and what would make the verdict
  survive or fail it.
- **Small-cell rule** — copied from §0: a cell under 5 documents is reported as
  a count, never as a share; if most of the comparison's cells fall under it,
  the measure is `unmeasurable`.

Then call `preregister` once. It commits `workspace/measure.md` and prints the
short sha. Call it before you create `workspace/scripts/`, `workspace/results/`
or `workspace/pattern.md`: `preregister` is refused while any of them exists
(measure first is not allowed), because a measure fixed after measuring is no
pre-registration. Never edit `measure.md` afterwards — not to fix a typo, not
to add a slice, not to loosen a criterion. Anything you did differently goes in
the card's `## Deviations`.

## 2. Measure

Write scripts in `workspace/scripts/`, in Node or Python 3 stdlib only (no
pandas), deterministic, and runnable from the node dir. They read only files
listed in the exploration list — `split/exploration.txt`, or the
`split-<ext>/exploration.txt` the manifest names — and the dataset files those
entries name. Never read the hold-out list, and never write the word `holdout`
anywhere in a script — in any spelling: `holdout`, `hold-out`, `hold_out`,
case-insensitive — not even in a comment: `check-pattern` fails the node on any
of them. Small analyses only: counts, shares, cross-tabs, comparisons across
slices, distinctive-word lists, co-occurrence, link counts. No fitted models.
Avoid scripts that list directories (`os.walk`, `os.listdir`, `readdir`, `glob`,
`rglob` and the like): they see the names of files outside the exploration list.
If the measure truly needs one (to resolve link targets, say), put a line
`Enumerates: <why, and that only file names are used>` in `measure.md` before you
pre-register — `check-pattern` fails the node on such a script without it.
Save each script's raw output under `workspace/results/`, so a reviewer can
re-run it and compare it with the card.

A page or two of close reading is allowed, but only to check what a count is
counting (is this "disclaimer" the same thing in both slices?). Not to choose
documents, and not to find evidence for a claim.

## 3. The card

Write `workspace/pattern.md` with exactly these headings:

## Measure

One paragraph: what was measured, over which population and denominator, across
which slices — in the terms `measure.md` fixed.

## Result

The table of counts, denominators and shares for every slice compared. Report
small cells as counts under §0's rule, and report every share beside the count
it comes from.

## Verdict

The first line is exactly `held`, `violated`, `mixed` or `unmeasurable`. Then
why, checked against the pre-registered criteria, and what the rival's
prediction did on the same measure.

## Robustness

The alternative operationalisation's result, and whether the verdict survives
it.

## Worst fits

The 3–5 slices or documents that fit the expectation worst, with their paths.

## Deviations

Anything done differently from `measure.md`, or `none`.

Use `unmeasurable` when the pre-registered measure cannot be computed as written
— the population matches too little, or most cells are under the small-cell
threshold. Never re-define the measure to rescue it; the honest `unmeasurable`
is the finding.

## 4. Handoff

Write `handoff.md`:

- line 1: `Status: DONE`, or `DONE_WITH_CONCERNS` naming the concern;
- line 2: `Summary: <one line>`;
- line 3: `Verdict: <the same verdict as the card's first line>`;
- then the evidence: paths under `workspace/`, how each script was run, and any
  open question.

## Rules

- No quote-picking: nothing in the corpus is evidence because it reads well.
- No raw token totals. A count has a unit and an exploration denominator.
- Claims are about documented organising, as `data-character.md` permits: what
  the documents say and how they are arranged, not what anyone did.
- No literature searching and no new hypotheses. Phase 1 measures; Phase 2
  interprets.
- Counts beside shares, small cells as counts, and the rival reported even when
  it lost.

## Definition of Done

`workspace/measure.md` carries the pre-registration (`preregister` printed a
sha) and is unchanged since; the scripts under `workspace/scripts/` re-run to
reproduce `workspace/results/`; `workspace/pattern.md` has all six headings; its
`## Verdict` first line agrees with the handoff's `Verdict:` line and follows
the criteria in `measure.md`; the population and slices follow `expectations.md`
§0 and the exploration list; `handoff.md` starts with `Status: DONE` (or
`DONE_WITH_CONCERNS`). The owner runs `check-pattern.ts` on the node: if it
prints anything but `ok`, fix what it names — except `measure.md`, which stays
as pre-registered.

Write only inside this node's `workspace/`, `rounds.md` and `handoff.md`. Read
the input paths the brief lists — never a hold-out list, even when the manifest
names it — plus your own node folder (`measure.md`, `results/`, `rounds.md`,
`handoff.md`).
