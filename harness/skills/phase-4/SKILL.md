---
name: phase-4
description: "Use when you own Phase 4 (papers) of a research-factory run: take each explanation Phase 3 handed on and write one Quarto paper for it through one writer worker, the code checks, two style passes, the gated submit, and the reopen back to Phase 3."
---

# Phase 4: papers

You are the Phase 4 owner. Follow **phase-owner** (`./harness/skills/phase-owner/SKILL.md`) for the ledger, the dispatch form, the handoff statuses and the fix loop. This skill says what a paper is and how one ends. You take **one paper at a time**: a paper uses one worker at a time (the writer, then one style worker per pass).

Phase 4 turns one explanation into one paper, `workspace/paper.qmd`: a Quarto manuscript in which every number, table, figure and handbook quotation is an embed (`{{< var >}}`, `{{< include >}}`, an image) that resolves to the raw analysis. You never write the manuscript, never run an analysis and **never read the dataset**: your `read` and `bash` are refused for the dataset root and for the restricted term in any spelling. In shell text (a ledger line, a commit message, a bash command) write **the held-back split**; the guard scans the whole bash command. `write` and `edit` are not subject to that guard. Nothing is fetched: the harness collects no data.

## 0. Budget ruling, then resume

Record the budget you hold yourself to, once, at the start:

`Ruling: Phase 4 budget — <hours> — <papers> papers, one writer session each plus two style passes — <does that fund it, given that a quota stall is possible? if not, say so> — <cost if wrong: an unfinished paper, parked with a note>`

Then resume. Call `tree_list({})` (all phases) and read `$CTC_RUN_DIR/owners/phase-4/ledger.md`. Never recreate work:

- An explanation with a paper under it (`papers/W<nn>-*`) is a paper in progress. Its folder says where it is: `checks/result.json` (the last check), `checks/passes.json` (the accepted passes), `checks/pins.json` (the reopen count), `handoff.md`. Continue at the step that state says (§2 to §6). Never create a second paper for it.
- An explanation `ready` in phase 4 that already has a paper under it (the paper is `active`) came back from a reopen. Move it to `input` and go to §4, step 3.
- An explanation `ready` in phase 4 with no paper under it is queued (§1).
- A paper `ready` in phase 5 is submitted. Nothing is left to do for it.
- Untracked or modified files in `git status` are normal: the tools commit their own paths.

## 1. The queue

The queue is the phase-4 **explanations** in `ready` with no paper under them. A paper is also created `ready` in phase 4: you set it `active` at once (§2).

**At the very start, before anything else, move every queued phase-4 explanation to `input`** (`tree_update({ nodeId: "<E..>", status: "input" })` for each), so that none stays `ready`: a `ready` explanation makes the supervisor nudge you while your workers run, and a nudge is not an order. Then work **one paper at a time**, in the order you moved them. An explanation waits at `input` until you reach it.

## 2. One paper

1. **Create the paper.** `tree_create({ parentId: "<E..>", title: "<short title>" })`. Then **at once** `tree_update({ nodeId: "<W..>", status: "active" })`. The paper is the writer's workspace and is never dispatched on its own; `active` keeps it out of the queue. Find its folder with `find $CTC_RUN_DIR -type d -name 'W<nn>-*'`. Every path below is under `<paper node dir>`.
2. **Scaffold.** `init_paper({ nodeId: "<W..>" })`. It writes the skeleton `workspace/paper.qmd` (front matter, the genre's section headings, the Predictions include), `outline.md`, the copies of the explanation's `_variables.yml`, `variables_sources.csv`, table fragments and figures, `embeds/predictions.qmd`, the templates `apa.csl` and `_quarto.yml`, the pins `checks/pins.json` and `audit/index.md`. It refuses unless the explanation is in phase 4 and has been reproduced. Authors come from the run's `authors.yml`; without it the placeholder stays and the check warns.
3. **Brief and dispatch the writer.** Write `<paper node dir>/brief.md` (you write only this file and the ledger in the paper's folder) with exactly these sections:
   - **Role:** paper writer for `<W..>` of `<E..>`.
   - **Skill:** `./harness/skills/roles/paper-write.md`
   - **Inputs:** the explanation folder `<explanation node dir>` by absolute path: `workspace/argument.md`, `workspace/reports/`, `workspace/reviews/report.md`, `workspace/reviews/revision.md`, `workspace/output/numbers/`, `workspace/output/logs/`, `workspace/output/tables/`, `workspace/output/figures/`, `workspace/output/assets/`; the paper's own `workspace/audit/index.md`; the exploration copy `<run dir>/analysis-data/exploration/`, for handbook quotations only. No dataset path, no held-back split, no other node.
   - **Outputs:** `<paper node dir>/workspace/paper.qmd`, `workspace/outline.md`, `workspace/embeds/diagrams/<name>.yml` if there is a diagram, `workspace/reopen-request.md` only if the paper needs a reopen, `<paper node dir>/rounds.md`, `<paper node dir>/handoff.md`.
   - **Definition of Done:** the role's Definition of Done, copied in.

   Ledger line first (it names the run id from the receipt), then:
   `subagent({ agent: "ctc-worker", model: "<worker model from your kickoff>", async: true, cwd: "<paper node dir>", task: "Read brief.md and carry it out." })`
4. **Read the handoff** (`<paper node dir>/handoff.md`) and act on its status line:
   - `DONE` or `DONE_WITH_CONCERNS`, Summary not a reopen: §3 (the checks). Read the concerns.
   - `DONE_WITH_CONCERNS` whose Summary begins `Reopen requested:`: §4. The writer found evidence the argument lacks; this is not a fix.
   - `BLOCKED`: the phase-owner fix loop. Resume the same worker with the findings, up to 3 times (`subagent({ action: "resume", id: "<run id>", message: "<the findings>" })`); then up to 2 fresh `ctc-worker`s on a stronger model, with `cwd` the same paper node dir and a brief that says to read `rounds.md` and `handoff.md` first; then park the paper with a `Ruling:`.
   - `RECOMMEND_*` is not a Phase 4 answer: resume the writer with the question.

## 3. The checks and the fix loop

`check_paper({ nodeId: "<W..>" })` runs the code checks (`check-paper`): every embed resolves, the copies match the explanation, no hand-typed numbers, the citations, the outline's coverage, the pins, and the Quarto render in the paper image (it takes minutes). It writes `checks/result.json`. Ledger line first.

- **ok:** go to §5, the style passes.
- **problems:** read each line and sort it.
  - A problem in the paper's text (an embed that does not resolve, a bare number, a forbidden construct, an include out of place, a citation, the render, outline coverage) is the writer's. Re-dispatch it: `subagent({ action: "resume", id: "<run id>", message: "<the problem lines, verbatim>" })`. Up to **3 resumes**. Then **one fresh** `ctc-worker` with `cwd` the paper node dir, after you have appended the lines under `## Problems to fix` in `brief.md`. If that still fails, park the paper with a `Ruling:`.
  - A problem with a copy (`_variables.yml`, `variables_sources.csv`, a table, a figure, `embeds/predictions.qmd`) or a `stale:` pin means the explanation changed under the paper. Run `repin_paper({ nodeId: "<W..>" })`: it refreshes the copies from the explanation and takes its current hashes. It refuses unless `outline.md` changed since a reopen and the Predictions are the pinned ones; the refusal names which, and that is a real stop: park the paper with the message as the `Ruling:`.
  - `outline lists needs: send them in one reopen request` is §4, not a fix.
- A problem that outlasts the caps parks the paper (`tree_update` to `parked`, with a note) and you move on.

## 4. Reopen: the writer needs evidence the argument lacks

The writer sends **one reopen request**: `workspace/reopen-request.md`, with each number, table or figure it needs, why, and which part of the argument it bears on. The same needs are listed in `## Needs` of `outline.md`.

1. **Check the request.** It must be one request, with a reason for each entry. An empty request, or one that asks for data rather than an analysis the explanation can run, goes back to the writer with that finding.
2. **Send it.** Ledger line first. `reopen_explanation({ nodeId: "<W..>", note: "<what is asked, in one line>" })`. It refuses when the explanation is not in phase 4, when the request is empty, and past `maxReopens` (2 per paper). It copies the request to the explanation's `reopens/NN/request.md`, sets the explanation to phase 3 `ready`, and records the reopen in `checks/pins.json`. The paper stays `active`. Tell the Phase 3 owner nothing: the supervisor starts it.
3. **Wait.** Do not dispatch the paper while its explanation is in Phase 3. When the explanation is `ready` in phase 4 again (it shows in `tree_list({ phase: 4, status: "ready" })` with the paper under it), move it to `input` (§1). Then re-dispatch the writer **for the outline only**, with a brief that says so: for each need the reopen met, remove it from `## Needs`, and cover the argument's new links in `## Sections` or `## Omitted` (each omission with its reason). It drafts nothing in this step. `repin_paper` refuses until `outline.md` has changed since the reopen, which is why this comes first.
4. **Repin.** `repin_paper({ nodeId: "<W..>" })`. It refreshes the copies from the explanation's current outputs and takes its current argument, reproduction and Predictions hashes. It refuses when the Predictions changed (a reopen may not change them: a deviation belongs in Limitations); park the paper with the message as the `Ruling:`.
5. **Draft the changed parts.** Re-dispatch the writer with a brief for the parts the new variables and tables now support; the rest of the paper stays as it is. Then §3 again. A need the reopen did not meet stays in `## Needs`, and the paper must say in its Limitations what is missing; `submit_paper` refuses while `## Needs` has an item, so park the paper with a `Ruling:` in that case.

A paper goes **stale** when its explanation is reopened: `check_paper` reports `stale:` lines until step 4. Do not fix those by hand.

## 5. The style passes

Two passes over the checked draft, in this order: `concise`, then `humanize`. Each is `pass_begin`, one style worker, `pass_end`. `pass_begin` needs a passing `check_paper` for the current `paper.qmd`, and `humanize` begins only after `concise` is accepted.

1. **Begin.** Ledger line first, then `pass_begin({ nodeId: "<W..>", pass: "concise" })`. It records the paper's embeds and commits the state. The second pass begins the same way with `pass: "humanize"`.
2. **Dispatch the style worker.** Brief: **Role:** style-pass worker for `<W..>`, pass `concise`. **Skill:** `./harness/skills/roles/paper-style.md`, and the vendored skill for the pass: for `concise`, `./harness/skills/vendor/writing-clearly-and-concisely/SKILL.md`; for `humanize`, `./harness/skills/vendor/humanize-ai-writing/SKILL.md`. **Inputs and Outputs:** `<paper node dir>/workspace/paper.qmd` (prose only) and `<paper node dir>/handoff.md`. **Definition of Done:** the pass applied to every section's prose; the handoff opens with `Status:`.
   `subagent({ agent: "ctc-worker", model: "<worker model from your kickoff>", async: true, cwd: "<paper node dir>", task: "Read brief.md and carry it out." })`
3. **End.** When the worker hands off, `pass_end({ nodeId: "<W..>", pass: "concise" })`. The code compares the paper's embeds (variables, includes, images, quote ids, citation keys) with those recorded at `pass_begin`.
   - **Accepted:** the reworded prose stays; go on to the next pass.
   - **Rejected:** the paper is restored byte for byte to its state at `pass_begin`, and the reply names the embeds that changed. Ledger line, then `pass_begin` again for the same pass, and re-dispatch that style worker once with the diff under `## Problems to fix` in its brief. A second rejection: record a `Ruling:` naming the pass and the diff, and park the paper with a note. `submit_paper` needs both passes accepted, so a skipped pass does not let the paper through.
4. After both passes are accepted, run `check_paper` again: the final text is the one submitted. A problem there is fixed as in §3, and then the passes run again from `concise`.

## 6. Submit

Ledger line first. `submit_paper({ nodeId: "<W..>", note: "<why it is ready>" })`. It runs `deepis bib` (each `[@chunk]` becomes a BetterBibTeX key, with `references.bib` beside the paper), then the final check and the Quarto render. It refuses, naming the gate, until each holds: the checks are ok for the current text, both passes are accepted, the pins are not stale, the bibliography and the render are clean, and `## Needs` is empty. Then it commits `paper.qmd`, `references.bib` and `checks/`, sets the paper `ready` in phase 5 and the explanation `closed`, and the reply names the commit.

If it refuses, read the gate it names. A check problem goes back through §3. A bibliography or render problem goes to the writer (resume it with the lines), then `check_paper` and the passes again. A Needs item goes to §4.

Then take the next explanation (§1).

## Never

- Read the dataset or the held-back split, or name the restricted term in shell text (write **the held-back split**).
- Write files under the paper's `workspace/` yourself: the manuscript, outline, quotes, variables, diagrams and checks belong to the writer, the style workers and the tools. You write `brief.md` and the ledger.
- Never `tree_update` a paper to `submitted`, or change its phase: `submit_paper` does both.
- Edit an embed to get a check through, or accept a style pass that changed one.
- Fetch data. A need is an analysis the explanation can run; anything else stays a limitation of the paper.
- Dispatch the explanation node itself.
