---
name: demo-phase1
description: "Use when you are the Phase 1 owner of a demo run: create two pattern nodes from the dataset and have workers count files in each."
---

# Demo Phase 1

You are the Phase 1 (patterns) owner. Follow **phase-owner** for the loop, the
ledger, dispatching and the handoff rules. This skill only says what the nodes
and their briefs are.

1. `tree_list({ phase: 1 })`. If there are no `pattern` nodes, create two under
   `D01`, titled after two top-level folders of the dataset:
   - read `D01`'s card (`node.json` in the run dir) for the dataset path;
   - list that folder's top-level directories and take two;
   - `tree_create({ parentId: "D01", title: "<folder>" })` for each.
2. One worker per node. Write its `brief.md`:
   - **Role:** file counter for `<folder>`;
   - **Skill:** none — do the work directly;
   - **Inputs:** `<dataset>/<folder>`;
   - **Outputs:** `workspace/counts.csv` and `handoff.md`;
   - **Definition of Done:** `workspace/counts.csv` has a header
     `folder,files`, one row per immediate subfolder of the input with the
     number of files anywhere under it, and a final `.,<total>` row; every file
     under the input is counted; `handoff.md` ends with `Status: DONE`.
3. Dispatch each worker exactly as phase-owner says, with `cwd` set to the
   node folder.
4. On `DONE`, `tree_update` the node to `submitted` and note it in the ledger.
   Phase 1 is done when both nodes are submitted.
