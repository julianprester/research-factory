// The one naming module (`harness/explain/names.ts`): plain letter tasks `A`..`Z`, reopen
// tasks `R<n><L>`, literature tasks `lit-NN`, and the script names each task owns. The rules
// are tested here once; the callers' suites check that they are wired to these rules.
import assert from "node:assert/strict";
import test from "node:test";

import { ANALYSIS_SCRIPT, ANALYSIS_TASK, compareTasks, greatestTask, parseTask, scriptTask, TASK_NAME } from "../explain/names.ts";

test("parseTask reads a plain letter, a reopen task and a literature task", () => {
  assert.deepEqual(parseTask("A"), { kind: "analysis", reopen: 0, letter: "A" });
  assert.deepEqual(parseTask("R1A"), { kind: "analysis", reopen: 1, letter: "A" });
  assert.deepEqual(parseTask("R12C"), { kind: "analysis", reopen: 12, letter: "C" });
  assert.deepEqual(parseTask("lit-07"), { kind: "lit", n: 7 });
});

test("R alone is the plain letter R: a reopen task needs its digits", () => {
  assert.deepEqual(parseTask("R"), { kind: "analysis", reopen: 0, letter: "R" });
  assert.equal(ANALYSIS_TASK.test("R"), true);
  assert.equal(TASK_NAME.test("R"), true);
  assert.equal(ANALYSIS_SCRIPT.test("R_01.R"), true);
  assert.equal(scriptTask("R_01.R"), "R");
});

test("parseTask rejects what is neither a letter, a reopen task nor a literature task", () => {
  for (const name of ["RA", "R1", "R1a", "AB", "lit-7", ""]) {
    assert.equal(parseTask(name), undefined, JSON.stringify(name));
    assert.equal(TASK_NAME.test(name), false, JSON.stringify(name));
    assert.equal(ANALYSIS_TASK.test(name), false, JSON.stringify(name));
  }
});

test("TASK_NAME admits reopen tasks and literature tasks; ANALYSIS_TASK admits only the analysis ones", () => {
  assert.equal(TASK_NAME.test("R1A"), true);
  assert.equal(TASK_NAME.test("lit-07"), true);
  assert.equal(ANALYSIS_TASK.test("R1A"), true);
  assert.equal(ANALYSIS_TASK.test("lit-07"), false);
});

test("ANALYSIS_SCRIPT admits a plain or reopen task's two-digit script and assets, and nothing else", () => {
  for (const name of ["A_01.R", "V_12.py", "R1A_01.R", "R12C_03.py", "assets.R", "assets.py"]) {
    assert.equal(ANALYSIS_SCRIPT.test(name), true, name);
  }
  for (const name of ["R1A_1.R", "R1a_01.R", "lit-01.R", "A_01.txt", "x/A_01.R"]) {
    assert.equal(ANALYSIS_SCRIPT.test(name), false, name);
  }
});

test("compareTasks puts plain letters before reopen tasks, and orders reopen tasks by number, then letter", () => {
  assert.ok(compareTasks("V", "R1A") < 0, "a plain letter is below any reopen task");
  assert.ok(compareTasks("R1Z", "R2A") < 0, "a lower reopen number wins whatever the letter");
  assert.ok(compareTasks("R9A", "R12A") < 0, "numbers compare as numbers, not as text");
  assert.ok(compareTasks("A", "B") < 0);
  assert.ok(compareTasks("B", "A") > 0);
  assert.equal(compareTasks("R1A", "R1A"), 0);
  assert.throws(() => compareTasks("lit-01", "A"), /not an analysis task/, "a literature task has no place in the order");
});

test("scriptTask returns the task a script belongs to, and undefined for assets and for anything else", () => {
  assert.equal(scriptTask("R1A_03.R"), "R1A");
  assert.equal(scriptTask("V_01.py"), "V");
  assert.equal(scriptTask("assets.R"), undefined);
  assert.equal(scriptTask("assets.py"), undefined);
  assert.equal(scriptTask("R1A_3.R"), undefined, "two digits");
  assert.equal(scriptTask("lit-01_01.R"), undefined);
});

test("greatestTask is the greatest analysis task: a reopen task beats every plain letter, lit-NN is ignored", () => {
  assert.equal(greatestTask(["A", "V", "R1A"]), "R1A");
  assert.equal(greatestTask(["A", "R2A", "R1Z"]), "R2A");
  assert.equal(greatestTask(["lit-09", "B", "lit-01", "c", "A"]), "B");
  assert.equal(greatestTask(["lit-01", "assets.R"]), undefined);
  assert.equal(greatestTask([]), undefined);
});

test("a reopen number starts at 1: R0A, R01A and R00B are not task names, and neither is a script name built on them", () => {
  for (const name of ["R0A", "R01A", "R00B"]) {
    assert.equal(parseTask(name), undefined, name);
    assert.equal(TASK_NAME.test(name), false, name);
    assert.equal(ANALYSIS_TASK.test(name), false, name);
    assert.equal(ANALYSIS_SCRIPT.test(`${name}_01.R`), false, `${name}_01.R`);
    assert.equal(scriptTask(`${name}_01.R`), undefined, `${name}_01.R`);
  }
});

test("plain R and R_01.R are still the plain letter R; R10A is a valid reopen task that sorts after R9Z", () => {
  assert.deepEqual(parseTask("R"), { kind: "analysis", reopen: 0, letter: "R" });
  assert.equal(scriptTask("R_01.R"), "R");
  assert.deepEqual(parseTask("R10A"), { kind: "analysis", reopen: 10, letter: "A" });
  assert.equal(TASK_NAME.test("R10A"), true);
  assert.equal(scriptTask("R10A_01.R"), "R10A");
  assert.ok(compareTasks("R9Z", "R10A") < 0, "reopen 9 sorts below reopen 10, whatever the letters");
});

test("the script names end at the extension: a suffix after .R or .py, a second extension, or a trailing newline is not a script name", () => {
  for (const name of ["A_01.Rx", "A_01.py.sh", "A_01.R.R", "A_001.R", "A_01.R\n"]) {
    assert.equal(ANALYSIS_SCRIPT.test(name), false, JSON.stringify(name));
    assert.equal(scriptTask(name), undefined, JSON.stringify(name));
  }
});
