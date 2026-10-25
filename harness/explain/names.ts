// The one naming module for an explanation's tasks and their scripts (design §9).
//
// A plain letter task `A`..`Z` is one of the round's tasks. A reopen task `R<n><L>` (`R1A`, `R12C`)
// belongs to reopen loop `n`, which starts at 1 (`R0A` and `R01A` are not names). `R` alone is the
// plain letter R: a reopen task needs its digits, so the two never collide. A literature task `lit-NN` is neither and keeps its own form.
//
// Order: every plain letter is below every reopen task; reopen tasks order by their number, then
// their letter. The shared `assets.R|py` belongs to the greatest analysis task.

/** A task folder name: an analysis task (`A`, `R1A`) or a literature task (`lit-07`). */
export const TASK_NAME = /^(?:(?:R[1-9]\d*)?[A-Z]|lit-\d\d)$/;

/** An analysis task: a plain letter (`A`) or a reopen task (`R1A`). */
export const ANALYSIS_TASK = /^(?:R[1-9]\d*)?[A-Z]$/;

/** An analysis script name: `<task>_nn.R|py` for an analysis task, or the shared `assets.R|py`. */
export const ANALYSIS_SCRIPT = /^(?:(?:R[1-9]\d*)?[A-Z]_\d\d|assets)\.(?:R|py)$/;

/** A literature task `lit-<nn>`; its report is `workspace/reports/<nn>.md`. */
export const LIT_TASK = /^lit-(\d\d)$/;

/** A reopen task's number and letter: `R12C` → 12 and `C`. */
const REOPEN_TASK = /^R([1-9]\d*)([A-Z])$/;

/** The task a script `<task>_nn.R|py` belongs to (`R1A_03.R` → `R1A`). */
const SCRIPT_TASK = /^((?:R[1-9]\d*)?[A-Z])_\d\d\.(?:R|py)$/;

export type ParsedTask = { kind: "analysis"; reopen: number; letter: string } | { kind: "lit"; n: number };

/** The parts of a task name, or undefined when it is not a task name. A plain letter has `reopen` 0. */
export function parseTask(name: string): ParsedTask | undefined {
  const lit = LIT_TASK.exec(name);
  if (lit !== null) return { kind: "lit", n: Number(lit[1]) };
  if (!ANALYSIS_TASK.test(name)) return undefined;
  const reopen = REOPEN_TASK.exec(name);
  if (reopen === null) return { kind: "analysis", reopen: 0, letter: name };
  return { kind: "analysis", reopen: Number(reopen[1]), letter: reopen[2] ?? "" };
}

/**
 * Orders two analysis tasks: by reopen number, then by letter. A plain letter is reopen 0, so it is
 * below every reopen task. Throws for a name that is not an analysis task (fail closed).
 */
export function compareTasks(a: string, b: string): number {
  const x = analysisPart(a);
  const y = analysisPart(b);
  return x.reopen - y.reopen || (x.letter < y.letter ? -1 : x.letter > y.letter ? 1 : 0);
}

function analysisPart(name: string): { reopen: number; letter: string } {
  const parsed = parseTask(name);
  if (parsed?.kind !== "analysis") throw new Error(`${JSON.stringify(name)} is not an analysis task`);
  return parsed;
}

/** The analysis task a script `<task>_nn.R|py` belongs to, or undefined for `assets.*` and any other name. */
export function scriptTask(file: string): string | undefined {
  return SCRIPT_TASK.exec(file)?.[1];
}

/** The greatest analysis task among `names`; literature tasks and other names are ignored. */
export function greatestTask(names: string[]): string | undefined {
  let greatest: string | undefined;
  for (const name of names) {
    if (!ANALYSIS_TASK.test(name)) continue;
    if (greatest === undefined || compareTasks(name, greatest) > 0) greatest = name;
  }
  return greatest;
}
