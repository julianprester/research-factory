---
name: prep-expectations
description: "Use as a Phase 0 area worker — write 3–4 theory-anchored, measurable expectations for one theoretical area of the run's research interest."
---

# prep-expectations

You own one theoretical area of Phase 0. You do not own the interest: read it
from the brief and the root `node.json`. Your output is the base against which
Phase 1 measures surprise, so every entry must be falsifiable and fair.

An earlier run's "surprises" were juxtapositions of two pages, measured with
raw keyword totals, against expectations no literature stated — assumptions, not
surprises. You prevent two of those failures: the cited literature must state
the prediction, and the implication must be a measure over this data.

## Output: `workspace/expectations.md`

3–4 entries, each exactly:

```markdown
## E<n>: <short title>

**Theory:** <named theory> — the passages that state the prediction, with their
chunk ids [@123456]. One sentence on what the theory is a theory of.

**Prediction:** <the general claim the theory makes, in its own terms, for
organisations in general — not yet about this dataset>

**Measurable implication here:** <measure> — unit <unit>, denominator <n from
profile.md>, compared across <slices from profile.md>. <Why the data can bear
this: the document type and slice that carry the measure, given
data-character.md.> Expect <direction/spread> in <slice A> versus <slice B>.

**Rival:** <a competing theory's different prediction, cited [@654321]> or
`none found`, with one line on what the rival would imply instead.
```

## How to work

- Read the brief's inputs first: the interest, your area, and Z01's
  `profile.md`, `data-character.md` and `glossary.md`. The slices you may use are
  the ones listed in `profile.md`; if the implication needs a slice that is not
  there, say what the slice would need to be and either drop the implication or
  weaken it to one the listed slices support.
- Follow `./harness/skills/roles/deepis.md`
  for every search: bounded, timed out, `jq`-compacted, and only what you read
  with `deepis context` gets cited. At least 6 distinct searches over the area's
  theories before you commit to an entry.
- Use the practice glossary for wording: "control" here may name a bot rule,
  so phrase the implication in the measure the data has, not the theory's noun.

## Rules that make the entry usable

- **The prediction must be in the passage you cite.** If the theory is about
  organising and the data documents organising rules, the passage has to say
  something a count across sections could disconfirm. If you can only infer the
  prediction from the topic, the entry is an assumption: drop it, or keep it and
  flag it `DONE_WITH_CONCERNS` — never present an inferred prediction as cited.
- **Never a raw keyword total.** "The word *async* appears 900 times" is not a
  finding. A measure has a unit, a denominator (files, sections, documents of a
  type) and a comparison across the slices in `profile.md`, and its direction is
  stated in advance. Counts of documents containing a practice named in the
  glossary are fine; counts of tokens are not.
- **Respect data-character.md.** It says what the corpus documents and what it
  only talks about. An implication about behaviour, compliance or bot actions
  needs evidence this corpus does not have: reframe it as a claim about the
  documented rules, or as needing later sampling.
- **Rival or none.** Tavory & Timmermans (2014): a surprise only exists against
  a theoretical reading, so a competing reading of the same material is the most
  valuable line in the entry. Search for one; `none found` is an answer, an
  invented rival is not.
- **3–4 entries, each a different theory**, none a rewording of another. You
  cannot see other areas; the assembler de-duplicates, but a missing theory is
  not recoverable there.
- Before you finish, run `node
  ./harness/tools/check-citations.ts
  workspace/expectations.md` until it exits 0. It checks two things: that every
  `[@id]` resolves, and that every sentence you put in quotation marks appears in
  the chunk you cite. Exit 1 names the ids deepis does not know — fix them by
  finding the real chunk, not by deleting the claim's support — and prints each
  quote that is not in its cited chunk. On `found in chunk <id>`, the quote is
  verbatim in that neighbouring chunk: replace the id with the one reported. On
  `not found nearby`, re-read the source or drop the quote; never edit a quote to
  make it pass.

## Definition of Done

`workspace/expectations.md` has 3–4 entries with all four fields; every theory
and rival claim carries at least one `[@chunk]` id that resolves
(`check-citations` exit 0); every measurable implication names a measure, a
unit, a denominator and a comparison across listed slices and states its
expected direction; failed searches are logged in `rounds.md`; `handoff.md`
starts with `Status: DONE` (or `DONE_WITH_CONCERNS`, naming entries whose
prediction is inferred rather than stated).

Write only inside this node's `workspace/`, `rounds.md` and `handoff.md`. Read
only the input paths the brief lists, even when they are another node's files.
