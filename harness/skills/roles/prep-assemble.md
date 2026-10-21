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
- `workspace/manifest.md` — the absolute paths Phase 1 needs for its inputs

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
6. **Open `expectations.md` with a §0 Measurement universe paragraph.** It names
   the exploration list (`prep/Z01-profile/workspace/split/exploration.txt`, or
   the list for the analysed extension) and says that Phase 1 measures the
   exploration split only: the full-corpus sizes in `profile.md` §5 are context,
   not denominators. Every implication that quotes a size says whether it is a
   full-corpus size or an exploration size.
7. **Make shared populations literal.** When entries share a population, state
   it once in §0 as a literal token or regex list; an entry may add a
   sub-condition over that list but may never redefine it. Every population must
   be matchable literally — names, tokens or file-path patterns, never a
   semantic qualifier such as "used by an automation" — or be flagged in the
   entry for Phase 1 to operationalise. An entry that redefines a shared
   population is rewritten to the sub-condition form, or dropped.
8. **Check the cells, not just the comparison.** A comparison whose cells mostly
   hold fewer than 10 exploration files must pool slices or be dropped or
   flagged for Phase 1. Record the pooling, drop or flag in `summary.md`.

## Manifest

Write `workspace/manifest.md` listing the absolute paths Phase 1 needs. Check
`data-character.md` for the extension this corpus analyses and use that
extension's split: `workspace/split/`, or `workspace/split-<ext>/` when the run
has several. One path per line, each absolute:

- the run dir's `node.json` — the interest and the dataset path
- the dataset root — the absolute path `node.json`'s `dataset` names
- this node's `workspace/expectations.md`
- Z01's `workspace/profile.md`, `workspace/data-character.md`,
  `workspace/glossary.md`
- the analysed extension's exploration and hold-out lists:
  `workspace/split/exploration.txt` and `workspace/split/holdout.txt`, or
  `workspace/split-<ext>/exploration.txt` and `.../holdout.txt` — name the
  extension whose split you listed

Phase 1 reads this manifest to find its inputs.

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
  quote is verbatim in that neighbouring chunk: if the flagged span is a title or
  a term, italicise it instead of quoting it; otherwise replace the cited id with
  the one reported, but only when the reported chunk contains the quoted sentence
  and you have read it. On `not found nearby`, re-read the source or drop the
  quote — never edit a quote to make it pass.
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
- Every pooled, dropped or flagged small-cell comparison: the entry and the
  choice.
- The final count, and the `check-citations` result line.

## Definition of Done

`workspace/expectations.md` opens with the §0 Measurement universe paragraph and
is numbered from `E01` with no gaps, every entry has **Area**, **Theory**,
**Prediction**, **Measurable implication here** and **Rival**, every implication
names slices listed in `profile.md` and a population that is literal or flagged,
no shared population is redefined, every small-cell comparison is pooled,
dropped or flagged, and `check-citations` exits 0. `workspace/manifest.md` lists
the run's `node.json`, the dataset root, the prep files and the analysed
extension's split lists as absolute paths. `summary.md`'s counts match the file.
`handoff.md` starts with `Status: DONE` (or `DONE_WITH_CONCERNS`, naming any
area whose entries were mostly dropped) and gives the entry count on the Summary
line — the owner writes that number into the tree.

Write only inside this node's `workspace/`, `rounds.md` and `handoff.md`. Read
only the input paths the brief lists, even when they are another node's files.
