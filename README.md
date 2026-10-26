# Research factory

An agent harness that takes a text corpus and a broad research interest and produces research papers in the *computationally intensive theory construction* (CTC) genre of Information Systems research. It is a research prototype: an experiment in how far AI agents can run a whole research workflow, with the human setting the data, the interest and the configuration and steering when needed.

It was built with AI coding agents on the pi coding-agent runtime (npm package `@earendil-works/pi-coding-agent`) and used to produce the paper "Who Approves?" (submitted to the ICIS 2026 workshop on Autonomous Scholarship), from the public GitLab Handbook. The run record of that experiment (ledgers, briefs, analysis scripts, reviews) is published separately.

## How it works

Writing a paper is treated as a tree search. One dataset spawns a tree:

```
dataset
 └── pattern       a regularity measured across the corpus, from a pre-registered measure (Phase 1)
      └── puzzle   a pattern that violates an expectation, checked against the literature (Phase 2)
           └── explanation   one evolving argument built from rounds of analysis and literature (Phase 3)
                └── paper    one Quarto manuscript per explanation (Phase 4)
```

Phase 0 prepares the data (profile, glossary, a statement of what kind of evidence the data are, a held-back split) and writes expectations from theory areas that fit the research interest.

The design principles:

- **The tree is managed by code; agents make the research decisions.** Each node is a folder (`node.json`, brief, workspace, round logs, handoff). Only validated tool calls change it, and its history is git.
- **One long-lived AI owner per phase**, which decides what to expand, park or promote but never does node work. **One bounded AI worker per node**, which reads its brief, works only in its workspace, and ends with a handoff. A **run supervisor** (plain code, no AI) starts and restarts the owners.
- **Guards, not promises.** Per-phase tool allowlists, a guard that refuses reads of the held-back split, code-gated `claim`, `promote` and `submit`, and reviewers and judges that can only report.
- **Pre-registration and traceability.** A measure is committed before it is run; every number in an argument links to a row of a registry of analysis outputs; analyses re-run in a fresh container; a paper's numbers, tables, quotations and diagrams are embeds that trace back to the data, and its citations and verbatim quotes are checked against the literature corpus.
- **Competition and iteration.** Puzzles are ranked by Elo tournaments (each match judged in both orders; a split verdict is a draw); the analysis loop alternates analyses and literature checks until two quiet rounds or a round cap.

Phases 0 to 4 are implemented. Phase 5 (critique loop, final tournament, held-back split test) is designed but not built.

## Requirements

| Needed for | What |
|---|---|
| Everything | Node.js 24 or later (the code runs as TypeScript through Node's type stripping), `npm ci` |
| Running agents | pi (`@earendil-works/pi-coding-agent`, developed against 1.3.0) with `pi-subagents` (0.80.0); a model provider configured in pi. The default model in `harness/factory.ts` is `claude-bridge/claude-haiku-5-5`; change `model` and `judgeModel` in a run's `config.json` |
| Hosting a run | herdr, a terminal multiplexer for agents (0.9.3; the commands the code relies on are in `harness/launch.ts`), which holds the supervisor and owner sessions |
| Phase 3 (analysis) | Docker; build `ctc-analysis:1` with `docker build -t ctc-analysis:1 harness/analysis/` (R and Python, no network, read-only data) |
| Phase 4 (writing) | Docker; build `ctc-paper:1` with `docker build -t ctc-paper:1 harness/paper/` (Quarto and Graphviz, no network) |
| Literature (Phases 0 to 4) | `deepis`, a local full-text corpus of information systems and management papers with chunk-level citations, queried by workers and by the citation and quote checks. **It is a private, licensed corpus and is not included.** To use the harness without it you must provide a substitute with the same command-line interface (`search`, `context`, `metadata`, `bib`) or remove the literature steps from the skills |

The agent files in `.pi/agents/` list only this repository's extensions. If your provider needs an extension of its own (for example a model bridge), add it to the `extensions:` list of `ctc-worker.md` and `ctc-reviewer.md`, because a listed set switches off ambient extension discovery.

## Quick start

```sh
npm ci
npm test                       # about 1,290 tests, around 80 seconds; Docker-backed ones skip if the images are missing
docker build -t ctc-analysis:1 harness/analysis/
docker build -t ctc-paper:1 harness/paper/
```

Start a run from inside this repository, in `pi`:

```
/research-factory init <dataset-dir> "<research interest>" [runDir]
/research-factory status [runDir]
/research-factory stop [runDir]       # a safe pause; do not just interrupt the session
/research-factory resume [runDir]
```

or, without pi, `node harness/factory-cli.ts init <dataset-dir> "<interest>" [runDir]` (same subcommands). `init` creates the run folder (default under `runs/`, which is git-ignored), starts a herdr session and the supervisor, and the supervisor starts a phase owner wherever there is work. A run's `config.json` sets the model per run, the skill per phase, and caps (workers in parallel, analysis rounds, reopens, bare numbers allowed in a paper). For a paper's front matter put the author names in `authors.yml` in the run folder.

The dataset is a folder of documents. Phase 0 makes the split (by default about 20 percent of documents held back, stratified by top-level section with a fixed seed), and the guard refuses all reads of that list and of the dataset root from Phases 1 to 4.

## Repository layout

```
harness/
  tree.ts, launch.ts, factory.ts, supervise.ts, supervisor.ts   the tree, the run lifecycle, the supervisor
  guard.ts                       tool allowlists and refusals per phase, role and path
  owner-extension.ts, worker-extension.ts, reviewer-extension.ts   the pi tools each role gets
  research-factory-extension.ts  the /research-factory command
  tournament/                    Elo ranking, judge, stop rules, the Phase 2 criteria
  explain/                       Phase 3: rounds, reproduction check, reopen, names
  analysis/                      Phase 3 container, its helper library (R and Python), and run.ts
  paper/                         Phase 4: outline, embeds, quotes, diagrams, Quarto render, style passes
  tools/                         check-pattern, check-puzzle, check-argument, check-paper, check-citations, holdout
  skills/                        the prompts that drive each phase and role (phase-N, roles/, criteria/, vendor/)
  agents/, ../.pi/agents/        the two pi agent definitions (worker, reviewer)
  templates/                     the APA style and the Quarto project file for papers
  test/                          the test suite
.pi/extensions/research-factory.ts   the file pi loads to register the command
```

`harness/skills/*` are the instructions the agents run on, so they are the part that most shapes behaviour. The `vendor/` folder holds copies of two writing-style skills used in the style passes of Phase 4; see `harness/skills/vendor/SOURCE.md`.

## Tests

`npm test` runs the whole suite with Node's test runner. Two checks compare the Phase 2 rubric with the text of Tavory and Timmermans (2014), *Abductive Analysis*. The book is copyrighted and not distributed, so those checks skip with a message unless you place your own Markdown conversion of it at `docs/abduction.md`. Seven checks compare the skills with the design specifications, which were kept in the original development repository; they skip when `docs/superpowers/specs/` is absent. Tests that need the Docker images or the external skill repositories also skip with their reason when those are absent.

## Known limitations

- The judge used the same model as the workers in the reference run, and was strongly position-biased. A two-order rule turns split verdicts into draws, but a judge from a different model family is not enforced.
- The analysis loop's "no substantial change" stop rule did not fire as designed in the reference run; both arguments ran to the round cap.
- Per-call model settings such as temperature are not recorded.
- The supervisor does not recover by itself from a provider outage or a usage-limit stall; an unclean interruption leaves the old owner session on its old model (use `stop` then `resume`).
- Source comments and some skill text still point to design notes and plans that were kept in the original development repository and are not part of this one.

## Licences and third-party material

- The code and the skills written for this project are released under the MIT licence (`LICENSE`, copyright 2026 Julian Prester). The two items below keep their own terms and are not covered by it.
- `harness/templates/apa.csl` is the APA 7th edition style from the Citation Style Language repository, licensed CC BY-SA 3.0, and is included unchanged.
- `harness/skills/vendor/` holds two skills copied unchanged from another repository; see `SOURCE.md` there for their origin. Check their terms before redistributing them, because the MIT licence above does not cover them.
- The GitLab Handbook used in the reference run is MIT-licensed (copyright GitLab B.V.) and is not included.
