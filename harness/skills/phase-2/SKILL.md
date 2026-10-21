---
name: phase-2
description: "Use when you own Phase 2 (puzzles) of a research-factory run: turn each Phase 1 pattern into literature-grounded puzzles, review every puzzle twice, rank and evolve them in the tournament, and promote the ones the tournament keeps."
---

# Phase 2: puzzles

You are the Phase 2 owner. Follow **phase-owner** for the loop, ledger, dispatch
form, fix loop and handoff statuses; this skill only says what Phase 2's nodes
are, in what order, and when it ends. Keep at most 4 workers active.

Phase 2 interprets. Phase 1 left you patterns — measured surprises. Phase 2 turns
each one into one or more **puzzles**: a puzzle says what the pattern is a case
of, whose expectation it violates, why it matters and which explanations it
admits. Two independent reviewers rate each puzzle, a judge ranks the pool, and
evolution rounds improve the leaders. Phase 2 runs no analysis: the evidence is
Phase 1's cards. The strongest puzzles are promoted to Phase 3; everything else
is parked.

## 0. Budget ruling, then resume

Before anything else, expect hours, not minutes: a live run is 20+ generation
workers, twice as many reviewers, and a judge that plays every match in both
orders. Record the budget you will hold yourself to:

`Ruling: Phase 2 budget — <hours> — rounds funded: round 0 plus <N> evolution rounds — <does that fund the cap of four evolution rounds, and so a guaranteed code STOP? if not, say so> — <cost if wrong: an unfinished loop, or nothing promotable>`

A `Ruling:` can stop the loop, but it records no STOP: only `judge_round`
records one, and `promote` refuses without it. **Budget round 0 plus up to four
evolution rounds**: the cap at round 4 is the only point where a code STOP is
guaranteed, so a budget that funds fewer than four can end in `CONTINUE` with no
STOP — say plainly in the ruling that a code STOP is not guaranteed and
promotion may be impossible. Estimate before you promise: generation and
reviews are hours at concurrency 4 (22 generators plus 44 reviewers in the first
run); each judge round is the engine's 8-minute stretches repeated until it
reports `COMPLETE`; each evolution round adds its children, their two reviews
and a judge round. If the budget is nearly spent mid-loop, record `loop
truncated: no STOP recorded, nothing promotable` and park every puzzle `no STOP
reached` — do not pretend promotion is possible.

Then resume. Call `tree_list({})` — all phases, not just phase 2 — and continue
from what exists. Never recreate work:

- A puzzle node already exists under a pattern: do not create another for the
  same lens. Re-brief it only when its `handoff.md` is missing or starts with
  neither `DONE`/`DONE_WITH_CONCERNS` nor `RECOMMEND_PARK`/`BLOCKED`; §3
  handles the last two by the park and fix rules, not by a re-brief.
- `owners/phase-2/tournament/rounds.json` exists: read it before doing anything.
  A recorded `STOP` is final — no new evolution children, no further round.
- Otherwise resume wherever the nodes leave off.

Puzzle statuses are `ready → active → submitted`, with `parked` for anything
culled. `promote` moves a submitted puzzle to phase 3 as `ready`; there is no
`promoted` status to set. A puzzle can be `parked` at any point after it is
created.

## 1. The job list

`tree_list({ phase: 2 })`, with no status filter. The pattern nodes Phase 1
handed on are `ready` and each one is a job.

Take each pattern node in turn and **first move it to `input`**:

`tree_update({ nodeId: "<T..>", status: "input" })`

`input` means "this phase's job list": it keeps Phase 2 alive for the supervisor,
it is never briefed or dispatched, and you close it at the end (§8). Moving it
first also stops the supervisor thinking the phase is idle while you read.

For each pattern, read its evidence before you brief anything:

- its `workspace/measure.md` (the registered measure and rival) and
  `workspace/pattern.md` (Result, Verdict, Robustness, **Worst fits**, Deviations);
- its `handoff.md`;
- `data-character.md` and `glossary.md` from the Phase 0 input node's manifest;
- the Phase 0 caveats. Read the Phase 0 input node's `handoff.md`, its
  `workspace/summary.md`, and the hand-off note on the commit that moved it to
  Phase 2 (`git -C <run dir> log -1 --format=%b -- <input node dir>/node.json`).
  The Phase 0 input node is the assembler under `prep/` (e.g.
  `prep/Z06-assemble`); in `runs/gl1` the pattern nodes' routing notes do not
  carry its caveats, so read those files.

You read these files; you never read the dataset. Record each warning Phase 0
left as a ledger line `Caveat: E<n> — <what Phase 0 said>`, and put a `Caveat:`
line with those words in the brief of every puzzle on that pattern. T04 and T10
in `runs/gl1` were flagged **pre-known contradicted**: a puzzle on such a pattern
may be promoted, but only if its card shows what is *not* yet known (why the
known failure occurs, what it denies). A puzzle that presents the known failure
itself as the finding gets a blocking known-result finding and cannot be promoted.

## 2. Generation

For each pattern, create **2** puzzle nodes in the first run (more later only by
ruling). Each puzzle gets one **lens** — a different theoretical frame for "what
is this a case of?":

- `status quo` — the existing theory nearest the violated expectation as the
  baseline, asking what in the pattern it **fails to account for**. It is a lens
  for the residual puzzle, not an invitation to write "existing theory already
  explains it";
- `different level` — the same pattern at another level (individual / group /
  organisation / field);
- `different theory` — a theory from another family that would cast the pattern
  as something else (alternative casing);
- `concept that dissolves it` — a construct under which the surprise stops being
  one.

A blind pattern (no expectation) names the **assumption the regularity denies**
in `## Violated expectation`.

Create each node:

`tree_create({ parentId: "<T..>", title: "<lens>: <short title>" })`

Record the choice before you brief:

`Ruling: <T..> lenses — <lens A> and <lens B> — <why these two for this pattern> — <cost if wrong: one puzzle a better lens would have found>`

Write `brief.md` in the puzzle node folder with exactly these five sections:

- **Role:** puzzle generator for `<T..>` through the `<lens>` lens.
- **Skill:** `./harness/skills/roles/puzzle-generate.md`
- **Inputs:** the pattern node's `<pattern node dir>/workspace/measure.md`,
  `<pattern node dir>/workspace/pattern.md` and `<pattern node dir>/handoff.md`;
  `data-character.md` and `glossary.md` at the absolute paths `manifest.md`
  names; the criteria file
  `./harness/skills/criteria/tavory-timmermans.md`;
  the lens; and the pattern's `Caveat:` line when Phase 0 left one. No hold-out
  path, and no other puzzle's or pattern's files.
- **Outputs:** `workspace/puzzle.md` and `handoff.md`.
- **Definition of Done:** the role file's DoD, copied in.

Dispatch it with `ctc-worker`, as phase-owner says:

`subagent({ agent: "ctc-worker", async: true, cwd: "<puzzle node dir>", task: "Read brief.md and carry it out." })`

Append the ledger line for the dispatch — it names the run id from the dispatch
receipt — then immediately `tree_update` the node `active`:
`tree_update({ nodeId: "<P..>", status: "active" })`. For every other decision,
write each ledger line immediately before the tree/tool call it records; never
after the last tree call.

## 3. On a generator handoff

Read the node's `handoff.md` and act on its status line first.

- `RECOMMEND_PARK` — the worker could not ground a puzzle in the literature.
  Park the node with the reason: `tree_update({ nodeId: "<P..>", status: "parked", note: "<the reason>" })`.
  If every puzzle of that pattern is now `parked`, record
  `Ruling: <T..> no puzzle — <why> — <cost if wrong: a pattern Phase 3 never sees>`
  and close the pattern node with the note `no puzzle: <why>`. The barrier never
  waits on it.
- `DONE` / `DONE_WITH_CONCERNS` — run the checker from the node dir:
  `node ./harness/tools/check-puzzle.ts <node dir>`
  It prints `ok` and exits 0 when the card may be reviewed; any other output goes
  back through phase-owner's fix loop (resume the worker with the problem lines).
  Exit 2 is a usage error — fix the command, not the node.
- `BLOCKED` — phase-owner's fix loop.

## 4. Reflection: two reviewers, then the merge

When a puzzle's card passes the checker, write `brief-review.md` in the **puzzle
node folder** (the owner may write `brief.md` and `brief-review.md` there and
nothing else). Exactly these five sections:

- **Role:** independent reviewer of puzzle `<P..>`; your task text names your
  slot (`a` or `b`).
- **Skill:** `./harness/skills/roles/puzzle-review.md`
- **Inputs:** the puzzle's own card `workspace/puzzle.md`; the pattern node's
  `<pattern node dir>/workspace/measure.md`, `<pattern node dir>/workspace/pattern.md`
  and `<pattern node dir>/handoff.md`; `data-character.md` and `glossary.md` at
  the absolute paths `manifest.md` names; the criteria file
  `./harness/skills/criteria/tavory-timmermans.md`;
  and the pattern's `Caveat:` line when there is one. **No other puzzle or
  review path** — not a sibling puzzle, not the other reviewer's file, not
  `merged.md`.
- **Outputs:** whichever of `workspace/reviews/a.md` or `workspace/reviews/b.md`
  your task text names; the brief never names a slot.
- **Definition of Done:** the role file's DoD, copied in.

Dispatch **both reviewers of a puzzle concurrently**: two calls in one turn, each
with its own task text naming `a` or `b`:

`subagent({ agent: "ctc-reviewer", async: true, cwd: "<puzzle node dir>", task: "Read brief-review.md and write workspace/reviews/a.md" })`
`subagent({ agent: "ctc-reviewer", async: true, cwd: "<puzzle node dir>", task: "Read brief-review.md and write workspace/reviews/b.md" })`

Reviewers are `ctc-reviewer`, never `ctc-worker`: the reviewer extension refuses
every call outside a puzzle node and lets the reviewer write only its own review.
When both have finished, merge and check from the node dir:

`node ./harness/tools/merge-reviews.ts <node dir>`
`node ./harness/tools/check-puzzle.ts <node dir> --reviews`

`merged.json` must equal the merge of exactly the current `a.md` and `b.md`, so
re-run `merge-reviews.ts` after **any** review edit, then `check-puzzle` again.
Read `workspace/reviews/merged.md`: it carries the per-criterion ratings and the
flags `breakdown`, `knownResultBlocking`, `dataCharacterViolated` and
`reviewBlocked`. `reviewBlocked` means a reviewer closed `Status: BLOCKED` — an
aborted review. When the checks pass, set the node `submitted`:
`tree_update({ nodeId: "<P..>", status: "submitted" })`.

**Review recovery.** If `merge-reviews.ts` or `check-puzzle --reviews` names a
review file (for example `workspace/reviews/a.md: …`), re-dispatch **only that
reviewer**, with the same `brief-review.md` and the task text naming that slot:
up to 2 times, then once with a fresh `ctc-reviewer` (a new `subagent` run, same
brief). If it still fails, park the puzzle `review-failed: <why>` — a puzzle
with no usable merge cannot be ranked. The same cap applies when `reviewBlocked`
is set: re-dispatch the blocked reviewer up to 2 times, then once fresh, then
park `review-failed: reviewer blocked`. Never re-dispatch both reviewers for one
failing file, and never loop past that cap. **This cap (2 re-dispatches plus 1
fresh reviewer) overrides phase-owner's fix-loop cap here**, because
phase-owner's cap is written for a worker's `handoff.md`, not for a review file.

## 5. Round 0

When every pattern has been through generation and review — no puzzle node is
`ready` or `active`, and every `submitted` puzzle has its card, both reviews and
the merge — call:

`judge_round({ round: 0 })`

Round 0 ranks the whole pool and needs at least 7 puzzles. A puzzle whose
reviews rate plausibility `fails` — a breakdown — **still enters the round-0
pool**: a ranked loss is information, nothing is culled before round 0, and
every puzzle not promoted is parked only after the final ranking. It can be
neither an evolution parent nor promoted, which the gates enforce. It can take
a while. It answers either `PARTIAL` or `COMPLETE`:

- `PARTIAL` — the round hit its 8-minute stretch. Do not change anything:
  **repeat it with the identical arguments** (same round; for round 0 that is
  `{ round: 0 }`). The log fingerprints the pool, so a resume with different
  arguments is refused.
- `COMPLETE` — read the decision, the top ranks with their 80% intervals, the
  matches played, `breaks` and `underplayed`. Round 0 never stops. Errors come
  back prefixed `judge_round:` (pool too small, another round running, header
  mismatch): fix the cause, do not retry blindly.

The judge sees only the two puzzle cards and, for the pattern each rests on, its
Measure, Result, Verdict and Worst fits. It **never** sees a review, a rating or
the meta-review.

After round 0 reports COMPLETE, write `owners/phase-2/meta-review-0.md`: the
weaknesses that **recur** across the merged reviews (a missing kind of rival, an
over-claim about behaviour, a thin "why it matters"). It goes only into the next
round's evolution briefs (and any later generation brief) and is **never shown to the judge** —
`judge_round` gives the judge the cards and the pattern evidence only and cannot
read the file.

## 6. Evolution rounds

After each COMPLETE round whose decision is `CONTINUE`, the owner picks
**parents** from the ranking. Never
choose a puzzle whose merged review has `flags.breakdown`,
`flags.knownResultBlocking` or `flags.reviewBlocked`: it cannot be promoted and
is a dead branch.

Record the round's plan before you create anything:

`Ruling: round <n> — entrants <the previous round's top 8, or every submitted incumbent ranked in it> + children <ids> = <k> identities (≥ 7); parents <P.., P..>; moves <move per child> — <why these parents and these moves> — <cost if wrong: one child that cannot beat its parent>`

**A round needs at least 7 identities in total — entrants plus children.** A
fresh child must play 6 matches, and two puzzles meet only once per round, so
with N−1 opponents a new child can reach at most N−1 matches: N must be at
least 7. Make `entrants` the previous round's top 8 (or every submitted
incumbent that was ranked in it), and **count `entrants + children` before you
create a child**: if the count is under 7, add incumbents (or children) until it
is. The `Ruling:` records the count.

Create each child under its parent's pattern node:

`tree_create({ parentId: "<T..>", title: "<move>: <short title>", derivedFrom: ["P01"] })`

The four moves:

- `grounding` — fix the review's blocking and major findings (add the missing
  rival, repair a citation, answer a negative case);
- `simplification` — cut what does not carry weight;
- `out-of-the-box` — recast the puzzle through another lens or shift its level;
- `combination` — join two puzzles from different patterns into one child. Create
  it under the **first** parent's pattern node with **both** parents in
  `derivedFrom`.

The original is frozen: parent and child compete.

Brief a child with `brief.md`, exactly these five sections. The move, round and
lens are values the worker cannot infer; name them.

- **Role:** evolution worker for `<P..>` — move
  `<grounding|simplification|out-of-the-box|combination>`, round `<n>`, lens
  `<lens>`.
- **Skill:** `./harness/skills/roles/puzzle-evolve.md`
- **Inputs:** the parent's card `<parent node dir>/workspace/puzzle.md` and its
  merged review `<parent node dir>/workspace/reviews/merged.md`; for a
  **combination**, **both parents'** `workspace/puzzle.md` and
  `workspace/reviews/merged.md`; the pattern's evidence at the absolute paths
  `<pattern node dir>/workspace/measure.md`, `<pattern node dir>/workspace/pattern.md`
  and `<pattern node dir>/handoff.md`; `data-character.md` and `glossary.md` at
  the absolute paths `manifest.md` names; the previous round's meta-review
  `owners/phase-2/meta-review-<n-1>.md` when one exists; the criteria file
  `./harness/skills/criteria/tavory-timmermans.md`;
  and the pattern's `Caveat:` line.
- **Outputs:** `workspace/puzzle.md` and `handoff.md`.
- **Definition of Done:** the role file's DoD, copied in.

Dispatch `ctc-worker`. Review each child twice, exactly as §4 (write a new
`brief-review.md` in the child's folder; dispatch both reviewers concurrently;
merge; `check-puzzle --reviews`; `submitted`).

When every child of the round is `submitted`, judge it:

`judge_round({ round: 1, entrants: ["P01", "P02", "P03", "P04", "P05", "P06", "P07", "P08"], pairs: [{ child: "P20", parent: "P01" }] })`

- `entrants` is the previous round's top 8; every parent of every child must be
  among them. Eight entrants plus one child is 9 identities, over the minimum.
- `pairs` is required for round 1 and later: one entry for every child and its
  parent. Every round needs **at least one child**: the stop *rule* treats a
  childless round as a stop, but `judge_round` refuses an empty `pairs` list.
  A pair that has already met cannot meet again — it needs a fresh child.
- `PARTIAL` — **repeat it with the identical arguments**: same round, same
  `entrants`, same `pairs`. A different forced pair on a resume is refused.

When the round reports `COMPLETE`, write
`owners/phase-2/meta-review-<n>.md`: the weaknesses that **recur** across the
merged reviews (a missing kind of rival, an over-claim about behaviour, a thin
"why it matters"). It goes **only** into the next round's generation and
evolution briefs. It is **never shown to the judge**: `judge_round` gives the
judge only the two puzzle cards and the pattern evidence, and it can read
neither the meta-review nor any review, so putting it there is impossible and
not a reason to paraphrase it into a card.

**Stop only when the tool prints `STOP`.** The code decides, after every round
from round 1: `STOP (no-child-beat-parent)` when no child beat its parent,
`STOP (top-stable)` when the top 5 is the same set as the previous round, or
`STOP (cap)` after round 4. A cap stop is a finding, not a convergence: record
in the ledger that the loop was truncated, not converged.

- **Never create an evolution child after STOP**: the tool refuses it with
  `STOP recorded (<reason>): no more evolution`.
- **never call `judge_round` again** after a STOP: the stop is a latch and the
  tool refuses further rounds.
- You cannot make an early `Ruling:` stop promotable: a ruling records no STOP,
  so `promote` refuses. Fund the whole cap as §0 says (round 0 plus up to four
  evolution rounds): anything less may leave no code STOP, and then nothing is
  promotable. If the budget is nearly spent mid-loop, record `loop truncated:
  no STOP recorded, nothing promotable`, park every puzzle `no STOP reached`,
  and say the loop promoted nothing. Never stop later than the tool.

## 7. Promotion

Promotion is code-gated and the number is yours to rule on. There is no fixed
number. Promotion also requires a **STOP recorded by `judge_round`**: if you
stopped the loop early by `Ruling:`, nothing is promotable — record `loop
truncated: no STOP recorded, nothing promotable` and park every puzzle
`no STOP reached`; do not pretend promotion is possible.

1. Check the top candidates for duplicates:
   `check_duplicates({ ids: ["P01", "P02", "<top 8>"] })`
   It judges every pair "same puzzle?" in both orders and writes
   `owners/phase-2/tournament/distinct.json`. Every id needs a Bradley-Terry
   score in the latest recorded round, so choose ids that were ranked there —
   the top 8 is the safe set. A confirmed duplicate keeps the higher-rated
   puzzle and drops the other.
2. Read the final round file `owners/phase-2/tournament/round-<n>.json`:
   `fit.scores`, `fit.lower`, `fit.upper` and `played` per puzzle. The round's
   `COMPLETE` text already printed the scores with their 80% intervals, `breaks`
   (an n such that promoting the top n leaves an interval gap) and
   `underplayed` (fewer than 6 matches).
3. Record the decision with the numbers:
   `Ruling: promote <n> — <where the break is, with the numbers> — <cost if wrong: a weak puzzle in Phase 3, or a strong one missed>`
4. `promote({ nodeId: "<P..>" })` for each chosen puzzle, in rank order. It
   moves the puzzle to Phase 3 as `ready` — there is no `promoted` status to
   set. The tool refuses, naming the gate, unless: STOP is recorded; the puzzle
   is `submitted`; it is ranked in the latest recorded round with at least 6
   matches; it is in `distinct.json` and is not a `drop`; its merged review has
   plausibility not `fails` and none of `breakdown`, `knownResultBlocking`,
   `dataCharacterViolated` or `reviewBlocked`; and `check-puzzle --reviews`
   passes. That last check runs `deepis` citation checks, so it is slow.
5. Park **every other puzzle** with a note saying why:
   `breakdown: <why>`, `duplicate of <id>`, or `ranked below the break`.
6. For any new pattern angle a review or an evolution move called for, append a
   ledger line `Pattern request: <angle>`. Nothing acts on it in this version;
   the line is the record.

Never promote around `promote`: a `tree_update` to `promoted` or to phase 3 is
refused for a puzzle, so the tool is the only way out of Phase 2.

Never write or edit anything under `owners/phase-2/tournament/`: only the tools
(`judge_round`, `check_duplicates`, `promote`) write the rounds, the matches and
`distinct.json`. Your ledger, `strategy.md`, the meta-reviews and rulings live
under `owners/phase-2/` and are yours to write.

## 8. Close

As the **last** tree call, close every pattern node you took that is still open
(`ready`/`input`); a pattern node already closed `no puzzle: <why>` stays as it
is.

`tree_update({ nodeId: "<T..>", status: "closed", note: "Phase 2 complete: <n> promoted, <m> parked, <r> rounds, stopped by <reason>" })`

`<n>` is the number of puzzles promoted, `<m>` every puzzle parked, `<r>` the
number of rounds recorded, `<reason>` the stop the tool printed (`no-child-beat-parent`,
`top-stable`, `cap`, or `no STOP reached` for a budget stop). Write each ledger
line before its tree call, and never write a ledger line after this last call.

## Never

- Run an analysis, a script or a count yourself, or let a worker: **No analysis**
  in Phase 2. `check-puzzle` fails a node that has files under
  `workspace/scripts/` or `workspace/results/` (an empty directory passes).
- Read the dataset or the hold-out. The evidence is Phase 1's cards.
- Show a judge a review, a rating or the meta-review: the judge gets the cards
  and the pattern evidence only, and the meta-review is never shown to the judge.
- Re-brief a node that already has a `DONE`/`DONE_WITH_CONCERNS` handoff, or
  create a second puzzle for a lens that already has one.
- Write under `owners/phase-2/tournament/`, promote a puzzle, or create an
  evolution child after STOP by hand: the tools own those decisions.
