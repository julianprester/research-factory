---
name: phase-1
description: "Use when you own Phase 1 (patterns) of a research-factory run: turn Phase 0's expectations list into one pre-registered scanner per entry, add blind scanners, and hand the patterns to Phase 2."
---

# Phase 1: patterns

You are the Phase 1 owner. Follow **phase-owner** for the loop, ledger, dispatch
form, fix loop and handoff statuses; this skill only says what Phase 1's nodes
are, in what order, and when it ends.

Phase 1 measures. It takes the job list Phase 0 left — a manifest, an
expectations list and the exploration split — and turns every expectation into a
pre-registered measure, run by a worker that reports whether the expectation
held. It adds blind scanners that look for regularities no expectation named.
What comes out is the evidence Phase 2 interprets: a Phase 1 owner never
explains anything.

## 0. Resume, then read the job list

After a restart, call `tree_list({})` — all phases, not just phase 1 — and
continue from what exists. Do not recreate work:

- A pattern node already exists for an expectation: do not create another.
  Re-brief it only when its `handoff.md` is missing or does not start with
  `DONE`/`DONE_WITH_CONCERNS`.
- Every expectation has a pattern node with a processed handoff and a blind
  batch has run: go to §5 to decide whether a second blind batch is needed.
- Otherwise resume wherever the nodes leave off.

Then read the job list:

`tree_list({ phase: 1 })` — with no status filter, so the `input` node is in the
answer — and take the node whose status is `input` (Phase 0's assembler). Read
its `workspace/manifest.md` for the paths, then `expectations.md` §0 and its
entries. The `input` node is the job list: never brief or dispatch it, and close
it only when the phase is complete (§5).

## 1. One expectation scanner per entry

For each entry in `expectations.md` that has no pattern node, create one:

```
tree_create({ parentId: "D01", title: "E03 <short title>" })
```

`<short title>` is the entry's own title, shortened. Brief it:

- **Role:** expectation scanner for `<E<n>>` in the run's interest.
- **Skill:** `./harness/skills/roles/scan-expectation.md`
- **Inputs:** every path in `workspace/manifest.md` except its hold-out lists;
  `expectations.md` §0 (the shared populations and the small-cell rule) and the
  entry's id and full text.
- **Outputs:** `workspace/measure.md`, `workspace/scripts/`,
  `workspace/results/`, `workspace/pattern.md`.
- **Definition of Done:** the role file's DoD, copied in.

The role has the worker pre-register with `preregister` before it measures, so
the scanner's `measure.md` is in git before its first count. The rival is
measured by the same scanner on the same measure — it pre-registers both
predictions — so one node decides between them. Create a separate rival scanner
only when the rival needs a different measure, and record why first:

`Ruling: rival scanner for <E<n>> — the rival's measure is <what>, not the entry's <what> — <cost if wrong: one more node measuring something Phase 1 does not need>`

## 2. On each handoff

Judge the node only after the checker passes. From the node dir:

```
node ./harness/tools/check-pattern.ts <node dir>
```

and `--blind` for a blind scanner. It prints `ok` and exits 0 when the node may
be judged; otherwise it prints its problems to stdout, one per line, and exits
1; exit 2 is a usage error (a wrong path, or no run above the node), so fix the
command. Any output other than `ok` goes back through phase-owner's fix loop
(resume the worker with the problem lines): the node is not handed on until the
check passes. That check runs while the card is still uncommitted, so it cannot
see whether `pattern.md` was committed after the pre-registration: after the
`tree_update` that hands the node on or closes it — the call whose `git add -A`
commits the card — re-run `check-pattern.ts` on every such node, and record any
problem it now reports in the ledger.

Then apply §4's test **before** routing: a duplicate or an artifact is `closed`
(`duplicate of <id>`, `artifact: <why>`) while the node is still in phase 1,
because a node that has left the phase can no longer be updated.

Only then act on the handoff's `Verdict:` line (line 3):

- `violated`, `mixed` or `open` — a surprise, or a regularity Phase 2 should
  interpret: `tree_update({ nodeId, phase: 2, status: "ready", note: "<verdict>: <one line>" })`.
- `held` — the expectation survived: `status: "closed"`, note
  `expected: <one line>`.
- `unmeasurable` — `status: "closed"`, note `unmeasurable: <why>`; a blind
  scanner whose pre-registered criterion was not met is closed with note
  `unmeasurable: no regularity`.

## 3. Blind scanners

When every expectation has a pattern node, add blind scanners in batches of at
most 3: same creation, titled `blind <angle>` where the angle is the measure and
not the finding.

Choose angles from the glossary and the slices in `profile.md` — a comparison
across named slices that no expectation names, over a measure the data can
carry. An angle must differ from every expectation. Record the batch's choice
first:

`Ruling: blind batch — <angle 1>, <angle 2> … — <why none of them is an expectation> — <cost if wrong: a duplicate the next batch has to catch>`

The first batch is about one scanner per five expectation scanners, so a run of
17 entries starts with 3. Brief each with role `scan-blind`, skill
`./harness/skills/roles/scan-blind.md`, the
manifest paths except its hold-out lists and its angle — no expectation — and
dispatch as phase-owner says.

## 4. Hygiene

§2 applies this test after the checker and before routing, while the node is
still in phase 1. A pattern is not a finding when:

- its measure and population repeat an earlier pattern's, under any angle — a
  duplicate: `closed`, note `duplicate of <id>`;
- it is an artifact of the data's form — template boilerplate, generated pages,
  a directory convention rather than organising: `closed`, note
  `artifact: <why>`.

Neither is a failure: a duplicate says an expectation already covers that angle,
and an artifact says the corpus's form produced the regularity.

## 5. Saturation

Phase 1 ends by saturation, not by an empty queue. Stop when every expectation
has a pattern node with a processed handoff and the latest blind batch produced
only duplicates or artifacts, or after two blind batches, whichever comes first.
Record the decision before the final call:

`Ruling: Phase 1 saturated — <which of the two conditions, with the counts> — <cost if wrong: a second batch is cheap, a missed regularity is not>`

Then, as the **last** tree call, close the input node:

`tree_update({ nodeId: "<input>", status: "closed", note: "Phase 1 complete: <n> to Phase 2, <m> expected, <k> unmeasurable, <d> duplicates/artifacts" })`

`<n>` counts the pattern nodes handed to Phase 2 (`violated`, `mixed`, `open`),
`<m>` those closed `expected`, `<k>` those `unmeasurable`, `<d>` the combined
duplicates and artifacts. Ledger each line before its `tree_*` call, as
phase-owner requires, and never write a ledger line after that last call.

## Never

- Do the measuring yourself: no scripts, counts or cards — workers do that.
- Let a scanner read the hold-out list. Phase 1 measures the exploration split
  only, and a script that mentions the hold-out fails the checker on the string
  alone.
- Interpret: no literature search, no theory, no explanation. A Phase 1 finding
  is a measure and a verdict; Phase 2 does the rest.
- Re-brief a node that already has a `DONE`/`DONE_WITH_CONCERNS` handoff, or
  create a second node for an expectation that has one.
