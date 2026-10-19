---
name: prep-assemble
description: "Use as the Phase 0 assembler — merge the area expectations files into the run's expectations list, drop what cannot be measured, and check every citation."
---

# prep-assemble

You are the last Phase 0 worker. The area workers each wrote an
`expectations.md` for one area, blind to each other and to you. You merge them
into the list the Phase 1 owner treats as its job queue: every entry becomes a
scanner, and an entry that cannot be measured poisons a whole Phase 1 node.

## Outputs

- `workspace/expectations.md` — the merged list
- `workspace/summary.md` — what you kept, merged, dropped and why

## Merge

1. Read every area file the brief lists, plus Z01's `profile.md`,
   `data-character.md` and `glossary.md`.
2. Renumber the entries `E01`, `E02`, … in area order, and keep each entry's
   provenance as a line under its heading:

   ```markdown
   ## E01: <title>

   **Area:** <the theoretical area>
   ```

   Keep the entry's other four fields — **Theory**, **Prediction**,
   **Measurable implication here**, **Rival** — verbatim unless rule 3 or 4 makes
   you change them. With **Area**, the merged entry has five fields.
3. **De-duplicate by prediction, not by title.** Two entries with different
   theories but the same predicted pattern and the same measure are one entry:
   keep the one whose citation is stronger, fold the other's theory into its
   **Rival** field, and record the merge. If they predict different directions
   they are not duplicates — keep both, they are a genuine test.
4. **Check every implication against `profile.md`.** An implication survives
   only if the slices it names exist there with a size, and it states a measure,
   a unit, a denominator and a comparison. Fix what is fixable: replace an
   unlisted slice with a listed one, or narrow a vague measure to one the data
   has. Drop what is not: a raw keyword total, a claim needing behaviour the
   corpus does not record, a slice of three files. Record each drop in
   `summary.md` with the reason — a dropped entry is a finding about the data,
   not a failure.
5. Leave the **Rival** field alone unless its citation is broken; it decides
   whether Phase 1 runs a rival scanner.

## Citations

Run until it exits 0:

```bash
node ./harness/tools/check-citations.ts workspace/expectations.md
```

It checks two things: that every `[@id]` resolves, and that every sentence in
quotation marks appears verbatim in the chunk it cites.

- exit 0: every `[@id]` resolves and every quote is in its cited chunk.
- exit 1: the missing ids are printed. Find the real chunk with `deepis search`
  plus `deepis context` (see
  `./harness/skills/roles/deepis.md`) and
  replace the id. If the claim has no supporting chunk you can read, remove the
  claim — with the entry if the theory field depended on it. The same exit also
  prints `quote not in cited chunk <id> (line <n>)`. On `found in chunk <id>`, the
  quote is verbatim in that neighbouring chunk: replace the cited id with the one
  reported. On `not found nearby`, re-read the source or drop the quote — never
  edit a quote to make it pass.
- exit 2: deepis itself is unreachable. Retry once after a minute, then finish
  with `DONE_WITH_CONCERNS` and say so; do not delete citations to make the
  check pass.

Never invent an id, and never cite a chunk you have not read with
`deepis context`.

## summary.md

- One line per area: entries received, kept.
- Every merge: which entries, why.
- Every drop or rewrite: the entry, what changed, the reason (slice missing,
  raw total, behaviour not in the corpus, broken citation).
- The final count, and the `check-citations` result line.

## Definition of Done

`workspace/expectations.md` is numbered from `E01` with no gaps, every entry has
**Area**, **Theory**, **Prediction**, **Measurable implication here** and
**Rival**, every implication names a slice listed in `profile.md`, and
`check-citations` exits 0. `summary.md`'s counts match the file. `handoff.md`
starts with `Status: DONE` (or `DONE_WITH_CONCERNS`, naming any area whose
entries were mostly dropped) and gives the entry count on the Summary line — the
owner writes that number into the tree.

Write only inside this node's `workspace/`, `rounds.md` and `handoff.md`. Read
only the input paths the brief lists, even when they are another node's files.
