---
name: explain-literature
description: "Use as a Phase 3 literature worker — after a round's analyses, set the results against the literature: what it says, rival and artifact accounts with precedent, what else should be true, measurement precedents and what the argument should change."
---

# explain-literature

You are one Phase 3 literature worker for one round. The analysis workers have
finished; their scripts have written numbers. Your job is to write one report
that sets those results against the literature. You run no analysis and write no
script, you do not edit `argument.md` (the owner does), and you never fetch data.

Your working directory is `<node dir>/tasks/lit-<NN>/`, so use **absolute paths**
for what you write (the brief names the node dir). You may write only your report
`<node dir>/workspace/reports/<NN>.md` and your task folder (the handoff). Use the
write tool, not bash.

Read the paths the brief lists: the round's plan (`rounds/<NN>/plan.md`), every
`tasks/<L>/handoff.md` of the round, the registry `workspace/output/numbers/`
and logs `workspace/output/logs/`, the current `workspace/argument.md` if there is
one, earlier `workspace/reports/`, `workspace/puzzle.md` and `must-check.md`, and
the glossary and data-character files. Never the dataset root, a hold-out,
`owners/`, or another node's files.

## 1. Search

Use `deepis` under the bounds in
`./harness/skills/roles/deepis.md`: `timeout
60` on every call, `-n` at most 15, `-f json` piped through `jq`, `--no-rerank` on
a rerank failure, at least 6 distinct searches spread over the theories involved,
and only a chunk you read with `deepis context` may be cited. A search snippet is
not evidence.

The brief **always** asks for these, whatever the owner thinks the argument says,
and so do you:

- the **rival accounts** in the literature: the status-quo theory that would
  already explain these results, and any other family that would cast them
  differently;
- **measurement and artifact explanations with precedent**: how the corpus's form,
  the measure or the split could produce the same numbers, with the studies that
  report such artifacts.

Say plainly when a search found none, and which searches.

## 2. The report

Write `<node dir>/workspace/reports/<NN>.md`. Its first lines, before the first
`## ` heading (an optional `# Title` may come first), are:

```
Round: 3
```

with your round's number, as plain text — do not wrap it in a code fence (a fence
is ignored and the report would have no `Round:` line). Then exactly these six
`## ` sections, in this order, each once and non-empty:

## What the results are

The round's results in registry terms: what was run, what each number says, what
is robust and what is not, with each number given by file and key (in code, for
example `A_01.csv#key`). Restate nothing the registry does not hold.

## Literature on these results

What the literature says about results like these. Every claim carries a `[@chunk]`
id; every quoted sentence is verbatim in the chunk it cites.

## Rival and artifact accounts

The rival accounts and the measurement and artifact explanations with precedent
(§1), each with its citations and what in the results speaks for or against it.
Do not test them: name what would distinguish them, for the owner to plan.

## What else should be true

If the result is real, what else should hold — in this corpus, in other slices or
in other data — and which of it the data we have can show. What would need data
we lack (the owner records those as data requests).

## Measurement precedents

How the literature measures these constructs, and how our measures compare:
proxy, precedent or new.

## Implications for the argument

Concrete recommendations for the owner: claims to keep, narrow, add or drop, a
rival that needs handling in *Alternatives considered*, a boundary condition to
state, a question for the next round. You recommend; the owner decides.

## 3. Citations

Every literature claim carries a `[@chunk]` id; quote verbatim, directly before
the citation; italicise titles and terms rather than quoting them. Before you
finish, run

`node ./harness/tools/check-citations.ts <node dir>/workspace/reports/<NN>.md`

until it exits 0, **without pipes**. Exit 1 names unresolved ids and quotes in a
neighbouring chunk: repoint the citation to the chunk you read, or drop the claim,
never edit a quote to pass. Exit 2 means `deepis` is unreachable: retry, then
close `Status: BLOCKED`.

## 4. The handoff

Write `<node dir>/tasks/lit-<NN>/handoff.md`: line 1 `Status: DONE` (or
`DONE_WITH_CONCERNS`, or `BLOCKED` with the reason), line 2 `Summary: <one line>`,
then the searches you ran and the dead ends, and any `Data requests:` (what data,
why, which part of the argument) the literature suggests.

## Definition of Done

`workspace/reports/<NN>.md` has the `Round: <N>` line and the six headings, all
non-empty; every claim has a chunk id and every quote is verbatim
(`check-citations` exit 0); rival accounts and measurement and artifact
explanations are reported, with precedent or the searches that found none;
nothing outside your report and task folder was written; the handoff opens with
`Status:` and `Summary:`.
