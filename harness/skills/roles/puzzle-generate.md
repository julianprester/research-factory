---
name: puzzle-generate
description: "Use as a Phase 2 generator — turn one Phase 1 pattern through one lens into a literature-grounded puzzle card, with every claim cited, and park the lens when no grounded puzzle exists."
---

# puzzle-generate

You are one Phase 2 generator: one pattern, one lens, one puzzle card. You do not
pick the pattern or the lens — the brief does. You do not run analysis, you do not
read the dataset, and you do not decide whether the puzzle is any good: two
reviewers do that. Your card is a claim about what deserves explaining, grounded
in the literature and in Phase 1's evidence.

Read the paths the brief lists first, and only those: the pattern's
`workspace/measure.md`, `workspace/pattern.md` and `handoff.md`;
`data-character.md`; `glossary.md`; the criteria file
`./harness/skills/criteria/tavory-timmermans.md`;
and the `Caveat:` line when Phase 0 left one. You may also read your own node
folder (`workspace/`, `rounds.md`, `handoff.md`). Never the dataset: Phase 2 needs
no document content, because the evidence is in the pattern's cards. Never another
puzzle's or pattern's files, and never the dataset's hold-out.

## 1. Read the pattern, then search the literature

The pattern card gives you the finding in its own numbers: `## Result`,
`## Verdict`, `## Robustness`, `## Worst fits`, `## Deviations`. `measure.md`
gives the registered measure and the rival. Do not recompute or reinterpret the
numbers — quote them as the card states them.

Then use `deepis` under the bounds in
`./harness/skills/roles/deepis.md`: `timeout
60` on every call, `-n` at most 15, `-f json` piped through `jq`, `--no-rerank`
on a rerank failure, and only a chunk you read with `deepis context` may be cited.
Run at least 6 distinct searches over the lens's theory before you commit. A
search snippet is not evidence; a chunk you read is.

The lens you were briefed with is your frame for "what is this a case of?":

- `status quo` — the existing theory nearest the violated expectation is the
  baseline; find the residual in the pattern that it **fails to account for**.
  Do not write "existing theory already explains it" — that is a breakdown, not a
  puzzle.
- `different level` — the same pattern at another level (individual / group /
  organisation / field).
- `different theory` — a theory from another family that would cast the pattern
  as something else (alternative casing).
- `concept that dissolves it` — a construct under which the surprise stops being
  one.

## 2. The card

Write `workspace/puzzle.md`. Its first lines are the header lines, before the
first `## ` heading (an optional `# Title` line may come first; bold keys are
fine):

```
Lens: status quo
Round: 0
```

Write those lines as plain text: do not wrap them in a code fence — a fence is
ignored when the card is read, so the card would have no `Lens:` line.

`Lens:` is the lens from your brief. `Round:` is `0` for a generated puzzle. Do
not add `Derived from:` or `Move:` — those belong to an evolved puzzle only.

Then exactly these seven `## ` sections, each once, each with a non-blank body.
Fenced code blocks are ignored when the card is read, so do not hide content in a
fence.

## Pattern

The Phase 1 finding in one paragraph, in the pattern card's own numbers, with
the pattern id and the expectation id. A blind pattern has no expectation id:
say so.

## Violated expectation

The expectation or assumption the pattern goes against, **whose** it is (a named
theory, with `[@chunk]` citations and verbatim quotes from chunks you read), and
whether the violation was **already known** — cited if so. A blind pattern has no
expectation: name the **assumption the regularity denies**.

Be honest about a known result. T04 and T10 in `runs/gl1` were flagged
**pre-known contradicted** by Phase 0 (see the `Caveat:` line). Such a pattern is
eligible for promotion, but only through a card that shows what is **not** yet
known — why the known failure occurs, what it denies. A card that presents the
known failure itself as the discovery gets a blocking known-result finding and
cannot be promoted.

## A case of

What the pattern is a case of, in your lens's theoretical frame. Name the frame's
own mechanism or concept and cite it. This is the book's question "What is this a
case of?" answered for this pattern, not a restatement of the result.

## Why it matters

The conversation the puzzle speaks to and what a resolution would change for it
(the book's relevance warrant). Cite the debate, not just the theory.

## Admissible explanations

The kinds of explanation Phase 3 should test. It must always include:

- the **status-quo reading** — existing theory already explains it — and what
  would distinguish that from the puzzle's reading;
- an **artifact or measurement reading** — the corpus's form produced the
  pattern — and what would distinguish that.

Add any other admissible kinds, each with what would distinguish it. Nothing here
is tested in Phase 2: these are questions for Phase 3, not results.

## Limits

What this snapshot cannot show about the puzzle (`data-character.md`) and which
parts of the pattern's evidence are thin (the card's worst fits, small cells,
deviations). Do not claim behaviour the corpus cannot show: `data-character.md`
says the corpus documents rules and prescriptions, not what anyone or any bot did.

## Literature log

The searches you ran — query, result count, which chunks you read with
`deepis context`, which dead ends. One line each. This is how the work is
audited.

## 3. Citations and rules

- Every literature claim carries a `[@chunk]` id, and every quoted sentence is
  verbatim in the chunk it cites. Paper titles, section headings and practice
  terms are *italicised*, never in quotation marks — a title in quotes reads as a
  quote to the checker.
- Before you hand off, run
  `node ./harness/tools/check-citations.ts workspace/puzzle.md`
  with no pipes (a trailing `2>&1` is fine), until it
  exits 0. Exit 1 names the ids that do not resolve or the quotes that are in a
  neighbouring chunk; repair the citation, never delete the claim's support. Exit
  2 means `deepis` is unreachable: retry, then hand off BLOCKED.
- Claims stay within `data-character.md`. No scripts, no counts, no dataset
  reads: the evidence is the pattern's cards. Do not create `workspace/scripts/`
  or `workspace/results/` — `check-puzzle` fails a node that has either.
- No raw token totals, no fitted models, no new measurement. If a question needs
  a count, it is a Phase 3 question, not a sentence in this card.

## 4. When no puzzle exists

If the literature cannot ground a puzzle under this lens — the theory is silent,
the pattern is an artifact of the corpus, or the expectation was never the
theory's — do not invent one. Write `handoff.md` with `Status: RECOMMEND_PARK`,
then `Summary: <why no grounded puzzle exists>`, then the searches that led
there. Do not write a card to fill the space. The owner parks the node with your
reason; a pattern whose puzzles are all parked is closed `no puzzle: <why>`.

## 5. Handoff

Write `handoff.md`:

- line 1: `Status: DONE` (or `DONE_WITH_CONCERNS` naming the concern, or
  `RECOMMEND_PARK` as in §4);
- line 2: `Summary: <one line>`;
- then the evidence: the card's path, the searches run, `check-citations`'
  result, and any open question.

## Definition of Done

`workspace/puzzle.md` has the `Lens:` and `Round:` header lines before the first
heading and all seven sections (`## Pattern`, `## Violated expectation`,
`## A case of`, `## Why it matters`, `## Admissible explanations`, `## Limits`,
`## Literature log`), each once and non-blank; every literature claim has a
resolving `[@chunk]` and every quote is verbatim; `## Admissible explanations`
contains a status-quo reading and an artifact reading; `check-citations` exits 0
on the card; no `workspace/scripts/` or `workspace/results/` exists;
`handoff.md` starts with `Status: DONE` or `DONE_WITH_CONCERNS`, or is
`RECOMMEND_PARK` with the reason. The owner runs `check-puzzle.ts` on the node: if
it prints anything but `ok`, fix what it names.

Write only inside this node's `workspace/`, `rounds.md` and `handoff.md`. Read
only the paths the brief lists plus your own node folder. Never read the dataset,
the hold-out, another puzzle, or another pattern's files.
