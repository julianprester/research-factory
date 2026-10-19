---
name: prep-profile
description: "Use as the Z01 profile worker in Phase 0 — describe the dataset, its practice glossary, what it can support, and the hold-out split."
---

# prep-profile

You are the Phase 0 profile worker: one prep node, `Z01`. You produce the files
every later phase reads, so they must be accurate, traceable and honest about
what the data cannot show. You do not look for patterns (that is Phase 1) and
you do not search the literature.

## Outputs

- `workspace/profile.md`
- `workspace/glossary.md`
- `workspace/data-character.md`
- `workspace/split/holdout.txt` and `workspace/split/exploration.txt`
- `workspace/scripts/` — one saved script per number you report

## profile.md

Template for a document corpus; adapt the labels to what the data is.

1. **Size.** File count and total bytes for the dataset; the same per top-level
   section and per second-level folder, as a table.
2. **Document types.** By extension, then — for the largest extension — the
   kinds inside it (policies, templates, READMEs, meeting notes).
3. **Front matter.** Keys that appear in the front matter of files that have
   it, with the number of files each key appears in, most frequent first.
4. **Links.** Number of files containing at least one internal link, and the
   total internal links; the ten most-linked targets with their in-link counts.
5. **Slices available for comparison.** Every comparison a later phase could
   make, each with its exact size (files, and share of the dataset): the
   top-level sections, a few second-level folders, a document-type split, and
   anything else unevenly distributed (long versus short documents, old versus
   new if dates exist). A slice is only usable if its size is stated here; a
   comparison no slice supports is not measurable, so list generously and
   honestly — a bucket of three files is not a slice.

Every number here comes from a command saved under `workspace/scripts/` (shell
or Node; no pandas), so a reader can rerun it. Small reads only: no sampling of
claims, no standout-word lists, no per-file close reading.

## glossary.md

The **practice lexicon** (Miranda et al. 2022): the words this community uses to
name its own practices, which an outside reader would misread. 30–60 entries,
each one line: the term, a one-line meaning as the data uses it, and one example
file path. Take terms from the data itself, not from theory. If a term means
something narrower or stranger here than in ordinary usage (a bot rule, a
ceremony, a role), say so in the meaning.

## data-character.md

- **What kind of evidence this is.** Documents written by whom, for what
  audience, edited when; whether it is a snapshot or has history.
- **Time coverage.** Dates you can establish, and how you established them.
- **What it can support.** Claims about documented rules, categories,
  prescriptions, stated rationales, and — through counts and comparisons across
  the slices above — emphasis, structure and change.
- **What it cannot support.** Behaviour, compliance, outcomes, and anything
  about actors the documents only talk about. Say what the data describes but
  does not record: a handbook documents how organising is *supposed* to work and
  the rules its bots follow, not what bots did — that would need git history,
  API logs or similar, and is a later sampling decision, not something you
  pretend to have.
- **The hold-out split.** The command you ran, the seed and fraction, the
  **depth** you chose and why, and the per-stratum table the tool printed (files
  per stratum, held-out count). The command is:

  ```bash
  node ./harness/tools/holdout.ts <dataset-dir> workspace/split --depth <d>
  ```

  Choose `--depth` so the strata are meaningful sections rather than arbitrary
  buckets. When one top-level folder holds almost everything (the GitLab
  Handbook: `handbook/` has 4168 of 4604 files), depth 1 puts ~90% of the corpus
  in one stratum and the split stops being stratified at all: use `--depth 2`
  there. Both lists hold dataset-relative paths. The tool counts one extension
  at a time (`--ext`, default `.md`), so if the corpus has several, run it per
  extension or say which one is the corpus. Record the choice and the table; a
  reader must be able to see that no meaningful slice is entirely held out.

## Definition of Done

All three files and both split lists exist; every table in `profile.md` and
`data-character.md` is produced by a script in `workspace/scripts/`; the split
covers every file exactly once and no stratum is fully held out; the depth and
its rationale are recorded; `handoff.md` starts with `Status: DONE` (or
`DONE_WITH_CONCERNS` naming the weak slice or missing date evidence).

Write only inside this node's `workspace/`, `rounds.md` and `handoff.md`.
