---
name: phase-3
description: "Use when you own Phase 3 (explanations) of a research-factory run: take each promoted puzzle through rounds of analysis workers and literature workers into one evolving theoretical argument, stop by the code's rule, and submit it through the end gate."
---

# Phase 3: explanations

You are the Phase 3 owner. Follow **phase-owner** for the ledger, dispatch form,
fix loop and handoff statuses; this skill says what Phase 3's nodes are, what a
round is, and how a puzzle's explanation ends. Keep at most 4 workers active.

Phase 3 takes **one promoted puzzle at a time** and produces **one argument**
(`workspace/argument.md`) with the numbered analyses behind it. The loop is
rounds: analysis workers run scripts, literature workers then set the results
against the literature, you read both and edit the argument. You never run an
analysis, write a script or read the dataset yourself; the workers do the work
and the code does the counting. Nothing is fetched: the harness collects no data.

## 0. Budget ruling, then resume

Expect many hours: a round is 2–4 analysis workers (minutes each, plus container
time), an assets worker, one or two literature workers and your reading; up to
`roundCap` rounds per puzzle (the config value in `$CTC_RUN_DIR/config.json`,
default 6) and one or more puzzles. Record the budget you hold yourself to:

`Ruling: Phase 3 budget — <hours> — <puzzles> puzzles, up to <roundCap> rounds each — <does that fund the cap, and so a guaranteed code STOP? if not, say so> — <cost if wrong: an unfinished loop, or nothing submittable>`

A `Ruling:` can stop your work but it records no STOP. Only `close_round`
records one, and `reproduce` and `submit` refuse without it. You cannot close a
puzzle early by ruling and still submit. If the budget runs out mid-loop, record
`loop truncated: no STOP recorded, nothing submittable`, park the explanation
and its puzzle with that note, and say so; never pretend.

Then resume. Call `tree_list({})` (all phases) and read
`$CTC_RUN_DIR/owners/phase-3/ledger.md`. Never recreate work:

- A puzzle already `input` with an explanation under it: do not create another.
  Continue that explanation.
- `owners/phase-3/loop/<E>/rounds.json` lists the **closed** rounds (the code
  wrote it; you cannot). Read it before anything else. A recorded STOP is final.
  The number of records is the number of closed rounds.
- `rounds/<NN>/plan.md` in the node exists for round `NN` = closed rounds + 1
  and the round has no `verdict.md`: that round is **open**. Do not call
  `open_round` again (it refuses); read which `tasks/<L>/handoff.md` files exist
  and carry on from §2.
- `owners/phase-3/loop/<E>/reproduction.json` exists: the end gate (§5) has
  started; `submit` tells you which gate is unmet.
- Untracked or modified worker files in `git status` are normal: the tools you
  call commit only their own paths, and the next `tree_update`, `tree_create` or
  `submit` sweeps the rest in. Do not be alarmed by them.

## 1. The queue and one puzzle's setup

`tree_list({ phase: 3 })` with no status filter. The queue is the phase-3
**puzzles** in `ready` (promoted by Phase 2); a puzzle already `input` has its
explanation under way. Take them one at a time.

For each puzzle `<P..>`:

1. Read what Phase 2 left: its `workspace/puzzle.md`, its
   `workspace/reviews/merged.md` (the **Phase 3 must check** list), and the
   parent pattern's `workspace/pattern.md` and `workspace/measure.md`. Also
   `data-character.md` and `glossary.md` at the absolute paths the Phase 0
   `manifest.md` names, and the Phase 0 caveats as Phase 2 recorded them. You
   read these files; you never read the dataset or the hold-out.
2. Move the puzzle to `input`: `tree_update({ nodeId: "<P..>", status: "input" })`.
   It keeps Phase 3 alive for the supervisor, it is never briefed or dispatched,
   and you close it at the end (§6).
3. Create the explanation: `tree_create({ parentId: "<P..>", title: "<short title>" })`
   (the default child of a puzzle is an explanation). Then **at once**
   `tree_update({ nodeId: "<E..>", status: "active" })`. The explanation node is
   never dispatched itself: it is the workspace the workers share, and `active`
   stops the supervisor from treating it as a ready node. Find its folder with
   `find $CTC_RUN_DIR -type d -name 'E<nn>-*'`; every path below is under it
   (`<node dir>`).
4. Record the budget `Ruling:` once at the start of the run (§0), not per puzzle.

Write each ledger line immediately before the `tree_*` or tool call it records.

The node's layout:

```
<node dir>/
  workspace/ puzzle.md must-check.md   snapshots open_round makes on round 1
             argument.md               yours
             scripts/ output/ archive/ reports/   workers, scripts, archive_script
             data-requests.md          yours
             reviews/ report.md        the reviewer's;  revision.md  yours
  tasks/<L>/ brief.md handoff.md       one folder per task letter
  tasks/lit-<NN>/ brief.md handoff.md  one per literature worker
  rounds/<NN>/ plan.md verdict.md      written only by open_round / close_round
  brief-review.md                      yours, for the end-gate reviewer
```

## 2. One round

### Plan

Write the plan and pass it to `open_round`. Round 1 starts from the puzzle card
and its must-check list (read in §1; `workspace/puzzle.md` and
`workspace/must-check.md` appear in the node when round 1 opens). Later rounds
start from the last verdict, the literature report's *Implications for the
argument*, the open questions in the handoffs and the data you lack. The plan is
markdown with exactly this skeleton:

```
## Questions
- <what this round must answer, in terms of the argument>

## Tasks
### Task A: <aim>
Inputs: <registry files and scripts it builds on>. Definition of Done: <what exists when it is done>.
### Task B: <aim>
...
```

Each task heading is `### Task <L>: <aim>` with `<L>` one capital letter. The
tool refuses a plan it cannot read, a letter listed twice and a letter that was
ever used.

**Letters.** A letter is unique across the node's whole life; round 2 continues
from the next unused letter, upward, never a lower one. There are only 26 for
all rounds: plan 3–4 per round and count what is left before you plan. Make
each task one coherent line of analysis (a measure, a model family, a robustness
battery), 2–4 per round.

**The assets task.** `assets.R` or `assets.py` (the manuscript variables and
fragments, §2 below) is writable only by the task with the **lexicographically
greatest** letter folder in `tasks/`. So the assets job always gets the **last
letter** of its round, no other task of that round touches it, and the next
round's assets job is the new highest letter. Include one assets task every round
(you cannot know which round will be the last), listing the registry rows it
should expose as variables.

Then call (the plan is the whole markdown text):

`open_round({ nodeId: "<E..>", plan: "<the plan markdown>" })`

It writes `rounds/<NN>/plan.md`, creates `tasks/<L>/` for each letter and, on
round 1, writes the puzzle and must-check snapshots into the workspace. It
refuses while the previous round is open, after the cap and after a STOP. Ledger
line first.

### Analysis workers

Write `<node dir>/tasks/<L>/brief.md` for each task, exactly these five
sections (the owner may write briefs, `argument.md`, `reviews/revision.md`,
`data-requests.md` and `brief-review.md` in the node and nothing else):

- **Role:** analysis worker for task `<L>` of round `<NN>` of `<E..>`.
- **Skill:** `./harness/skills/roles/explain-analysis.md`
- **Inputs:** the task's aim from the plan; `<node dir>/workspace/puzzle.md`
  and `<node dir>/workspace/must-check.md`; the pattern's `measure.md` and
  `pattern.md` and Phase 0's `data-character.md` and `glossary.md` at absolute
  paths; the registry files and scripts it builds on; the `Caveat:` lines. No
  dataset path, no hold-out, no other node's files.
- **Outputs:** scripts `<node dir>/workspace/scripts/<L>_01.R|py`, `<L>_02…`;
  the handoff `<node dir>/tasks/<L>/handoff.md`. For the assets task: only
  `<node dir>/workspace/scripts/assets.R` (or `.py`) and the handoff.
- **Definition of Done:** the role file's DoD, copied in, plus the task's own.

**State the node dir as an absolute path in every brief, and tell the worker to
use absolute paths.** A worker's `cwd` is `<node dir>/tasks/<L>/`, so a relative
path lands in the task folder, not the workspace. Scripts go to
`<node dir>/workspace/scripts/` (or `../../workspace/scripts/`); the handoff goes
to the task folder.

Dispatch each task concurrently (at most 4), with `cwd` the task folder:

`subagent({ agent: "ctc-worker", model: "<worker model from your kickoff>", async: true, cwd: "<node dir>/tasks/<L>", task: "Read brief.md and carry it out." })`

Append the ledger line (it names the run id from the dispatch receipt). The
explanation node is already `active`; there is no `tree_update` per task.

**Assets task last.** It reads the other tasks' registry rows, so dispatch it
after their handoffs are in and after you have archived what the round dropped
(below). It is still an analysis worker: the literature workers wait for it.

### Handoffs

When a completion notification arrives, read `tasks/<L>/handoff.md` and act on
its status line as phase-owner says. `close_round` accepts only `DONE` or
`DONE_WITH_CONCERNS` for every task of the plan: `BLOCKED` and any `RECOMMEND_*`
go through the fix loop (resume the same worker with the findings; up to 3, then
fresh workers) until the worker closes with a status the round can use. A handoff
that has not appeared after about 15 minutes: check the run with
`subagent({ action: "status", id })`; if it is dead, `resume` it or re-dispatch,
and record the outcome in the ledger.

Read each handoff **and the registry it points to**
(`workspace/output/numbers/<script>.csv`, the tail of
`workspace/output/logs/<script>.txt`): you trust numbers by their row, not by a
handoff's prose. Then:

- **Dead ends.** Each worker lists scripts that led nowhere under `Dead ends:`.
  Drop an analysis with
  `archive_script({ nodeId: "<E..>", script: "A_02.R", reason: "<why it is dropped>" })`.
  It moves the script, its registry file and its log to
  `workspace/archive/<stem>/` with your reason, and refuses an empty reason and
  anything `argument.md` still links to (unlink first). A number that stays in
  the registry but is not in the argument is not a dead end; keep it.
- **Data requests.** See §4.

### Literature workers

The literature workers run **after** the analysis workers (and the assets
worker): never in parallel with them. They read the round's results.

Write `<node dir>/tasks/lit-<NN>/brief.md` (`NN` = the round number, two digits,
so round 1 is `lit-01`; `close_round` requires exactly this task's handoff and
`workspace/reports/<NN>.md`). The brief's five sections:

- **Role:** literature worker for round `<NN>` of `<E..>`.
- **Skill:** `./harness/skills/roles/explain-literature.md`
  (and `./harness/skills/roles/deepis.md`).
- **Inputs:** `<node dir>/rounds/<NN>/plan.md`; every `<node dir>/tasks/<L>/handoff.md`
  of the round; `<node dir>/workspace/output/numbers/` and `output/logs/`;
  `<node dir>/workspace/argument.md` if it exists; earlier `workspace/reports/`;
  `workspace/puzzle.md`, `must-check.md`; the glossary and data-character paths.
  The brief **always asks for rival accounts and for measurement and artifact
  explanations with precedent**, whether or not anyone raised them, and names the
  claims or readings (the status-quo reading, an artifact reading) to look for.
- **Outputs:** `<node dir>/workspace/reports/<NN>.md` and `<node dir>/tasks/lit-<NN>/handoff.md`.
- **Definition of Done:** the role file's DoD, copied in.

A second literature worker, when the results split into two bodies of
literature, is `tasks/lit-<50+NN>` (for example `lit-51`), which writes
`workspace/reports/<50+NN>.md` with the same `Round: <N>` line (valid while
`roundCap` < 50). Dispatch with `cwd: <node dir>/tasks/lit-<NN>`:

`subagent({ agent: "ctc-worker", model: "<worker model from your kickoff>", async: true, cwd: "<node dir>/tasks/lit-<NN>", task: "Read brief.md and carry it out." })`

Then read the report(s).

### The argument

Edit `<node dir>/workspace/argument.md` yourself (it is your file). Plain
markdown; the code checks it:

- first lines (before any `##`): `Contribution: theoretical` or
  `Contribution: pattern` (a theoretical contribution, or a pattern with
  theoretical implications). Plain text, not in a fence.
- exactly these seven `##` sections, in this order: `## Explanation`,
  `## Mechanism and scope`, `## What would count against it`,
  `## Alternatives considered`, `## Evidence`, `## Limitations`,
  `## Predictions`.
- **One evolving argument**, not a standing set of rivals. A rival is added when
  an analysis, a literature report or a reviewer raises it, and *Alternatives
  considered* then records how the argument now handles it. The section must be
  **non-empty** (code-checked; its content is your call). The status-quo and
  artifact readings go there whenever the literature report raised them.
- **Every number is a link**: formatted number as the text, registry file and
  key as the target, relative to `workspace/`:
  `[.401](output/numbers/12_model1.csv#m1_or_lspec)`. The file is directly in
  `output/numbers/` (named `<script>.csv`) and the key is present exactly once.
  A table or figure links as `[Table 2](output/tables/B_02.csv)`. Never link into
  `archive/`, outside `workspace/` or to an absolute path. The code cannot tell
  whether the link text matches the value; the reviewer will. Bare numbers in
  prose are warned about.
- Citations are `[@chunk]` with verbatim quotes; run
  `node ./harness/tools/check-citations.ts <node dir>/workspace/argument.md`
  until exit 0 (see `./harness/skills/roles/deepis.md`).
- **Predictions** are what the hold-out could contradict, specific enough to
  fail. The commit that `submit` makes stands as their **preregistration** for
  Phase 5. **Limitations** carry the data requested but not available (§4) and,
  after a cap stop, the plain statement that the loop was truncated at the cap.

### Close the round

When the argument is edited, close the round:

`close_round({ nodeId: "<E..>", changed: "substantial", summary: "<what changed in the argument, or why nothing did>" })`

The tool refuses unless every task of the plan has a handoff with a usable
status, the round's literature handoff and report exist and `argument.md`
exists. `changed` is `"substantial"` or `"none"`. **Substantial means a different
mechanism, scope or claim set, not rewording**: adding a number, tightening a
sentence, reordering or citing one more paper is `none`. Be honest in both
directions: calling churn "unchanged" stops the loop early on a weak argument;
calling cosmetic edits "changed" runs it to the cap. Round 1 is always
`substantial` (the argument is first written), and the tool refuses
`substantial` when `argument.md` is byte-identical to the previous round's. The
summary becomes `rounds/<NN>/verdict.md`.

It answers `continue`, `STOP (two-quiet)` or `STOP (cap)`. Write the ledger line
for the verdict first, then plan the next round only on `continue`.

## 3. The stop rule

The loop ends after **two consecutive** rounds with no substantial change
(`two-quiet`), or at the round cap `roundCap` (`cap`). Code counts them and
checks the quiet rule first, so a quiet last round is a settled argument, not a
truncation. **A STOP is a latch**: once `close_round` reports it, `open_round`
refuses and you plan no further round. A cap stop is a finding, not a
convergence: the argument's *Limitations* say so.

There is no early closing by ruling. An early stop records no STOP, and
`reproduce` and `submit` refuse without one. Run rounds until the tool reports
STOP.

## 4. Data requests

Nothing is fetched, by you or by any worker: the container has no network and
the harness never collects data. When the argument would be settled, or two
accounts separated, by data we do not have, workers list it under a
`Data requests:` heading in their handoff. You consolidate every request into
`<node dir>/workspace/data-requests.md`: one entry each with **what data, why,
and which part of the argument it bears on**. The round carries on with what
exists; the shortfall goes into the argument's *Limitations*. The puzzle does
not wait for an answer (`Ruling: finish at the limit, not park — the pipeline
keeps moving and the gap is stated; the cost if wrong is an argument finished
without data that would have settled it`).

## 5. The end gate

After STOP, in this order. Ledger line before each tool call.

1. **Code checks.** From anywhere:
   `node ./harness/tools/check-argument.ts <node dir>`
   It prints `warning:` lines (bare numbers; a softer finding), then `ok` (exit 0)
   or one problem per line (exit 1; exit 2 is a usage error). It checks every
   link and registry key, the headings and `Contribution:` line, the non-empty
   *Alternatives considered*, that `workspace/scripts/` holds only analysis
   scripts (`X_nn.R|py`, `assets.R|py`: no helper or data files), the assets pair
   `_variables.yml` and `variables_sources.csv`, each literature report's
   `Round:` line and six headings, and `check-citations` on the argument and
   every report. Fix `argument.md` yourself; for a worker's file (a script, a
   report, `assets.R`) resume that task's worker with the problem lines, or
   dispatch a fresh `ctc-worker` with `cwd` the same task folder. The check
   calls `deepis`, so it is slow.
2. **Reproduce.** `reproduce({ nodeId: "<E..>" })` re-runs every script in
   order into an empty output in the container and compares the registry (exact
   for text and integers, relative `1e-6` for floats). A call is bounded to about
   8 minutes: **PARTIAL means call it again** with the same argument until it
   completes. A mismatch or a failed script is recorded `ok: false`; fix the
   cause (resume the worker) and call `reproduce` again. If a worker or script
   planted a link and the record says `ok: false`, the next call starts fresh. An
   edit to a script or a number **after** `reproduce` invalidates it: reproduce
   again. `submit` also refuses a node with no scripts.
3. **One review.** Write `<node dir>/brief-review.md` (five sections):
   **Role:** end-gate reviewer of `<E..>`; **Skill:**
   `./harness/skills/roles/explain-review.md`;
   **Inputs:** `workspace/argument.md`, `workspace/reports/`,
   `workspace/output/numbers/`, `workspace/output/logs/`, `workspace/scripts/`,
   `workspace/puzzle.md`, `workspace/must-check.md` (relative to the node folder,
   the reviewer's `cwd`), and the glossary and data-character paths; no `owners/`,
   no dataset; **Outputs:** `workspace/reviews/report.md`;
   **Definition of Done:** the role file's DoD, copied in. Dispatch **one**
   reviewer with `cwd` the explanation node dir:
   `subagent({ agent: "ctc-reviewer", model: "<worker model from your kickoff>", async: true, cwd: "<node dir>", task: "Read brief-review.md and write workspace/reviews/report.md" })`
   When it finishes, run `check-argument.ts <node dir> --report`: it also
   requires the report to parse and each check to open with `Result:`. If the
   report fails, re-dispatch the reviewer up to 2 times, then once with a fresh
   `ctc-reviewer`; then park (`review-failed: <why>`) and say why. A report
   closed `Status: BLOCKED` is not accepted by `submit`.
4. **One revision.** Read the report. Make a single revision pass on
   `argument.md`, and write `<node dir>/workspace/reviews/revision.md` with one
   line per finding: `F<n>: taken — <what changed>` or
   `F<n>: overruled — <reason>`. A finding you do not take needs a real reason;
   a finding that needs a new analysis is overruled with that reason and the gap
   goes into *Limitations* (the loop is closed). Keep the report either way. Run
   `check-argument.ts <node dir> --report` again; if you touched a script or a
   number, reproduce again.
5. **Submit.** `submit({ nodeId: "<E..>", note: "<why it is ready>" })`. It
   refuses, naming the gate (STOP, scripts, check-argument, reproduction still
   matching the scripts and numbers, review, revision), until every condition
   holds. Then one commit sets the explanation `ready` in Phase 4, and the reply
   names it: that commit stands as the argument's **preregistration** for the
   Phase 5 hold-out, with its Predictions. Write the ledger line before the call.

## 6. Close the puzzle

After `submit`, close the puzzle input node as the **last** tree call for it:

`tree_update({ nodeId: "<P..>", status: "closed", note: "Phase 3 complete: <E..> submitted at <sha>, <r> rounds, stopped by <two-quiet|cap>" })`

Then take the next puzzle from the queue. When the last puzzle is closed, that
tree call is your last; record "phase complete" in its `note` and write no ledger
line after it. A puzzle you cannot finish (budget) is parked with the reason
(`tree_update` to `parked`, with the explanation parked too); a stray `ready` or
`input` puzzle keeps the supervisor nudging.

## Never

- Run an analysis, write a script, hand-write anything under `output/` or read
  the dataset or the hold-out. Every number comes from a script through
  `run_analysis`.
- Fetch data, or let a worker: requests go to `data-requests.md`.
- Dispatch the explanation node itself, or the literature workers in parallel
  with the analysis workers.
- Write `rounds/`, `owners/phase-3/loop/` or `archive/` by hand: `open_round`,
  `close_round`, `reproduce` and `archive_script` write them. Workers cannot
  write `argument.md`, `archive/`, `output/` (scripts write there through
  `run_analysis`), another task's folder or anything under `owners/`.
- Put a non-script file in `workspace/scripts/`; scripts share code only through
  the image helpers (`/opt/ctc`), and later scripts read earlier scripts' outputs.
- Close a puzzle early by ruling, or call a round `none` to save time or
  `substantial` to avoid stopping.
- Reuse or skip down a task letter, or give the assets job any letter but the
  highest.
