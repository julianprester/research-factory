---
name: puzzle-evolve
description: "Use as a Phase 2 evolution worker — derive one child puzzle card from a parent card and its merged review, using one of the four moves, and let the child compete with the frozen parent."
---

# puzzle-evolve

You are one Phase 2 evolution worker: one parent puzzle, one move, one **new**
card. The parent stays frozen — you never edit it. Its card and its merged review
are your inputs; your child competes with the parent in the next round.

Read the paths the brief lists first, and only those. For your own card the
brief names:

- the parent's card `workspace/puzzle.md` (in the parent's folder);
- the parent's merged review `workspace/reviews/merged.md` (in the parent's
  folder) — a generator may see critique; only the judge may not;
- the previous round's meta-review,
  `owners/phase-2/meta-review-<n-1>.md` when the brief names one;
- the pattern's `workspace/measure.md`, `workspace/pattern.md` and `handoff.md`;
- `data-character.md`, `glossary.md`, the criteria file
  `./harness/skills/criteria/tavory-timmermans.md`,
  and the pattern's `Caveat:` line when there is one;
- the move and the round from your brief.

Never the dataset (the evidence is the cards), never the hold-out, never another
puzzle's files, never the reviews folder of any puzzle except the parent's
`merged.md`, and never `owners/` beyond the meta-review the brief names.

## 1. Read the critique, choose the work

The merged review is the diagnosis, and the move your brief names is the
treatment:

- `grounding` — fix the review's blocking and major findings: add the missing
  rival, repair a citation, answer a negative case with literature.
- `simplification` — cut what does not carry weight: a paragraph that restates
  the pattern, a citation that decorates rather than supports, a claim the
  evidence cannot carry.
- `out-of-the-box` — recast the puzzle through another lens or shift its level
  (individual / group / organisation / field); the pattern stays the evidence.
- `combination` — join two puzzles from different patterns into one child. The
  brief names both parents; the child is created under the first parent's pattern
  node with both ids in `Derived from:`. The joined puzzle must be one puzzle,
  not two cards stapled together: state the shared frame and what each parent
  contributes.

The meta-review lists weaknesses that recur across the round's reviews (a missing
kind of rival, an over-claim about behaviour, a thin "why it matters"). Fix those
too where they apply to this child: they are there so the next round does not
repeat them. Never quote the meta-review into the card and never cite it as a
source — it is guidance, not literature.

## 2. The child card

Write a new `workspace/puzzle.md` in your own node folder. Its header lines come
before the first `## ` heading (an optional `# Title` line may come first):

```
Lens: <the lens from the brief>
Round: <the round from the brief>
Derived from: P01, P03
Move: grounding
```

`Derived from:` names **exactly** the ids in the node's `derivedFrom`, in any
order. `Move:` is exactly one of `grounding`, `simplification`,
`out-of-the-box` or `combination` — the move your brief names. `Lens:` is the
lens the child now argues through (a recast changes it; otherwise keep the
parent's). `Round:` is the evolution round number.

Then exactly the same seven `## ` sections as any puzzle card, each once and
non-blank. Fenced code blocks are ignored when the card is read, so do not hide
content in a fence.

## Pattern

The Phase 1 finding in one paragraph, in the pattern card's own numbers, with the
pattern id and the expectation id (a blind pattern says it has none). For a
combination, state the finding each parent rests on.

## Violated expectation

The expectation or assumption the pattern goes against, whose it is (a named
theory, with `[@chunk]` citations and verbatim quotes), and whether the violation
was already known — cited if so. A blind pattern names the assumption the
regularity denies. A pre-known contradicted pattern (T04/T10, see the `Caveat:`)
is honest here about what is known and claims only what is not.

## A case of

What the pattern is a case of in this child's frame. Name the mechanism or
concept and cite it. For `out-of-the-box` this is where the recast is argued; for
`combination` it is the shared frame both parents enter.

## Why it matters

The conversation the puzzle speaks to and what a resolution would change for it.
Cite the debate. `simplification` usually shortens this section without losing
the warrant.

## Admissible explanations

The kinds of explanation Phase 3 should test, always including the status-quo
reading (existing theory already explains it) and an artifact or measurement
reading (the corpus's form produced it), each with what would distinguish it.
Nothing here is tested in Phase 2. `grounding` answers a review finding here by
naming the rival the review missed.

## Limits

What this snapshot cannot show (`data-character.md`) and which parts of the
pattern's evidence are thin (worst fits, small cells, deviations). If the review
found an over-claim about behaviour, the correction belongs here as well as in
the claim it fixes.

## Literature log

The searches behind the child — query, result count, chunks read with
`deepis context`, dead ends. Keep the parent's log entries you relied on and add
your own; do not present a search you did not run.

## 3. Citations and rules

- Run every citation check yourself. The parent's citations are inputs, not
  vouched-for: re-read the chunk and keep the `[@chunk]` only if the quote is
  verbatim there.
- Use `deepis` under the bounds in
  `./harness/skills/roles/deepis.md`:
  `timeout 60`, `-n` at most 15, `jq`-compacted output, `--no-rerank` on failure,
  and only a chunk read with `deepis context` may be cited. Titles and terms are
  *italicised*, never quoted.
- Before you hand off, run
  `node ./harness/tools/check-citations.ts workspace/puzzle.md`
  without pipes (a trailing `2>&1` is fine) until it exits 0. Exit 1 names the
  ids and quotes to repair; exit 2 means `deepis` is unreachable — retry, then
  hand off BLOCKED.
- No scripts, no counts, no dataset reads: the evidence is the cards. Never
  create `workspace/scripts/` or `workspace/results/` — `check-puzzle` fails a
  node that has either. A question that needs a count goes in
  `## Admissible explanations` as what Phase 3 would test, not as a result here.
- Never edit the parent's card, the parent's reviews, or the parent's node in any
  way. The parent is frozen; the child is a new node and a new card.

## 4. Handoff

Write `handoff.md`:

- line 1: `Status: DONE` (or `DONE_WITH_CONCERNS` naming the concern, or
  `BLOCKED` with the reason);
- line 2: `Summary: <one line>`;
- then the evidence: the child card's path, the parent id and move, the findings
  of the merged review you addressed (one line each), `check-citations`' result,
  and any open question.

## Definition of Done

`workspace/puzzle.md` is a new card with the `Lens:`, `Round:`, `Derived from:`
(exactly the node's `derivedFrom`) and `Move:` header lines and all seven
sections (`## Pattern`, `## Violated expectation`, `## A case of`,
`## Why it matters`, `## Admissible explanations`, `## Limits`,
`## Literature log`), each once and non-blank; the review's blocking and major
findings that the move addresses are visibly addressed; every citation resolves
and every quote is verbatim (`check-citations` exit 0); no `workspace/scripts/`
or `workspace/results/` exists; the parent's files are untouched; `handoff.md`
starts with `Status: DONE` or `DONE_WITH_CONCERNS`. The owner runs
`check-puzzle.ts` on the node: if it prints anything but `ok`, fix what it names.

Write only inside your node's `workspace/`, `rounds.md` and `handoff.md`. Read
only the paths the brief lists plus your own node folder.
