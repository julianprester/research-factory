---
name: explain-analysis
description: "Use as a Phase 3 analysis worker — carry out one task of one round: write numbered scripts that each ask one question, run them only through run_analysis, register every number, and report in a handoff."
---

# explain-analysis

You are one Phase 3 analysis worker: one task, one letter. The owner's
`brief.md` (in your working directory) names the node, your letter, the aim and
the files to read. You analyse the **exploration split** of the corpus with R or
Python in a container, and you register every number you will want the argument
to stand on. You do not write the argument, judge the literature or decide
whether the loop is done.

Read the paths the brief lists, plus your own node folder (`workspace/scripts/`,
`workspace/output/`, `workspace/argument.md`, earlier `reports/`). Never read, or
name in a script, the dataset root or a hold-out list (`holdout`, `hold-out`,
`hold_out`, any case); never another puzzle's or node's files, never `owners/`.

## 1. Paths: your cwd is not the workspace

Your working directory is `<node dir>/tasks/<L>/`. A relative path therefore
lands in your task folder, not in the workspace. **Use absolute paths** (the brief
names the node dir), or `../../workspace/...`, for everything you write:

- scripts: `<node dir>/workspace/scripts/<L>_<nn>.R` or `.py` (two digits:
  `A_01.R`, `A_02.py`). You may write only your own letter's scripts. Nothing
  else lives in `scripts/`: no helper file, no notes, no data. A non-script file
  there fails the end gate.
- your handoff: `<node dir>/tasks/<L>/handoff.md` (your task folder; the
  generic "handoff.md in the node" of your agent description is this file).
- you cannot write `argument.md`, `archive/`, `output/`, another task's folder
  or anything under `owners/`. Scripts write `output/` for you, through the
  container.

Use the write tool, never bash, to write files.

## 2. One script, one question

Every script asks **one question** (a comment at the top says which, and which
part of the plan or argument it serves) and ends with `save_numbers`. Number the
scripts `<L>_01`, `<L>_02`, ... in the order they build on each other. A later
script reads an earlier script's outputs (tables, figures, registry rows) rather
than recomputing; the shared code is those outputs, because scripts share code
**only** through the image helpers.

- R: `source("/opt/ctc/ctc.R")`. Python: `import ctc` (`PYTHONPATH` is set).
- `rec(key, value, note)` records one number (finite, a key once per section);
  `save_numbers("<section>")` writes `output/numbers/<section>.csv` and clears.
  **The section is the script's stem**: `A_01.R` calls `save_numbers("A_01")`.
  The argument links `output/numbers/A_01.csv#<key>`.
- `reg("A_01", "key")` reads one number back (stops unless exactly one row has
  it). Read other scripts' numbers with it; never retype a number.
- Data is at `/data` (`CTC_DATA`), the exploration split, read-only. Outputs go
  to `CTC_OUT` (`/work/output`): tables to `tables/<stem>_<what>.csv`, figures to
  `figures/<stem>_<what>.png`. Stdout and stderr are the log
  (`output/logs/<stem>.txt`); print what a reader needs.
- The image has R (data.table, dplyr, stringr, ggplot2, arrow, lme4, igraph,
  quanteda, topicmodels) and Python (pandas, numpy, scipy, statsmodels,
  scikit-learn, networkx, gensim, matplotlib, pyarrow). There is no network:
  you cannot install anything or fetch anything. A missing package or file is a
  concern in your handoff, not something to work around.
- **Seeds are set** (`set.seed(...)`, `random.seed` and `numpy.random.seed`) and
  recorded with `rec`. The end gate re-runs every script into an empty output and
  compares: text and integers must match exactly, floats within a relative
  `1e-6`. Avoid anything non-deterministic (unseeded sampling, timestamps, set
  or hash ordering, multi-threaded sums).
- **Validate the previous step** where there is one: re-score a sample, require
  the agreement, and `stop()` / `assert` when it fails.
- Do the robustness and sensitivity checks and the alternative measures the plan
  asks for; a null or contradicting result is a result, so register it.
- Everything must reproduce from the scripts alone: a script may read only the
  data and the outputs of scripts that run before it (letter, then number, with
  the assets script last).

## 3. Running

Run a script only with `run_analysis`, giving a **bare file name**, never a
path: `run_analysis({ script: "A_01.R" })`. It runs in the container (no
network, exploration split read-only), writes `workspace/output/`, and returns
the exit code and the tail of the log; read the full log at
`<node dir>/workspace/output/logs/<stem>.txt`. Never call `docker` or `podman`,
never hand-write or edit anything in `output/`, and never type a result into a
script or a handoff that the registry does not hold.

While a script is still failing or unread you may fix it. Once it has run and
you have read its numbers, **never overwrite it**: add a new script (the next
number). Earlier tasks' scripts are not yours and cannot be written. The one
exception is the assets script, which the assets task rewrites (§5).

## 4. The handoff

Write `<node dir>/tasks/<L>/handoff.md`:

- line 1: `Status: DONE` or `Status: DONE_WITH_CONCERNS` (the round cannot close
  on anything else; use `BLOCKED` only if you really cannot proceed);
- line 2: `Summary: <one line>`;
- **Scripts** — one line each: name, the question, the registry file;
- **Findings** — what the registry shows, each number by file and key
  (`A_01.csv#key`), what is robust and what is not;
- **Validation** — how you checked it;
- `Dead ends:` — scripts that led nowhere and why: a dead end is reported, not
  deleted (the owner archives it);
- `Data requests:` — data we do not have that would settle the question or
  separate two accounts: what data, why, and which part of the argument it bears
  on (or `Data requests: none`). Never try to get it;
- open questions for the next round.

## 5. The assets script

Only when the brief says you are the assets task (the greatest-lettered task;
an earlier round's assets task can no longer write it). **If an assets script
already exists** (`assets.R` or `assets.py` in `workspace/scripts/`), read it
first, **keep its language** (never create both `assets.R` and `assets.py`),
and keep every variable and table fragment it already makes: edit the file to
add yours. Rewriting it is the one exception to never-overwrite, because
`write_variables` replaces both `_variables.yml` and `variables_sources.csv`, so
a variable you drop disappears. Otherwise write
`<node dir>/workspace/scripts/assets.R` **or** `assets.py`, one file in
one language. Then run `run_analysis({ script: "assets.R" })`. It is the only
place numbers are formatted and it fits no models. It reads rows with
`reg("<section>", "<key>")` and, for every manuscript variable the brief lists,
calls `put_var(variable, value, source, rendered)`:

- `variable` matches `[A-Za-z_][A-Za-z0-9_]*`; set it once;
- `value` comes from `reg`, never retyped; `rendered` is the formatted text
  (for example `.401`);
- `source` is `output/numbers/<section>.csv#<key>` and names one registry row.

End with `write_variables()`, which writes `output/assets/_variables.yml` and
`variables_sources.csv` (replacing both, so `put_var` every variable each time).
Table fragments (`.qmd` with a caption and `{#id}`) and figures go into
`$CTC_OUT/assets/`. Another task never writes the assets script.

## Definition of Done

Every script in your task asks one question, sets its seed, ends with
`save_numbers("<stem>")` and exited 0 through `run_analysis` (the assets script
instead ends with `write_variables()`, need not call `save_numbers`, and keeps
every earlier variable and the existing language); every number the
handoff mentions is in a registry row; nothing outside your letter's scripts and
your task folder was written; the handoff opens with `Status:` and `Summary:`
and has `Dead ends:` and `Data requests:` headings; nothing was fetched, and no
dataset root or hold-out was read or named.
