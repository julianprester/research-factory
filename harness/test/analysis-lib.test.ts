// analysis/lib: the registry and assets helpers, in Python (the reference) and R.
// The Python tests run on the host's python3. The R tests run Rscript inside the
// ctc-analysis:1 image and are skipped, with the reason, when that image is absent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const LIB_DIR = fileURLToPath(new URL("../analysis/lib/", import.meta.url));
const IMAGE = "ctc-analysis:1";

/** The expected files, byte for byte, for the same calls in both languages. */
const NUMBERS_CSV = 'name,value,note\nint,1234,\nsmall,0.1234567891,"a note, with a comma"\n';
const VARIABLES_YML = 'm1_or_lspec: ".401"\nn_pages: "1234"\n';
const SOURCES_CSV = "variable,value,rendered,source\nm1_or_lspec,0.401,.401,12_model1#m1\nn_pages,1234,1234,01_counts#n\n";

/** A driver that puts the lib dir on sys.path from argv (-I ignores PYTHONPATH) and runs stdin. */
const DRIVER = "import sys\nsys.dont_write_bytecode = True\nsys.path.insert(0, sys.argv[1])\nexec(sys.stdin.read(), {'__name__': '__main__'})\n";

const driverDir = mkdtempSync(path.join(tmpdir(), "ctc-driver-"));
const driver = path.join(driverDir, "driver.py");
writeFileSync(driver, DRIVER);
process.on("exit", () => rmSync(driverDir, { recursive: true, force: true }));

function outDir(): string {
  return mkdtempSync(path.join(tmpdir(), "ctc-out-"));
}

function runPython(out: string, code: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("python3", ["-I", driver, LIB_DIR], {
    input: code,
    env: { ...process.env, CTC_OUT: out },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function ok(result: { status: number | null; stderr: string }): void {
  assert.equal(result.status, 0, `python exited ${result.status}: ${result.stderr}`);
}

const dockerImage = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
const R_SKIP =
  dockerImage.status === 0 ? false : `docker image ${IMAGE} is not built: run docker build -t ${IMAGE} harness/analysis/`;

function runR(out: string, code: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "-e",
      "CTC_OUT=/out",
      "-v",
      `${out}:/out`,
      IMAGE,
      "Rscript",
      "-e",
      code,
    ],
    { encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// ---- Python (the reference) ----

test("python rec then save_numbers writes name,value,note with integers bare and 10 significant digits", () => {
  const out = outDir();
  ok(
    runPython(
      out,
      [
        "from ctc import rec, save_numbers",
        'rec("int", 1234)',
        'rec("small", 0.1234567891234, "a note, with a comma")',
        'save_numbers("12_model1")',
      ].join("\n"),
    ),
  );
  assert.equal(readFileSync(path.join(out, "numbers", "12_model1.csv"), "utf8"), NUMBERS_CSV);
});

test("python reg returns the recorded value", () => {
  const out = outDir();
  const result = runPython(
    out,
    ['from ctc import rec, save_numbers, reg', 'rec("small", 0.1234567891234)', 'save_numbers("12_model1")', 'print(reg("12_model1", "small"))'].join("\n"),
  );
  ok(result);
  assert.equal(result.stdout.trim(), "0.1234567891");
});

test("python reg raises on a missing key", () => {
  const out = outDir();
  const result = runPython(out, ['from ctc import rec, save_numbers, reg', 'rec("int", 1)', 'save_numbers("12_model1")', 'reg("12_model1", "nope")'].join("\n"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ValueError: .*"nope".*exactly one/);
});

test("python reg raises on a duplicated key", () => {
  const out = outDir();
  mkdirSync(path.join(out, "numbers"), { recursive: true });
  writeFileSync(path.join(out, "numbers", "12_model1.csv"), "name,value,note\nk,1,\nk,2,\n");
  const result = runPython(out, ["from ctc import reg", 'reg("12_model1", "k")'].join("\n"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ValueError: .*"k".*exactly one/);
});

test("python rec refuses a key recorded twice in one section", () => {
  const out = outDir();
  const result = runPython(out, ["from ctc import rec", 'rec("a", 1)', 'rec("a", 2)'].join("\n"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ValueError/);
});

test("python put_var and write_variables write the yml and the sources csv", () => {
  const out = outDir();
  ok(
    runPython(
      out,
      [
        "from ctc import put_var, write_variables",
        'put_var("m1_or_lspec", 0.401, "12_model1#m1", rendered=".401")',
        'put_var("n_pages", 1234, "01_counts#n")',
        "write_variables()",
      ].join("\n"),
    ),
  );
  assert.equal(readFileSync(path.join(out, "assets", "_variables.yml"), "utf8"), VARIABLES_YML);
  assert.equal(readFileSync(path.join(out, "assets", "variables_sources.csv"), "utf8"), SOURCES_CSV);
});

// ---- R (mirrors the Python helper; needs the image) ----

test("R rec then save_numbers writes the same CSV as Python", { skip: R_SKIP }, () => {
  const out = outDir();
  const result = runR(
    out,
    [
      'source("/opt/ctc/ctc.R")',
      'rec("int", 1234)',
      'rec("small", 0.1234567891234, "a note, with a comma")',
      'save_numbers("12_model1")',
    ].join("; "),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(out, "numbers", "12_model1.csv"), "utf8"), NUMBERS_CSV);
});

test("R reg returns the recorded value", { skip: R_SKIP }, () => {
  const out = outDir();
  const result = runR(
    out,
    [
      'source("/opt/ctc/ctc.R")',
      'rec("small", 0.1234567891234)',
      'save_numbers("12_model1")',
      'cat(sprintf("%.10g", reg("12_model1", "small")))',
    ].join("; "),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "0.1234567891");
});

test("R reg stops on a missing key", { skip: R_SKIP }, () => {
  const out = outDir();
  const result = runR(out, ['source("/opt/ctc/ctc.R")', 'rec("int", 1)', 'save_numbers("12_model1")', 'reg("12_model1", "nope")'].join("; "));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /"nope".*exactly one/);
});

test("R reg stops on a duplicated key", { skip: R_SKIP }, () => {
  const out = outDir();
  mkdirSync(path.join(out, "numbers"), { recursive: true });
  writeFileSync(path.join(out, "numbers", "12_model1.csv"), "name,value,note\nk,1,\nk,2,\n");
  const result = runR(out, ['source("/opt/ctc/ctc.R")', 'reg("12_model1", "k")'].join("; "));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /"k".*exactly one/);
});

test("R rec refuses a key recorded twice in one section", { skip: R_SKIP }, () => {
  const out = outDir();
  const result = runR(out, ['source("/opt/ctc/ctc.R")', 'rec("a", 1)', 'rec("a", 2)'].join("; "));
  assert.notEqual(result.status, 0);
});

test("R put_var and write_variables write the same files as Python", { skip: R_SKIP }, () => {
  const out = outDir();
  const result = runR(
    out,
    [
      'source("/opt/ctc/ctc.R")',
      'put_var("m1_or_lspec", 0.401, "12_model1#m1", rendered=".401")',
      'put_var("n_pages", 1234, "01_counts#n")',
      "write_variables()",
    ].join("; "),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(out, "assets", "_variables.yml"), "utf8"), VARIABLES_YML);
  assert.equal(readFileSync(path.join(out, "assets", "variables_sources.csv"), "utf8"), SOURCES_CSV);
});
