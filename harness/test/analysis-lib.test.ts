// analysis/lib: the registry and assets helpers, in Python (the reference) and R.
// The Python tests run on the host's python3. The R tests run Rscript inside the
// ctc-analysis:1 image with the same flags run_analysis uses, and are skipped,
// with the reason, when that image is absent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const LIB_DIR = fileURLToPath(new URL("../analysis/lib/", import.meta.url));
const ANALYSIS_DIR = fileURLToPath(new URL("../analysis/", import.meta.url));
const IMAGE = "ctc-analysis:1";
/** The container path the helpers write to, as dockerArgs mounts it. */
const CONTAINER_OUT = "/work/output";

/** The expected files, byte for byte, for the same calls in both languages. */
const NUMBERS_CSV = 'name,value,note\nint,1234,\nsmall,0.1234567891,"a note, with a comma"\n';
const VARIABLES_YML = 'm1_or_lspec: ".401"\nn_pages: "1234"\n';
const SOURCES_CSV =
  "variable,value,rendered,source\nm1_or_lspec,0.401,.401,output/numbers/12_model1.csv#m1\nn_pages,1234,1234,output/numbers/01_counts.csv#n\n";

/** The shared fixture: the awkward values and text both helpers must write the same way. */
const FIXTURE_NUMBERS_CSV = [
  "name,value,note",
  "int_key,1234,",
  "neg_half,-0.5,",
  "tiny,1e-07,",
  "huge,100000000000000000000,",
  'note_key,1,"say ""hi"", then',
  'next"',
  "",
].join("\n");
/** rendered holds a backslash, a quote and a newline; the yml escapes them, the csv quotes them. */
const FIXTURE_VARIABLES_YML = [
  'esc_var: "a\\\\b \\"q\\"\\nline"',
  'neg_var: "-0.5"',
  'huge_var: "100000000000000000000"',
  "",
].join("\n");
const FIXTURE_SOURCES_CSV = [
  "variable,value,rendered,source",
  'esc_var,0.5,"a\\b ""q""',
  'line",output/numbers/12_model1.csv#m1',
  "neg_var,-0.5,-0.5,output/numbers/12_model1.csv#neg_half",
  "huge_var,100000000000000000000,100000000000000000000,output/numbers/12_model1.csv#huge",
  "",
].join("\n");

const FIXTURE_PY = [
  "from ctc import rec, put_var, save_numbers, write_variables",
  'rec("int_key", 1234)',
  'rec("neg_half", -0.5)',
  'rec("tiny", 1e-7)',
  'rec("huge", 1e20)',
  "rec(\"note_key\", 1, 'say \"hi\", then\\nnext')",
  'put_var("esc_var", 0.5, "output/numbers/12_model1.csv#m1", rendered=\'a\\\\b "q"\\nline\')',
  'put_var("neg_var", -0.5, "output/numbers/12_model1.csv#neg_half")',
  'put_var("huge_var", 1e20, "output/numbers/12_model1.csv#huge")',
  'save_numbers("12_model1")',
  "write_variables()",
].join("\n");

const FIXTURE_R = [
  'source("/opt/ctc/ctc.R")',
  'rec("int_key", 1234)',
  'rec("neg_half", -0.5)',
  'rec("tiny", 1e-7)',
  'rec("huge", 1e20)',
  'rec("note_key", 1, "say \\"hi\\", then\\nnext")',
  'put_var("esc_var", 0.5, "output/numbers/12_model1.csv#m1", rendered="a\\\\b \\"q\\"\\nline")',
  'put_var("neg_var", -0.5, "output/numbers/12_model1.csv#neg_half")',
  'put_var("huge_var", 1e20, "output/numbers/12_model1.csv#huge")',
  'save_numbers("12_model1")',
  "write_variables()",
].join("; ");

/** A driver that puts the lib dir on sys.path from argv (-I ignores PYTHONPATH). */
const DRIVER =
  "import sys\nsys.dont_write_bytecode = True\nsys.path.insert(0, sys.argv[1])\nexec(sys.stdin.read(), {'__name__': '__main__'})\n";

const driverDir = mkdtempSync(path.join(tmpdir(), "ctc-driver-"));
const driver = path.join(driverDir, "driver.py");
writeFileSync(driver, DRIVER);
process.on("exit", () => rmSync(driverDir, { recursive: true, force: true }));

function outDir(): string {
  return mkdtempSync(path.join(tmpdir(), "ctc-out-"));
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runPython(out: string, code: string): Run {
  const result = spawnSync("python3", ["-I", driver, LIB_DIR], {
    input: code,
    env: { ...process.env, CTC_OUT: out },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function ok(result: Run): void {
  assert.equal(result.status, 0, `python exited ${result.status}: ${result.stderr}`);
}

/** The uid:gid the container runs as, the same as run_analysis gives it. */
function hostUser(): string {
  return `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
}

/** The image's run flags, the same ones dockerArgs passes (minus the scripts and data mounts). */
function imageRunArgs(out?: string): string[] {
  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--user",
    hostUser(),
    "-w",
    "/work",
    "-e",
    `CTC_OUT=${CONTAINER_OUT}`,
  ];
  if (out !== undefined) args.push("-v", `${out}:${CONTAINER_OUT}`);
  return args;
}

const dockerImage = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
const IMAGE_SKIP =
  dockerImage.status === 0 ? false : `docker image ${IMAGE} is not built: run docker build -t ${IMAGE} harness/analysis/`;

function runR(out: string, code: string): Run {
  const result = spawnSync("docker", [...imageRunArgs(out), IMAGE, "Rscript", "-e", code], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The three files the fixture writes, read from one output folder. */
function fixtureFiles(out: string): { numbers: string; variables: string; sources: string } {
  return {
    numbers: readFileSync(path.join(out, "numbers", "12_model1.csv"), "utf8"),
    variables: readFileSync(path.join(out, "assets", "_variables.yml"), "utf8"),
    sources: readFileSync(path.join(out, "assets", "variables_sources.csv"), "utf8"),
  };
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

test("python rec refuses a key recorded twice in one section, with the helper's message", () => {
  const out = outDir();
  const result = runPython(out, ["from ctc import rec", 'rec("a", 1)', 'rec("a", 2)'].join("\n"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ValueError: "a" is already recorded in this section/);
});

const REJECTED_NUMBERS_PY = ["True", '"5"', "None", 'float("nan")', 'float("inf")'];

test("python rec refuses True, the string \"5\", None, NaN and Inf", () => {
  for (const literal of REJECTED_NUMBERS_PY) {
    const result = runPython(outDir(), `from ctc import rec\nrec("k", ${literal})`);
    assert.notEqual(result.status, 0, `rec(${literal}) must be refused`);
    assert.match(result.stderr, /ValueError: .* is not a finite number/, `rec(${literal}) names the refusal`);
  }
});

test("python put_var and write_variables write the yml and the sources csv", () => {
  const out = outDir();
  ok(
    runPython(
      out,
      [
        "from ctc import put_var, write_variables",
        'put_var("m1_or_lspec", 0.401, "output/numbers/12_model1.csv#m1", rendered=".401")',
        'put_var("n_pages", 1234, "output/numbers/01_counts.csv#n")',
        "write_variables()",
      ].join("\n"),
    ),
  );
  assert.equal(readFileSync(path.join(out, "assets", "_variables.yml"), "utf8"), VARIABLES_YML);
  assert.equal(readFileSync(path.join(out, "assets", "variables_sources.csv"), "utf8"), SOURCES_CSV);
});

const BAD_SOURCES = [
  "12_model1#m1",
  "output/numbers/12_model1.csv",
  "output/numbers/12_model1.csv#",
  "output/numbers/a/b.csv#m",
  "output/other/12_model1.csv#m",
  "output/numbers/12_model1.csv#m\n",
];

test("python put_var refuses a source that is not output/numbers/<section>.csv#<key>, naming the form", () => {
  for (const source of BAD_SOURCES) {
    const result = runPython(outDir(), `from ctc import put_var\nput_var("v", 1, ${JSON.stringify(source)})`);
    assert.notEqual(result.status, 0, `source ${JSON.stringify(source)} must be refused`);
    assert.match(result.stderr, /output\/numbers\/<section>\.csv#<key>/, `the refusal names the form for ${JSON.stringify(source)}`);
  }
});

test("python put_var accepts the plan's source form", () => {
  const out = outDir();
  ok(runPython(out, 'from ctc import put_var, write_variables\nput_var("v", 1, "output/numbers/12_model1.csv#m1")\nwrite_variables()'));
});

test("python shared fixture writes the expected bytes", () => {
  const out = outDir();
  ok(runPython(out, FIXTURE_PY));
  const files = fixtureFiles(out);
  assert.equal(files.numbers, FIXTURE_NUMBERS_CSV);
  assert.equal(files.variables, FIXTURE_VARIABLES_YML);
  assert.equal(files.sources, FIXTURE_SOURCES_CSV);
});

// ---- R (mirrors the Python helper; needs the image) ----

test("R rec then save_numbers writes the same CSV as Python", { skip: IMAGE_SKIP }, () => {
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

test("R reg returns the recorded value", { skip: IMAGE_SKIP }, () => {
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

test("R reg stops on a missing key", { skip: IMAGE_SKIP }, () => {
  const out = outDir();
  const result = runR(out, ['source("/opt/ctc/ctc.R")', 'rec("int", 1)', 'save_numbers("12_model1")', 'reg("12_model1", "nope")'].join("; "));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /"nope".*exactly one/);
});

test("R reg stops on a duplicated key", { skip: IMAGE_SKIP }, () => {
  const out = outDir();
  mkdirSync(path.join(out, "numbers"), { recursive: true });
  writeFileSync(path.join(out, "numbers", "12_model1.csv"), "name,value,note\nk,1,\nk,2,\n");
  const result = runR(out, ['source("/opt/ctc/ctc.R")', 'reg("12_model1", "k")'].join("; "));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /"k".*exactly one/);
});

test("R rec refuses a key recorded twice in one section, with the helper's message", { skip: IMAGE_SKIP }, () => {
  const out = outDir();
  const result = runR(out, ['source("/opt/ctc/ctc.R")', 'rec("a", 1)', 'rec("a", 2)'].join("; "));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already recorded in this section/);
});

const REJECTED_NUMBERS_R = ["TRUE", '"5"', "NA", "NaN", "Inf"];

test("R rec refuses TRUE, the string \"5\", NA, NaN and Inf", { skip: IMAGE_SKIP }, () => {
  for (const literal of REJECTED_NUMBERS_R) {
    const result = runR(outDir(), `source("/opt/ctc/ctc.R"); rec("k", ${literal})`);
    assert.notEqual(result.status, 0, `rec(${literal}) must be refused`);
    assert.match(result.stderr, /is not a finite number/, `rec(${literal}) names the refusal`);
  }
});

test("R put_var and write_variables write the same files as Python", { skip: IMAGE_SKIP }, () => {
  const out = outDir();
  const result = runR(
    out,
    [
      'source("/opt/ctc/ctc.R")',
      'put_var("m1_or_lspec", 0.401, "output/numbers/12_model1.csv#m1", rendered=".401")',
      'put_var("n_pages", 1234, "output/numbers/01_counts.csv#n")',
      "write_variables()",
    ].join("; "),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(out, "assets", "_variables.yml"), "utf8"), VARIABLES_YML);
  assert.equal(readFileSync(path.join(out, "assets", "variables_sources.csv"), "utf8"), SOURCES_CSV);
});

test("R put_var refuses a source that is not output/numbers/<section>.csv#<key>, naming the form", { skip: IMAGE_SKIP }, () => {
  for (const source of BAD_SOURCES) {
    const result = runR(outDir(), `source("/opt/ctc/ctc.R"); put_var("v", 1, ${JSON.stringify(source)})`);
    assert.notEqual(result.status, 0, `source ${JSON.stringify(source)} must be refused`);
    assert.match(result.stderr, /output\/numbers\/<section>\.csv#<key>/, `the refusal names the form for ${JSON.stringify(source)}`);
  }
});

test("R and Python write byte-identical files for the shared fixture, matching the expected bytes", { skip: IMAGE_SKIP }, () => {
  const pyOut = outDir();
  ok(runPython(pyOut, FIXTURE_PY));
  const rOut = outDir();
  const result = runR(rOut, FIXTURE_R);
  assert.equal(result.status, 0, result.stderr);

  const py = fixtureFiles(pyOut);
  const r = fixtureFiles(rOut);
  assert.equal(r.numbers, py.numbers, "numbers CSV");
  assert.equal(r.variables, py.variables, "_variables.yml");
  assert.equal(r.sources, py.sources, "variables_sources.csv");
  assert.equal(r.numbers, FIXTURE_NUMBERS_CSV);
  assert.equal(r.variables, FIXTURE_VARIABLES_YML);
  assert.equal(r.sources, FIXTURE_SOURCES_CSV);
});

test("python in the image, under the run flags, imports matplotlib with nothing on stderr", { skip: IMAGE_SKIP }, () => {
  const result = spawnSync("docker", [...imageRunArgs(), IMAGE, "python3", "-c", "import matplotlib.pyplot"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "", "no matplotlib warning about a config or cache directory");
});

// ---- The pins (static) ----

test("the Dockerfile pins the base by tag and digest, and every Python package by ==", () => {
  const dockerfile = readFileSync(path.join(ANALYSIS_DIR, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM rocker\/r-ver:4\.5\.1@sha256:[0-9a-f]{64}$/m);
  assert.match(dockerfile, /pip install --no-cache-dir -r \/tmp\/requirements\.txt/);
  const lines = readFileSync(path.join(ANALYSIS_DIR, "requirements.txt"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const names = ["pandas", "numpy", "scipy", "statsmodels", "scikit-learn", "networkx", "gensim", "matplotlib", "pyarrow"];
  for (const name of names) {
    assert.match(lines.join("\n"), new RegExp(`^${name}==\\d[^\\s]*$`, "m"), `${name} is pinned with ==`);
  }
  assert.equal(lines.length, names.length, "requirements.txt lists exactly the nine packages");
});
