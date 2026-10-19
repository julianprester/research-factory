---
name: phase-0
description: "Use when you own Phase 0 (preparation) of a research-factory run: profile the data, write expectations for 3–5 theoretical areas, assemble them, and hand one prep node to Phase 1."
---

# Phase 0: preparation

You are the Phase 0 owner. Follow **phase-owner** for the loop, ledger, dispatch
form, fix loop and handoff statuses; this skill only says what Phase 0's nodes
are, in what order, and when it ends.

Phase 0 runs once per dataset, then ends. It produces the run's job list: a
profile, a practice glossary, an honest account of what the data can support, a
hold-out split, and an expectations list that Phase 1 turns into pattern nodes.
Your job is to get that list made by workers and handed on.

## 0. Resume, then read the run

After a restart, call `tree_list({})` — all phases, not just phase 0 — and
continue from the furthest point that already exists. Do not recreate work:

- The assembler node is already in `phase: 1`: Phase 0 is complete. Do nothing;
  the Phase 1 owner has the job list.
- The assembler node exists in phase 0: do not create another. Resume or
  re-brief it only when its `handoff.md` is missing or does not start with
  `DONE`/`DONE_WITH_CONCERNS`; do not create area nodes again.
- Area nodes exist: do not create them again — resume or re-brief only those
  whose `handoff.md` is missing or does not start with
  `DONE`/`DONE_WITH_CONCERNS` — and create only the areas that are missing.
- Z01 exists but has no handoff: re-brief or dispatch it before choosing areas.
- None of the above: start at Z01 below.

Read `node.json` in the run dir: it holds `dataset` and `interest`. The interest
is the researcher's question — take it from there and never from memory or from
this skill.

## 1. Z01 profile

If `tree_list({ phase: 0 })` shows no prep node, create it and brief it:

```
tree_create({ parentId: "D01", title: "profile", type: "prep" })
```

- **Role:** profile worker for `<dataset>`; the run's interest is `<interest>`.
- **Skill:** `./harness/skills/roles/prep-profile.md`
- **Inputs:** `<dataset>`; `<run dir>/node.json`.
- **Outputs:** `workspace/profile.md`, `workspace/glossary.md`,
  `workspace/data-character.md`, `workspace/split/`.
- **Definition of Done:** the role file's DoD, copied in.

Dispatch it as phase-owner says and **wait**: the areas you choose next must
come from `profile.md`, not from the interest alone. Read its `handoff.md` and
`profile.md` when it reports.

## 2. Choose the areas, then one prep node each

Choose **3–5 theoretical areas** from `profile.md` and the interest: distinct
literatures that each predict something about this dataset. More areas than the
corpus can bear just multiply unmeasurable entries. Ruling for each choice,
before its node:

`Ruling: area <name> — <why this literature bears on the interest given the profile> — <cost if wrong: Phase 1 runs scanners for a theory that does not apply>`

Then one prep node per area (`tree_create` with `type: "prep"` under `D01`,
titled the area) and a brief for each:

- **Role:** expectations worker for the area `<area>`; the run's interest is
  `<interest>`.
- **Skill:** `./harness/skills/roles/prep-expectations.md`
  (search rules: `./harness/skills/roles/deepis.md`)
- **Inputs:** `<run dir>/node.json`; `<run dir>/prep/Z01-profile/workspace/profile.md`,
  `.../data-character.md`, `.../glossary.md`.
- **Outputs:** `workspace/expectations.md`.
- **Definition of Done:** the role file's DoD, copied in.

**At most 3 prep workers at a time.** This Phase 0 limit of 3 overrides
phase-owner's limit of 4: phase-owner's loop applies here, but its cap gives way
to this one. A supervisor nudge is not a dispatch order: it reports what is
waiting, not what to do, and the 3-worker cap still holds. An earlier run's 20
parallel unbounded literature searchers reached 257k tokens; the cap is what
keeps the phase bounded.

## 3. The assembler

When the area nodes report `DONE` or `DONE_WITH_CONCERNS`, create one more prep
node and brief it:

- **Role:** assembler for the run's expectations list.
- **Skill:** `./harness/skills/roles/prep-assemble.md`
- **Inputs:** every area node's `workspace/expectations.md` (list the paths
  explicitly), plus Z01's `profile.md`, `data-character.md`, `glossary.md`.
- **Outputs:** `workspace/expectations.md`, `workspace/summary.md`,
  `workspace/manifest.md`.
- **Definition of Done:** the role file's DoD, copied in — including
  `check-citations` exit 0.

An area `BLOCKED` after the fix loop: record the ruling, brief the assembler
without it, say so in the final note. A missing area weakens the list; it does
not stop the phase.

## 4. Hand-off

On the assembler's `DONE` or `DONE_WITH_CONCERNS`, close the phase in this order:

1. `tree_update` Z01 and every area node to `status: "closed"`.
2. Then, as the **last** tree call,
   `tree_update({ nodeId: "<assembler>", phase: 1, status: "ready", note: "Phase 0 complete: <n> expectations; input: workspace/manifest.md" })`
   with `<n>` from the assembler's handoff. If the handoff is
   `DONE_WITH_CONCERNS`, carry its concern into the note:
   `Phase 0 complete: <n> expectations; input: workspace/manifest.md — <concern>`.

The handed-on prep node is Phase 1's input; Phase 1 reads it and never briefs or
dispatches it. The node's `workspace/manifest.md` names the absolute paths of
that input: `expectations.md`, `profile.md`, `data-character.md`, `glossary.md`,
`split/exploration.txt` and `split/holdout.txt`.

Ledger each line before its `tree_*` call, as phase-owner requires. Then stop:
Phase 0 has no queue left, so the owner ends its turn and the supervisor finishes
the run; the Phase 1 owner treats the assembler node as the job list.

## Never

- Do the work yourself: no profiling, searches or merging — workers do that.
- Create area nodes before `profile.md` exists, or let the same area in twice.
- Accept an unmeasurable entry or a split with no recorded depth rationale:
  every later phase depends on this list being measurable against the slices in
  `profile.md` and on evidence `data-character.md` says the corpus has.
