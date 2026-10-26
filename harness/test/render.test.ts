// The Quarto render of a paper (design §8, check 5): the paper image renders `paper.qmd` to HTML and Word with no
// network, the paper's workspace the only writable mount, and the host uid. A render with a WARNING, a missing
// output or a table include that produced no `<table` is a problem. Most tests take a fake Exec (no docker); the
// image-backed tests skip with their reason when ctc-paper:1 is not built.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** A paper with numeric chunk-id citations, as drafted before `submit_paper` finalises them. */
const DRAFT = PAPER.replace("Readers copy.", "Readers copy [@939306] [@961198].");
/** The warnings Quarto prints for numeric chunk ids against an empty bibliography (verified). */
const NUMERIC_WARNINGS = "[WARNING] Citeproc: citation 939306 not found\n[WARNING] Citeproc: citation 961198 not found\n";

/** The files under a folder, relative and sorted, leaving out nothing. */
function filesUnder(dir: string, rel = ""): string[] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? filesUnder(dir, path.join(rel, entry.name)) : [path.join(rel, entry.name)]))
    .sort();
}

/** A set-up paper. `finalised` (the default) writes `references.bib`; a draft has none, as before `submit_paper`. */
function setup(t: import("node:test").TestContext, paper: string = PAPER, finalised = true) {
  const f = paperRun(t, undefined);
  put(path.join(f.paper, "workspace", "paper.qmd"), paper);
  put(path.join(f.paper, "workspace", "embeds", "tables", "T1.qmd"), "| Group | N |\n|---|---|\n| A | 12 |\n");
  if (finalised) put(path.join(f.paper, "workspace", "references.bib"), "");
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
// Draft mode: no references.bib yet, so the render runs on a scratch copy with an empty one.

const SCRATCH = (f: { run: string; paper: string }) => path.join(f.run, ".analysis", "paper-render", path.basename(f.paper));

test("a draft render mounts a scratch copy with an empty references.bib; the real workspace gets only the two outputs", async (t) => {
  const f = setup(t, DRAFT, false);
  const before = filesUnder(path.join(f.paper, "workspace"));
  const inner = fakeQuarto({ write: CLEAN, stdout: NUMERIC_WARNINGS });
  const seen: { folder: string; bib?: string }[] = [];
  const exec: Exec = async (args, opts) => {
    const folder = workOf(args);
    seen.push({ folder, bib: existsSync(path.join(folder, "references.bib")) ? readFileSync(path.join(folder, "references.bib"), "utf8") : undefined });
    return inner.exec(args, opts);
  };
  assert.deepEqual(await renderPaper(f.run, f.paper, exec), { problems: [] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.folder, SCRATCH(f), "the scratch copy is what is mounted");
  assert.equal(seen[0]?.bib, "", "the scratch holds an empty references.bib");
  assert.ok(!existsSync(path.join(f.paper, "workspace", "references.bib")), "the real workspace gets no references.bib");
  assert.deepEqual(filesUnder(path.join(f.paper, "workspace")), [...before, "checks/render/paper.docx", "checks/render/paper.html"].sort());
  assert.equal(readFileSync(path.join(f.paper, "workspace", "checks", "render", "paper.html"), "utf8"), CLEAN["checks/render/paper.html"]);
  assert.equal(readFileSync(path.join(f.paper, "workspace", "checks", "render", "paper.docx"), "utf8"), CLEAN["checks/render/paper.docx"]);
});

test("a draft render passes with the numeric citation warnings, and an old real output does not survive a failed draft", async (t) => {
  const f = setup(t, DRAFT, false);
  put(path.join(f.paper, "workspace", "checks", "render", "paper.html"), "<old/>");
  put(path.join(f.paper, "workspace", "checks", "render", "paper.docx"), "old");
  const failed = await renderPaper(f.run, f.paper, fakeQuarto({ write: { "checks/render/paper.html": "<table><tr><td>A</td></tr></table><p>?@fig-nope</p>", "checks/render/paper.docx": "PK" }, stdout: NUMERIC_WARNINGS }).exec);
  assert.deepEqual(failed.problems, ["workspace/checks/render/paper.html has an unresolved cross-reference: ?@fig-nope"]);
  assert.ok(!existsSync(path.join(f.paper, "workspace", "checks", "render", "paper.html")), "the stale html is gone");
  assert.ok(!existsSync(path.join(f.paper, "workspace", "checks", "render", "paper.docx")), "the stale docx is gone");
  assert.ok(!existsSync(path.join(f.paper, "workspace", "references.bib")));
});

test("a draft with an unresolved cross-reference is still a problem", async (t) => {
  const f = setup(t, DRAFT.replace("Readers copy", "Readers copy @fig-nope"), false);
  const html = "<table><tr><td>A</td></tr></table><p>See ?@fig-nope.</p>";
  const result = await renderPaper(f.run, f.paper, fakeQuarto({ write: { "checks/render/paper.html": html, "checks/render/paper.docx": "PK" }, stdout: NUMERIC_WARNINGS }).exec);
  assert.deepEqual(result.problems, ["workspace/checks/render/paper.html has an unresolved cross-reference: ?@fig-nope"]);
});

test("a draft with a non-numeric unresolved citation is still a problem; the numeric ones beside it are not", async (t) => {
  const f = setup(t, DRAFT.replace("Readers copy", "Readers copy [@nobody2099]"), false);
  const stdout = `${NUMERIC_WARNINGS}[WARNING] Citeproc: citation nobody2099 not found\n`;
  const result = await renderPaper(f.run, f.paper, fakeQuarto({ write: CLEAN, stdout }).exec);
  assert.deepEqual(result.problems, ["workspace/paper.qmd render: [WARNING] Citeproc: citation nobody2099 not found"]);
  assert.ok(!existsSync(path.join(f.paper, "workspace", "checks", "render", "paper.html")), "a draft that fails publishes no html");
});

test("a draft refuses a link in the workspace and runs nothing", async (t) => {
  const f = setup(t, DRAFT, false);
  const outside = path.join(f.run, "outside.txt");
  writeFileSync(outside, "secret");
  symlinkSync(outside, path.join(f.paper, "workspace", "notes.txt"));
  const fake = fakeQuarto({ write: CLEAN, stdout: NUMERIC_WARNINGS });
  const result = await renderPaper(f.run, f.paper, fake.exec);
  assert.equal(fake.calls.length, 0, "no container is run");
  assert.ok(result.problems.some((p) => /notes\.txt is a link/.test(p)), result.problems.join("\n"));
  assert.ok(!existsSync(path.join(f.paper, "workspace", "references.bib")));
});

test("a finalised paper (references.bib present) keeps a numeric citation warning as a problem", async (t) => {
  const f = setup(t, DRAFT, true);
  const result = await renderPaper(f.run, f.paper, fakeQuarto({ write: CLEAN, stdout: NUMERIC_WARNINGS }).exec);
  assert.deepEqual(result.problems, [
    "workspace/paper.qmd render: [WARNING] Citeproc: citation 939306 not found",
    "workspace/paper.qmd render: [WARNING] Citeproc: citation 961198 not found",
  ]);
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

test("the paper image renders a draft with numeric citations and no references.bib, leaving no bibliography behind", { skip: SKIP, timeout: 600_000 }, async (t) => {
  const f = setup(t, DRAFT, false);
  const result = await renderPaper(f.run, f.paper);
  assert.deepEqual(result.problems, []);
  assert.ok(!existsSync(path.join(f.paper, "workspace", "references.bib")), "no references.bib in the real workspace");
  assert.equal(readFileSync(path.join(f.paper, "workspace", "checks", "render", "paper.docx")).subarray(0, 2).toString(), "PK");
  assert.ok(readFileSync(path.join(f.paper, "workspace", "checks", "render", "paper.html"), "utf8").length > 0);
});
