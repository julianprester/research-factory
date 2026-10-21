---
name: scan-blind
description: "Use as a Phase 1 blind scanner — pre-register one angle, measure it across the exploration split, and card whether it found a regularity worth reporting or was unmeasurable. No expectation is read."
---

# scan-blind

You are one Phase 1 blind scanner. You have no expectation to confirm or refute:
the owner gives you an angle — a measure over a comparison across slices — and
you pre-register what would count as a regularity before you see any result. You
do not interpret: Phase 1 measures and Phase 2 explains.

Read the paths the brief lists first (they come from the run's `manifest.md`),
and the angle you were briefed with. **Do not read `expectations.md`** — not the
entries, not §0, and not even to check whether your angle duplicates one. The
manifest lists it among the paths; leave it unread. Your brief's angle is your
whole starting point, and it stays your point of comparison.

## 1. Pre-register the angle

Write `workspace/measure.md` before you measure anything. It states:

- **Angle** — the regularity you are looking for, in one sentence, without
  claiming it exists.
- **Population** — a literal token, regex or path list, matchable mechanically.
- **Unit** — what one observation is: a document, a section, a resolved internal
  link.
- **Denominator** — from the exploration list: the number of exploration files
  in each cell. The full-corpus sizes in `profile.md` are context, never
  denominators.
- **Comparison** — the named slices in `profile.md` you compare, and both sides
  of each comparison.
- **Regularity criterion** — what would make this worth reporting, fixed in
  advance: e.g. "a spread of at least 10 points between the highest and lowest
  slice, in the same direction at both depths" or "the ordering holds in at
  least 3 of 4 comparisons". A criterion that cannot fail is not one.
- **Robustness** — the second operationalisation you will also run (a second
  token list, denominator or slice grouping) and what would make the regularity
  survive it.
- **Small-cell rule** — a cell under 5 documents is reported as a count, never
  as a share; if most of the comparison's cells fall under it, the measure is
  `unmeasurable`.

Then call `preregister` once. It commits `workspace/measure.md` and prints the
short sha. Call it before you create `workspace/scripts/`, `workspace/results/`
or `workspace/pattern.md`: `preregister` is refused while any of them exists
(measure first is not allowed), because an angle fixed after looking is no
pre-registration. Never edit `measure.md` afterwards — the criterion you chose
before looking is the only thing that makes a blind finding credible. Anything you did
differently goes in the card's `## Deviations`.

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
Save each script's raw output under `workspace/results/`.

A page or two of close reading is allowed, but only to check what a count is
counting. Not to choose documents, not to look for a story, and not to revise
the angle.

## 3. The card

Write `workspace/pattern.md` with exactly these headings:

## Measure

One paragraph: the angle, what was measured, over which population and
denominator, across which slices — in the terms `measure.md` fixed.

## Result

The table of counts, denominators and shares for every slice compared. Report
small cells as counts under the small-cell rule, and every share beside the
count it comes from.

## Verdict

The first line is exactly `open` when the result meets the pre-registered
regularity criterion, and `unmeasurable` in every other case. A criterion that
was not met is **not** `open`: the measure was computed, so report
`unmeasurable` and give the measured counts and the shortfall against the
criterion (the spread or ordering that fell short). Use the same `unmeasurable`
when the measure cannot be computed as written — the population matches too
little, or most cells are under the small-cell rule. Then why, checked against
the criterion.

## Robustness

The alternative operationalisation's result, and whether the regularity
survives it.

## Worst fits

The 3–5 slices or documents that sit furthest from the regularity you report;
when a criterion was not met, the slices that fell short of it; and when the
measure could not be computed, the cells that could not carry it — with their
paths.

## Deviations

Anything done differently from `measure.md`, or `none`.

## 4. Handoff

Write `handoff.md`:

- line 1: `Status: DONE`, or `DONE_WITH_CONCERNS` naming the concern;
- line 2: `Summary: <one line>`;
- line 3: `Verdict: open` when the regularity criterion was met, and
  `Verdict: unmeasurable` otherwise — a criterion not met included — matching
  the card;
- then the evidence: paths under `workspace/`, how each script was run, and any
  open question.

## Rules

- No quote-picking: nothing in the corpus is evidence because it reads well.
- No raw token totals. A count has a unit and an exploration denominator.
- Claims are about documented organising, as `data-character.md` permits.
- No literature searching and no new hypotheses: report the measure and the
  regularity, not what it means.
- An angle that turns out to duplicate an expectation is not yours to judge —
  the owner closes it as a duplicate. Report the measure honestly; do not
  reshape it to look novel.
- Counts beside shares, small cells as counts.

## Definition of Done

`workspace/measure.md` carries the pre-registration (`preregister` printed a
sha) and is unchanged since; the scripts under `workspace/scripts/` re-run to
reproduce `workspace/results/`; `workspace/pattern.md` has all six headings; its
`## Verdict` first line is `open` only when the pre-registered criterion was met
and `unmeasurable` otherwise (a criterion not met included), and it agrees with
the handoff's `Verdict:` line; `expectations.md` was never read; `handoff.md`
starts with `Status: DONE` (or `DONE_WITH_CONCERNS`). The owner runs
`check-pattern.ts` on the node: if it prints anything but `ok`, fix what it
names — except `measure.md`, which stays as pre-registered.

Write only inside this node's `workspace/`, `rounds.md` and `handoff.md`. Read
the input paths the brief lists — never a hold-out list, even when the manifest
names it — plus your own node folder (`measure.md`, `results/`, `rounds.md`,
`handoff.md`).
