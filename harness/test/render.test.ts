// The Quarto render of a paper (design §8, check 5): the paper image renders `paper.qmd` to HTML and Word with no
// network, the paper's workspace the only writable mount, and the host uid. A render with a WARNING, a missing
// output or a table include that produced no `<table` is a problem. Most tests take a fake Exec (no docker); the
// image-backed tests skip with their reason when ctc-paper:1 is not built.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { Exec } from "../analysis/run.ts";
import { paperDockerArgs, renderPaper } from "../paper/render.ts";
import { paperRun, put } from "./paper-fixture.ts";
import { fileURLToPath } from "node:url";

const TEMPLATES = fileURLToPath(new URL("../templates/", import.meta.url));
const TABLE_INCLUDE = "{{< include embeds/tables/T1.qmd >}}";
const PAPER = ["---", 'title: "Etiquette"', "bibliography: references.bib", "---", "", "# Findings", "", "Readers copy.", "", TABLE_INCLUDE, ""].join("\n");

/** The host folder mounted at /work in an argv, or "" when none is. */
function workOf(args: string[]): string {
  const mount = args[args.indexOf("-v") + 1] ?? "";
  return mount.endsWith(":/work") ? mount.slice(0, -":/work".length) : "";
}

interface Fake {
  stdout?: string;
  stderr?: string;
  code?: number;
  timedOut?: boolean;
  /** What the render writes under checks/render (relative to the workspace), when given. */
  write?: Record<string, string>;
}

function fakeQuarto(fake: Fake): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (args) => {
    calls.push(args);
    const folder = workOf(args);
    for (const [rel, text] of Object.entries(fake.write ?? {})) put(path.join(folder, rel), text);
    return { code: fake.code ?? 0, stdout: fake.stdout ?? "", stderr: fake.stderr ?? "", timedOut: fake.timedOut ?? false };
  };
  return { exec, calls };
}

/** The html and docx a clean render writes, with one table in the HTML for the one table include. */
const CLEAN = { "checks/render/paper.html": "<html><table><tr><td>A</td></tr></table></html>", "checks/render/paper.docx": "PK docx" };

function setup(t: import("node:test").TestContext, paper: string = PAPER) {
  const f = paperRun(t, undefined);
  put(path.join(f.paper, "workspace", "paper.qmd"), paper);
  put(path.join(f.paper, "workspace", "embeds", "tables", "T1.qmd"), "| Group | N |\n|---|---|\n| A | 12 |\n");
  put(path.join(f.paper, "workspace", "references.bib"), "");
  put(path.join(f.paper, "workspace", "_quarto.yml"), readFileSync(path.join(TEMPLATES, "_quarto.yml")));
  put(path.join(f.paper, "workspace", "apa.csl"), readFileSync(path.join(TEMPLATES, "apa.csl")));
  return f;
}

// ---------------------------------------------------------------------------
// paperDockerArgs: the hardening, without docker.

test("paperDockerArgs runs with no network, a read-only root, tmpfs /tmp, the host uid and one writable mount", () => {
  const args = paperDockerArgs({ image: "ctc-paper:1", folder: "/run/W01/workspace", command: ["dot", "-V"], uid: 1000, gid: 1001 });
  assert.deepEqual(args, [
    "run",
    "--rm",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--user",
    "1000:1001",
    "-v",
    "/run/W01/workspace:/work",
    "-w",
    "/work",
    "ctc-paper:1",
    "dot",
    "-V",
  ]);
  assert.equal(args.filter((arg) => arg === "-v").length, 1, "exactly one mount");
});

test("paperDockerArgs refuses a relative folder, an empty command and an empty image", () => {
  assert.throws(() => paperDockerArgs({ image: "ctc-paper:1", folder: "relative", command: ["dot"], uid: 1, gid: 1 }), /absolute/);
  assert.throws(() => paperDockerArgs({ image: "ctc-paper:1", folder: "/x", command: [], uid: 1, gid: 1 }), /command/);
  assert.throws(() => paperDockerArgs({ image: "", folder: "/x", command: ["dot"], uid: 1, gid: 1 }), /image/);
});

// ---------------------------------------------------------------------------
// renderPaper with a fake Exec.

test("renderPaper runs quarto in the paper's workspace and passes a clean render", async (t) => {
  const f = setup(t);
  const fake = fakeQuarto({ write: CLEAN });
  assert.deepEqual(await renderPaper(f.run, f.paper, fake.exec), { problems: [] });
  const argv = fake.calls[0] ?? [];
  assert.equal(workOf(argv), path.join(f.paper, "workspace"));
  assert.deepEqual(argv.slice(argv.indexOf("ctc-paper:1") + 1), ["quarto", "render", "paper.qmd", "--output-dir", "checks/render"]);
  assert.ok(argv.includes("--network") && argv.includes("--read-only"));
});

test("renderPaper turns each WARNING line of the render into a problem", async (t) => {
  const f = setup(t);
  const stdout = "pandoc\n[WARNING] Citeproc: citation 1 not found\nOutput created: checks/render/paper.html\n";
  const result = await renderPaper(f.run, f.paper, fakeQuarto({ write: CLEAN, stdout }).exec);
  assert.deepEqual(result.problems, ["workspace/paper.qmd render: [WARNING] Citeproc: citation 1 not found"]);
});

test("renderPaper names a missing docx and a missing html", async (t) => {
  const f = setup(t);
  const onlyHtml = await renderPaper(f.run, f.paper, fakeQuarto({ write: { "checks/render/paper.html": "<table></table>" } }).exec);
  assert.deepEqual(onlyHtml.problems, ["workspace/checks/render/paper.docx is missing"]);
  const onlyDocx = await renderPaper(f.run, f.paper, fakeQuarto({ write: { "checks/render/paper.docx": "PK" } }).exec);
  assert.deepEqual(onlyDocx.problems, ["workspace/checks/render/paper.html is missing"]);
});

test("renderPaper names a table include that produced no <table in the HTML", async (t) => {
  const f = setup(t);
  const result = await renderPaper(
    f.run,
    f.paper,
    fakeQuarto({ write: { "checks/render/paper.html": "<p>Readers copy.</p>", "checks/render/paper.docx": "PK" } }).exec,
  );
  assert.deepEqual(result.problems, ["workspace/paper.qmd has 1 table include but the HTML has 0 <table elements"]);
});

test("renderPaper names a non-zero exit and a timeout", async (t) => {
  const f = setup(t);
  const failed = await renderPaper(f.run, f.paper, fakeQuarto({ code: 1, stderr: "ERROR: bad yaml\n", write: CLEAN }).exec);
  assert.ok(failed.problems.some((p) => /quarto render failed \(exit 1\).*bad yaml/.test(p)), failed.problems.join("\n"));
  const timed = await renderPaper(f.run, f.paper, fakeQuarto({ code: 124, timedOut: true }).exec);
  assert.ok(timed.problems.some((p) => /timed out/.test(p)), timed.problems.join("\n"));
});

test("renderPaper removes an earlier render first, so an old docx cannot pass a new failed render", async (t) => {
  const f = setup(t);
  put(path.join(f.paper, "workspace", "checks", "render", "paper.docx"), "old");
  const result = await renderPaper(f.run, f.paper, fakeQuarto({ write: { "checks/render/paper.html": "<table></table>" } }).exec);
  assert.deepEqual(result.problems, ["workspace/checks/render/paper.docx is missing"]);
});

test("renderPaper refuses a link where the render folder belongs, and runs nothing", async (t) => {
  const f = setup(t);
  const elsewhere = path.join(f.run, "elsewhere");
  mkdirSync(elsewhere);
  mkdirSync(path.join(f.paper, "workspace", "checks"), { recursive: true });
  symlinkSync(elsewhere, path.join(f.paper, "workspace", "checks", "render"));
  const fake = fakeQuarto({ write: CLEAN });
  const result = await renderPaper(f.run, f.paper, fake.exec);
  assert.equal(fake.calls.length, 0);
  assert.ok(result.problems.some((p) => /checks\/render is a link/.test(p)), result.problems.join("\n"));
});

test("renderPaper strips ANSI colour codes from a WARNING line", async (t) => {
  const f = setup(t);
  const stdout = "\u001b[33m[WARNING]\u001b[39m Citeproc: citation x not found\n";
  const result = await renderPaper(f.run, f.paper, fakeQuarto({ write: CLEAN, stdout }).exec);
  assert.deepEqual(result.problems, ["workspace/paper.qmd render: [WARNING] Citeproc: citation x not found"]);
});

test("renderPaper names an unresolved cross-reference Quarto printed as ?@fig-nope, with no WARNING", async (t) => {
  const f = setup(t);
  const html = "<table><tr><td>A</td></tr></table><p>See ?@fig-nope.</p>";
  const result = await renderPaper(f.run, f.paper, fakeQuarto({ write: { "checks/render/paper.html": html, "checks/render/paper.docx": "PK" } }).exec);
  assert.deepEqual(result.problems, ["workspace/checks/render/paper.html has an unresolved cross-reference: ?@fig-nope"]);
});

test("renderPaper refuses a symlinked workspace and runs nothing", async (t) => {
  const f = setup(t);
  const moved = path.join(f.run, "moved-workspace");
  renameSync(path.join(f.paper, "workspace"), moved);
  symlinkSync(moved, path.join(f.paper, "workspace"));
  const fake = fakeQuarto({ write: CLEAN });
  const result = await renderPaper(f.run, f.paper, fake.exec);
  assert.equal(fake.calls.length, 0, "no container is run");
  assert.ok(result.problems.some((p) => /workspace is a link/.test(p)), result.problems.join("\n"));
});

test("renderPaper reports a missing config and a missing paper without throwing", async (t) => {
  const f = setup(t);
  rmSync(path.join(f.run, "config.json"));
  const noConfig = await renderPaper(f.run, f.paper, fakeQuarto({ write: CLEAN }).exec);
  assert.ok(noConfig.problems.some((p) => /config\.json/.test(p)), noConfig.problems.join("\n"));
  rmSync(path.join(f.paper, "workspace", "paper.qmd"));
  assert.deepEqual(await renderPaper(f.run, f.paper, fakeQuarto({ write: CLEAN }).exec), { problems: [] }, "no paper, nothing rendered");
});

// ---------------------------------------------------------------------------
// The image-backed tests: the real Quarto in ctc-paper:1.

const IMAGE_PRESENT = spawnSync("docker", ["image", "inspect", "ctc-paper:1"], { encoding: "utf8" }).status === 0;
const SKIP = IMAGE_PRESENT ? false : "docker image ctc-paper:1 is not built (docker build -t ctc-paper:1 harness/paper/)";

test("the paper image renders a one-paragraph paper with a table to HTML and DOCX, with no problems", { skip: SKIP, timeout: 600_000 }, async (t) => {
  const f = setup(t);
  const result = await renderPaper(f.run, f.paper);
  assert.deepEqual(result.problems, []);
  const html = readFileSync(path.join(f.paper, "workspace", "checks", "render", "paper.html"), "utf8");
  assert.ok((html.match(/<table/g) ?? []).length >= 1, "the table include renders");
  assert.equal(readFileSync(path.join(f.paper, "workspace", "checks", "render", "paper.docx")).subarray(0, 2).toString(), "PK");
});

test("the paper image renders an include that stands in a text line as nothing, and that is a problem", { skip: SKIP, timeout: 600_000 }, async (t) => {
  const f = setup(t, PAPER.replace(TABLE_INCLUDE, `Text ${TABLE_INCLUDE} more.`));
  const result = await renderPaper(f.run, f.paper);
  assert.ok(result.problems.some((p) => /1 table include but the HTML has 0 <table elements/.test(p)), result.problems.join("\n"));
});

test("the paper image flags an unresolved cross-reference it renders as ?@label", { skip: SKIP, timeout: 600_000 }, async (t) => {
  const f = setup(t, PAPER.replace("Readers copy.", "Readers copy, see @fig-nope."));
  const result = await renderPaper(f.run, f.paper);
  assert.ok(result.problems.some((p) => /unresolved cross-reference: \?@fig-nope/.test(p)), result.problems.join("\n"));
});

test("a render that changes or adds a file the checks read is a problem", async (t) => {
  const f = setup(t);
  put(path.join(f.paper, "workspace", "checks", "pins.json"), "{}\n");
  const inner = fakeQuarto({ write: CLEAN }).exec;
  const tampering: Exec = async (args, opts) => {
    const result = await inner(args, opts);
    put(path.join(workOf(args), "checks", "pins.json"), '{"argumentSha":"forged"}\n');
    put(path.join(workOf(args), "extra.txt"), "added");
    return result;
  };
  const result = await renderPaper(f.run, f.paper, tampering);
  assert.deepEqual(result.problems.sort(), [
    "workspace/checks/pins.json was changed by the render",
    "workspace/extra.txt was added by the render",
  ]);
});
