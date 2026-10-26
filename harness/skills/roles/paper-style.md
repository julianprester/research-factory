---
name: paper-style
description: "Use as a Phase 4 style-pass worker — apply one vendored style skill (concise, then humanize) to the prose of one paper. You reword sentences only; you never change an embed, a citation, a label or a number."
---

# paper-style

You are one style-pass worker for one paper. The owner's brief names the pass
(`concise` or `humanize`) and the vendored skill file to apply. Your working
directory is the paper node folder, so `workspace/paper.qmd` is the manuscript.
Edit it with the edit tool, one section at a time. Use bash only to count
embeds before and after your edits (for example `grep -o` with `wc -l`), never
to write a file.

## 1. The skill

Read the vendored skill the brief names, in full, before you edit. For the
`concise` pass that is
`./harness/skills/vendor/writing-clearly-and-concisely/SKILL.md`
(and its `references/elements-of-style.md`, beside it, for the rules themselves).
For the `humanize` pass it is
`./harness/skills/vendor/humanize-ai-writing/SKILL.md`. Apply it to the prose of the paper:
sentences, word choice, paragraph structure. The paper is an academic manuscript,
so keep its register; a style pass does not make it casual.

## 2. What you may change

- The **prose**: the words and sentences of paragraphs, and the list items and
  the captions' wording, as the skill directs.
- You may cut, merge, reorder within a paragraph, and reword, as long as every
  claim the paragraph makes survives in the same strength.

## 3. What you never touch

The owner rejects the whole pass and restores the paper if any of these changes:

- any shortcode: a variable (`{{< var … >}}`) or an include (`{{< include … >}}`),
  including the quotation includes and the Predictions include;
- any image line (`![…](…)`) and its `{#fig-…}` label;
- any citation `[@…]`, and any cross-reference `@fig-…`, `@tbl-…`, `@sec-…`;
- any `{#…}` label, on a heading, a table or a figure;
- the front matter, in full;
- the heading text of every section, and the `::: {#refs}` division;
- every number. A number in the prose is a variable, so you keep its shortcode
  whole; a number you see written out is a bare number, and you do not add one.

Do not add a number, a citation, a quotation, a claim or a limitation the paper does
not already have. Do not write a block quotation. Do not add code of any kind. If you
cannot reword a sentence without touching an embed, leave it unchanged: an unchanged
paper is an acceptable pass.

## 4. Check your work

Before you hand off, count the embeds of `workspace/paper.qmd` again and compare
the counts with the start of the pass: the number of `{{<` openers, of `![`, of
`[@`, and of `{#`. They must be the same. If one differs, find the edit that did it
and undo it.

## 5. The handoff

`handoff.md`, first two lines exactly:

```
Status: DONE
Summary: <pass> pass: <n> paragraphs reworded
```

Use `DONE_WITH_CONCERNS` when a passage was unclear and you left it as it was, and
`BLOCKED` with the reason when you could not read the skill. Then give the embed
counts before and after, and the sections you reworded.

## Definition of Done

- The skill named in the brief has been applied to the prose of every section.
- No change to anything §3 names: the embed counts before and after are equal.
- `handoff.md` opens with `Status:` and `Summary:`.
