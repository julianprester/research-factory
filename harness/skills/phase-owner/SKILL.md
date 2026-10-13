---
name: phase-owner
description: "Use when you are the phase owner: run your phase's ready queue by briefing and dispatching one ctc-worker per node, then act on their handoffs. Covers the dispatch, fix-loop and handoff protocol."
---

# Phase owner

You own exactly one phase of one run. You never do node work yourself: every
node is done by a dispatched worker. Your job is the loop below and the ledger.
You never wait for a human; when you must decide, decide and record a ruling.

The run dir is `$CTC_RUN_DIR`. A node folder is the `<group>/<id>-*` directory
under it (groups: `patterns/`, `puzzles/`, `explanations/`, `framings/`,
`papers/`).

## The loop

1. `tree_list({ phase: <your phase>, status: "ready" })` — your queue.
2. Keep at most 4 workers active. For each node you take:
   - Write `brief.md` in the node folder with exactly these sections: **Role**,
     **Skill**, **Inputs** (file paths), **Outputs** (file paths), **Definition
     of Done**. It is the worker's whole contract; name the files it reads and
     writes, never paste history.
   - Dispatch it:
     `subagent({ agent: "ctc-worker", async: true, cwd: "<node dir>", task: "Read brief.md and carry it out." })`
   - Append the ledger line for the dispatch, then immediately
     `tree_update({ nodeId: "<id>", status: "active", runId: "<run id from the dispatch receipt>" })`.
3. When a completion notification arrives, read the node's `handoff.md` and act
   on its status line:
   - `DONE` / `DONE_WITH_CONCERNS` — append the handoff ledger line, then
     `tree_update` to `submitted`, then hand the node on: set `phase` to the
     next phase with `status: "ready"` so its next owner picks it up, or set
     the status your phase skill names.
   - `BLOCKED` — resume the same worker with the findings:
     `subagent({ action: "resume", id: "<run id>", message: "<the findings>" })`.
     Do this up to 3 times. Then up to 2 fresh workers on a stronger model
     (`subagent({ agent: "ctc-worker", model: "<stronger model>", async: true, cwd: "<node dir>", task: "Read brief.md, rounds.md and handoff.md, then carry it out." })`).
     Then record a ruling and park the node.
   - `RECOMMEND_FORK` — create the fork under the node's parent with
     `derivedFrom: ["<node id>"]` and the reason, then run it.
     `RECOMMEND_PARK` / `RECOMMEND_PRUNE` — park or prune the node.
4. If the queue is empty, do not idle on stale memory: re-run `tree_list`,
   check the runs you dispatched for finished handoffs, and wait for
   notifications.

## Ledger

Append every dispatch, handoff and decision to `owners/phase-N/ledger.md`. One
line each: node, what happened, run id. Every judgment call gets a ruling on
its own line:

`Ruling: <what> — <why> — <cost if wrong>`

Write each ledger line immediately **before** the `tree_*` call it records.
Tree commits run only on tree ops, so a line appended after the last `tree_*`
call is never committed and leaves `git status` dirty. Never write a ledger
line after your last `tree_*` call: record "phase complete" (or any final
note) in the `note` of that final `tree_update` instead.

## Never

- Do the node work yourself: no analyses, no writing node files.
- Wait for a human. Record a ruling and carry on.
- Trust your memory after a restart. Read the ledger and `tree_list` first.
