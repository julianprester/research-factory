// The theory diagram (design §5.5): a text spec under workspace/embeds/diagrams/, read by a strict parser,
// drawn to DOT and rendered by Graphviz in the paper image, with a record of what was rendered (diagrams.json)
// that check-paper verifies. Nothing here needs docker: the renderer takes a fake Exec, and the image-backed
// test skips with its reason when ctc-paper:1 is not built.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { Exec } from "../analysis/run.ts";
import { checkDiagram, diagramProblems, parseDiagram, renderDiagram, toDot } from "../paper/diagram.ts";
import { paperRun, put, sha256 } from "./paper-fixture.ts";

const SPEC = [
  "nodes:",
  "  - id: example",
  '    label: "The first example"',
  "    claim: Explanation",
  "  - id: copy",
  "    label: Readers copy it",
  "    claim: Mechanism and scope",
  "edges:",
  "  - from: example",
  "    to: copy",
  "    label: leads to",
  "    claim: Mechanism and scope",
  "",
].join("\n");

const DOT = [
  "digraph diagram {",
  '  node [shape=box, fontname="Helvetica"];',
  '  edge [fontname="Helvetica"];',
  '  "example" [label="The first example\\n[Explanation]"];',
  '  "copy" [label="Readers copy it\\n[Mechanism and scope]"];',
  '  "example" -> "copy" [label="leads to\\n[Mechanism and scope]"];',
  "}",
  "",
].join("\n");

/** A fake docker run: the host folder mounted at /work receives `theory.png` (the bytes given) when `dot` runs. */
function fakeDot(png: string | Buffer | undefined, code = 0, stderr = ""): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (args) => {
    calls.push(args);
    const mount = args[args.indexOf("-v") + 1] ?? "";
    const folder = mount.slice(0, mount.lastIndexOf(":/work"));
    if (png !== undefined && folder !== "") writeFileSync(path.join(folder, "theory.png"), png);
    return { code, stdout: "", stderr, timedOut: false };
  };
  return { exec, calls };
}

// ---------------------------------------------------------------------------
// The spec: a strict parser for exactly the shape the writer may write.

test("parseDiagram reads the nodes and edges of a spec", () => {
  assert.deepEqual(parseDiagram(SPEC), {
    nodes: [
      { id: "example", label: "The first example", claim: "Explanation" },
      { id: "copy", label: "Readers copy it", claim: "Mechanism and scope" },
    ],
    edges: [{ from: "example", to: "copy", label: "leads to", claim: "Mechanism and scope" }],
  });
});

test("parseDiagram takes an edge without a label, quoted or single-quoted values, comments and an empty edge list", () => {
  const spec = [
    "# the theory",
    "nodes:",
    "  - id: a",
    "    label: 'It''s here'",
    '    claim: "Explanation"',
    "  - id: b",
    "    label: Two",
    "    claim: Explanation",
    "edges: []",
    "",
  ].join("\n");
  assert.deepEqual(parseDiagram(spec), {
    nodes: [
      { id: "a", label: "It's here", claim: "Explanation" },
      { id: "b", label: "Two", claim: "Explanation" },
    ],
    edges: [],
  });
  const noLabel = SPEC.replace("    label: leads to\n", "");
  assert.equal(parseDiagram(noLabel)?.edges[0]?.label, undefined);
});

test("parseDiagram refuses anything outside the shape: anchors, tags, flow styles, block scalars, unknown or repeated keys", () => {
  const refused = [
    SPEC.replace('label: "The first example"', "label: &x The first example"),
    SPEC.replace('label: "The first example"', "label: *x"),
    SPEC.replace('label: "The first example"', "label: !!str The first example"),
    SPEC.replace('label: "The first example"', "label: { a: b }"),
    SPEC.replace("  - id: copy", "  - [id, copy]"),
    SPEC.replace('label: "The first example"', "label: |\n      block"),
    SPEC.replace('label: "The first example"', "label: >-\n      folded"),
    SPEC.replace('label: "The first example"', "label: a: b"),
    SPEC.replace('label: "The first example"', "label: a #comment"),
    SPEC.replace('label: "The first example"', 'label: "a\\nb"'),
    SPEC.replace('label: "The first example"', "label: \"unclosed"),
    SPEC.replace("    claim: Explanation\n", "    claim: Explanation\n    shape: box\n"),
    SPEC.replace("    claim: Explanation\n", "    claim: Explanation\n    claim: Explanation\n"),
    SPEC.replace("    claim: Explanation\n", ""),
    SPEC.replace("  - id: example", "  - id: 1example"),
    SPEC.replace("  - id: example", "\t- id: example"),
    `---\n${SPEC}`,
    `${SPEC}...\n`,
    `%YAML 1.2\n${SPEC}`,
    SPEC.replace("nodes:\n", "nodes: [a]\n"),
    "edges:\n  - from: a\n    to: b\n    claim: Explanation\n",
    "nodes: []\n",
    "nodes:\nlabel: x\n",
    "",
  ];
  refused.forEach((spec, index) => assert.equal(parseDiagram(spec), null, `refused case ${index}: ${JSON.stringify(spec)}`));
});

test("toDot writes the exact DOT text for the fixture, with labels escaped and the claim beneath each label", () => {
  assert.equal(toDot(parseDiagram(SPEC)!), DOT);
});

test("toDot escapes quotes and backslashes, and a deterministic text comes from the same spec", () => {
  const spec = SPEC.replace('label: "The first example"', 'label: "Say \\"hi\\" \\\\ now"');
  const dot = toDot(parseDiagram(spec)!);
  assert.match(dot, /"example" \[label="Say \\"hi\\" \\\\ now\\n\[Explanation\]"\];/);
  assert.equal(toDot(parseDiagram(spec)!), dot);
});

// ---------------------------------------------------------------------------
// checkDiagram: the claims, the edges and the ids.

test("checkDiagram is clean for a spec whose claims are the argument's headings", (t) => {
  const f = paperRun(t, SPEC);
  assert.deepEqual(checkDiagram(f.run, f.paper, "theory"), []);
});

test("checkDiagram names a claim the argument lacks, a dangling edge and a duplicate id", (t) => {
  const f = paperRun(t, SPEC);
  const bad = SPEC.replace("    claim: Explanation", "    claim: Not a heading")
    .replace("  - id: copy", "  - id: example")
    .replace("    to: copy", "    to: nowhere");
  put(path.join(f.diagrams, "theory.yml"), bad);
  const problems = checkDiagram(f.run, f.paper, "theory");
  assert.ok(problems.some((p) => /example.*"Not a heading".*not a ## heading/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /edge example -> nowhere.*not a node/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /id example is used twice/.test(p)), problems.join("\n"));
});

test("checkDiagram names a spec that is missing or is not a diagram", (t) => {
  const f = paperRun(t, undefined);
  assert.deepEqual(checkDiagram(f.run, f.paper, "theory"), ["workspace/embeds/diagrams/theory.yml is missing"]);
  put(path.join(f.diagrams, "theory.yml"), "nodes: [a]\n");
  assert.deepEqual(checkDiagram(f.run, f.paper, "theory"), ["workspace/embeds/diagrams/theory.yml is not a diagram spec"]);
});

// ---------------------------------------------------------------------------
// renderDiagram: the DOT, the Graphviz run, the refusals, and the record.

test("renderDiagram writes the DOT, runs dot in a container on the diagrams folder, and records the hashes", async (t) => {
  const f = paperRun(t, SPEC);
  const png = Buffer.from("\x89PNG fake bytes");
  const fake = fakeDot(png);
  const result = await renderDiagram(f.run, f.paper, "theory", fake.exec);
  assert.equal(result.png, path.join(f.diagrams, "theory.png"));
  assert.equal(readFileSync(path.join(f.diagrams, "theory.dot"), "utf8"), DOT);
  assert.deepEqual(readFileSync(result.png), png);
  const argv = fake.calls[0] ?? [];
  assert.deepEqual(argv.slice(argv.indexOf("ctc-paper:1") + 1), ["dot", "-Tpng", "-o", "theory.png", "theory.dot"]);
  assert.equal(fake.calls.length, 1);
  const record = JSON.parse(readFileSync(path.join(f.diagrams, "diagrams.json"), "utf8")) as Record<string, Record<string, string>>;
  assert.deepEqual(record.theory, { png: sha256(png), spec: sha256(SPEC), dot: sha256(DOT) });
  assert.deepEqual(diagramProblems(f.paper), []);
});

test("renderDiagram refuses a spec that does not check, and runs nothing", async (t) => {
  const f = paperRun(t, SPEC);
  put(path.join(f.diagrams, "theory.yml"), SPEC.replace("    claim: Explanation", "    claim: Missing"));
  const fake = fakeDot(Buffer.from("x"));
  await assert.rejects(renderDiagram(f.run, f.paper, "theory", fake.exec), /Missing/);
  assert.equal(fake.calls.length, 0);
  await assert.rejects(renderDiagram(f.run, f.paper, "../theory", fake.exec), /not a diagram name/);
});

test("renderDiagram throws when dot fails or writes no PNG, and records nothing", async (t) => {
  const f = paperRun(t, SPEC);
  await assert.rejects(renderDiagram(f.run, f.paper, "theory", fakeDot(undefined, 1, "Error: bad\n").exec), /dot failed \(exit 1\)/);
  await assert.rejects(renderDiagram(f.run, f.paper, "theory", fakeDot(undefined).exec), /dot wrote no theory\.png/);
  assert.equal(diagramProblems(f.paper).length, 0, "no PNG, no record: nothing to check");
});

test("renderDiagram refuses a symlinked workspace and runs nothing", async (t) => {
  const f = paperRun(t, SPEC);
  const moved = path.join(f.run, "moved-workspace");
  renameSync(path.join(f.paper, "workspace"), moved);
  symlinkSync(moved, path.join(f.paper, "workspace"));
  const fake = fakeDot(Buffer.from("x"));
  await assert.rejects(renderDiagram(f.run, f.paper, "theory", fake.exec), /is a link/);
  assert.equal(fake.calls.length, 0, "no container is run");
});

test("renderDiagram refuses a link where the diagrams folder belongs", async (t) => {
  const f = paperRun(t, SPEC);
  const elsewhere = mkdtempSync(path.join(tmpdir(), "ctc-diagram-link-"));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  rmSync(f.diagrams, { recursive: true, force: true });
  symlinkSync(elsewhere, f.diagrams);
  await assert.rejects(renderDiagram(f.run, f.paper, "theory", fakeDot(Buffer.from("x")).exec), /is a link/);
});

// ---------------------------------------------------------------------------
// diagramProblems: a PNG is a rendering of the spec it names, and a spec edited after rendering makes it stale.

test("diagramProblems passes a diagram that was rendered, and names a hand-made or an edited PNG", async (t) => {
  const f = paperRun(t, SPEC);
  await renderDiagram(f.run, f.paper, "theory", fakeDot(Buffer.from("rendered")).exec);
  assert.deepEqual(diagramProblems(f.paper), []);
  put(path.join(f.diagrams, "theory.png"), "edited by hand");
  assert.deepEqual(diagramProblems(f.paper), [
    "workspace/embeds/diagrams/theory.png was not made by render_diagram (its sha256 differs from diagrams.json)",
  ]);
});

test("diagramProblems names a PNG when diagrams.json is missing", (t) => {
  const f = paperRun(t, SPEC);
  put(path.join(f.diagrams, "other.png"), "a png");
  assert.deepEqual(diagramProblems(f.paper), [
    "workspace/embeds/diagrams/diagrams.json is missing (diagrams were not rendered by render_diagram)",
  ]);
});

test("a spec edited after rendering makes its PNG stale", async (t) => {
  const f = paperRun(t, SPEC);
  await renderDiagram(f.run, f.paper, "theory", fakeDot(Buffer.from("rendered")).exec);
  put(path.join(f.diagrams, "theory.yml"), SPEC.replace("leads to", "causes"));
  assert.deepEqual(diagramProblems(f.paper), ["diagram theory is stale: render_diagram again"]);
});

test("a diagrams.json that is a link, is garbage, or is missing its entry fails closed", async (t) => {
  const f = paperRun(t, SPEC);
  await renderDiagram(f.run, f.paper, "theory", fakeDot(Buffer.from("rendered")).exec);
  const json = path.join(f.diagrams, "diagrams.json");
  writeFileSync(json, "{ not json");
  assert.ok(diagramProblems(f.paper).some((p) => /diagrams\.json is unreadable/.test(p)), diagramProblems(f.paper).join("\n"));
  writeFileSync(json, JSON.stringify({ other: { png: "x", spec: "y", dot: "z" } }));
  assert.ok(diagramProblems(f.paper).some((p) => /theory\.png is not recorded/.test(p)), diagramProblems(f.paper).join("\n"));
  rmSync(json);
  symlinkSync(path.join(f.run, "config.json"), json);
  assert.ok(diagramProblems(f.paper).some((p) => /diagrams\.json cannot be read: .*link/.test(p) || /is a link/.test(p)), diagramProblems(f.paper).join("\n"));
});

// ---------------------------------------------------------------------------
// The image-backed test: a two-node diagram to a PNG with the real Graphviz.

const IMAGE_PRESENT = spawnSync("docker", ["image", "inspect", "ctc-paper:1"], { encoding: "utf8" }).status === 0;

test(
  "the paper image draws a two-node diagram to a PNG",
  { skip: IMAGE_PRESENT ? false : "docker image ctc-paper:1 is not built (docker build -t ctc-paper:1 harness/paper/)", timeout: 300_000 },
  async (t) => {
    const f = paperRun(t, SPEC);
    const { png } = await renderDiagram(f.run, f.paper, "theory");
    const bytes = readFileSync(png);
    assert.deepEqual([...bytes.subarray(1, 4)], [0x50, 0x4e, 0x47], "the file is a PNG");
    assert.deepEqual(diagramProblems(f.paper), []);
  },
);
