// The paper's project: the scaffold `init_paper` writes, the pins that tie it to its explanation, the `deepis bib`
// finalisation of its citations, and the re-pin a reopen needs (design §4, §5.6, §9; plan Task 10).
//
// `initPaper` copies what the paper reads from the explanation (its `_variables.yml` and `variables_sources.csv`,
// its table fragments and figures) and the harness templates (`apa.csl`, `_quarto.yml`), writes the Predictions
// fragment, a skeleton `paper.qmd`, `outline.md`, the pins and the generated audit index. Every source is read
// without following a link, and all of them are read before anything is written, so a refusal writes nothing. Every
// file it would create that already exists is kept: a second call changes nothing that exists.
//
// `finalizeBib` runs `deepis bib paper.qmd` in the paper's workspace and checks what it did: each numeric chunk id is
// rewritten to a key, every key the paper cites is in `references.bib`, and the embeds (variables, includes, images,
// quotes) are unchanged. A rewrite that changes an embed is undone (the manuscript is restored byte for byte).
//
// `repinPaper` is the writer's second step after a reopen: once the outline has been revised and the Predictions are
// as they were pinned, the generated copies are refreshed from the explanation and the pins take its current argument
// and reproduction hashes.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { argumentSha, locate, readRegular, readRounds, readReopens, writeAtomic } from "../explain/rounds.ts";
import { parseReport } from "../tools/check-argument.ts";
import { nodeIdOf, findNode } from "../tree.ts";
import { sectionText } from "../tools/check-argument.ts";
import { bibKeys, embedSetDiff, scanEmbeds, type EmbedSet } from "./embeds.ts";

/** The harness templates every paper carries a copy of. */
const TEMPLATE_DIR = fileURLToPath(new URL("../templates/", import.meta.url));
const TEMPLATES = ["apa.csl", "_quarto.yml"];
const AUTHOR_PLACEHOLDER = "Author names to be added";
const TITLE_PLACEHOLDER = "Title to be added";
/** The genre's sections (dpkw's structure, design §7.2), in order. */
const SECTIONS = [
  "# Introduction",
  "# Conceptual Background",
  "# Research Method",
  "# Findings",
  "# Theory Development",
  "## What the held-back split could contradict",
  "{{< include embeds/predictions.qmd >}}",
  "# Discussion",
  "# Conclusion",
  "# Appendix",
  "# References {.unnumbered}",
];
const DEEPIS_TIMEOUT_MS = 300_000;
const NUMERIC_ID = /^\d+$/;

/** One file the scaffold writes: its path under `workspace/` and its bytes. */
interface Planned {
  rel: string;
  bytes: Buffer;
}

export interface PaperNode {
  runDir: string;
  paper: string;
  explanation: string;
  explanationId: string;
  paperId: string;
}

/** The paper node at `paperDir` under its explanation in `runDir`; a path that is not one is an error. */
export function paperNodeOf(runDir: string, paperDir: string): PaperNode {
  const paper = path.resolve(paperDir);
  const explanation = path.dirname(path.dirname(paper));
  const explanationId = nodeIdOf(explanation);
  const paperId = nodeIdOf(paper);
  if (explanationId === undefined || !explanationId.startsWith("E") || path.basename(path.dirname(paper)) !== "papers") {
    throw new Error(`${paperDir} is not a paper under an explanation (expected <explanation>/papers/<paper>)`);
  }
  if (paperId === undefined || !paperId.startsWith("W")) throw new Error(`${paperDir} is not a paper node (expected W<nn>-<slug>)`);
  return { runDir: path.resolve(runDir), paper, explanation, explanationId, paperId };
}

const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** A required regular file of the explanation, read without following a link. */
function explanationFile(node: PaperNode, rel: string): Buffer {
  const bytes = readRegular(node.explanation, rel);
  if (bytes === undefined) throw new Error(`the explanation's ${rel} is missing`);
  return bytes;
}

/** The explanation's workspace hash, from its reproduction record (`owners/phase-3/loop/<E>/reproduction.json`). */
function reproductionHash(node: PaperNode): string {
  const rel = `owners/phase-3/loop/${node.explanationId}/reproduction.json`;
  const bytes = readRegular(node.runDir, rel);
  if (bytes === undefined) throw new Error(`${rel} is missing: the explanation has not been reproduced`);
  let record: unknown;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${rel} is not valid JSON`);
  }
  const hash = typeof record === "object" && record !== null ? (record as { workspaceHash?: unknown }).workspaceHash : undefined;
  if (typeof hash !== "string") throw new Error(`${rel} has no workspaceHash`);
  return hash;
}

/** The explanation's Predictions section, as the paper pins it: `sectionText` of its argument. */
function predictionsOf(node: PaperNode): string {
  return sectionText(explanationFile(node, "workspace/argument.md").toString("utf8"), "Predictions");
}

/** The regular files of a folder of the explanation, by name, with the names `keep` accepts; a link is refused by name. */
function folderFiles(node: PaperNode, folder: string, keep: (name: string) => boolean): { name: string; bytes: Buffer }[] {
  const found = locate(node.explanation, folder);
  if (found.kind === "absent") return [];
  if (found.kind === "refused") throw new Error(found.problem);
  if (found.kind === "file") throw new Error(`${folder} is not a folder`);
  const out: { name: string; bytes: Buffer }[] = [];
  for (const entry of fs.readdirSync(path.join(node.explanation, ...folder.split("/")), { withFileTypes: true })) {
    const rel = `${folder}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`${rel} is a link: refusing to copy it`);
    if (!entry.isFile() || !keep(entry.name)) continue;
    const bytes = readRegular(node.explanation, rel);
    if (bytes !== undefined) out.push({ name: entry.name, bytes });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The author names from `<run>/authors.yml`: one per line, an optional `- ` and quotes; none when the file is absent.
 * A linked or unreadable file gives no names and a warning: the placeholder is used, and the caller shows the warning.
 */
function authorsOf(runDir: string): { names: string[]; warning?: string } {
  try {
    if (fs.lstatSync(path.join(runDir, "authors.yml"), { throwIfNoEntry: false })?.isSymbolicLink()) {
      return { names: [], warning: "authors.yml is a link: using the placeholder" };
    }
    const bytes = readRegular(runDir, "authors.yml");
    if (bytes === undefined) return { names: [] };
    const names = bytes
      .toString("utf8")
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^-\s+/, "").replace(/^(["'])(.*)\1$/, "$2").trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    return { names };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { names: [], warning: `authors.yml cannot be read (${message}): using the placeholder` };
  }
}

/** The front matter and the sections of the skeleton `paper.qmd`. */
function skeleton(authors: string[]): string {
  const names = authors.length === 0 ? [AUTHOR_PLACEHOLDER] : authors;
  return [
    "---",
    `title: "${TITLE_PLACEHOLDER}"`,
    "author:",
    ...names.map((name) => `  - ${JSON.stringify(name)}`),
    "bibliography: references.bib",
    "csl: apa.csl",
    "---",
    "",
    ...SECTIONS.flatMap((line) => [line, ""]),
    "::: {#refs}",
    ":::",
    "",
  ].join("\n");
}

const OUTLINE = ["# Outline", "", "## Sections", "", "## Omitted", "", "## Needs", ""].join("\n");

/**
 * The audit index: a generated list of the explanation's rounds (one line each: the changed flag, the reopen, the stop),
 * its kept scripts, its archived scripts with their reasons, and the review findings by id and severity. No prose.
 */
function auditIndex(node: PaperNode): string {
  const lines = ["# Audit index", "", "## Rounds", ""];
  const rounds = readRounds(node.runDir, node.explanationId);
  for (const round of rounds) {
    lines.push(
      `- round ${String(round.round).padStart(2, "0")} | changed: ${round.changed ? "yes" : "no"} | reopen: ${round.reopen ?? 0} | stop: ${round.stop ?? "none"}`,
    );
  }
  if (rounds.length === 0) lines.push("- none");

  lines.push("", "## Kept scripts", "");
  const scripts = folderFiles(node, "workspace/scripts", (name) => !name.startsWith("."));
  lines.push(...(scripts.length === 0 ? ["- none"] : scripts.map((script) => `- scripts/${script.name}`)));

  lines.push("", "## Archived scripts", "");
  const archived = archiveEntries(node);
  lines.push(...(archived.length === 0 ? ["- none"] : archived));

  lines.push("", "## Review findings", "");
  const report = readRegular(node.explanation, "workspace/reviews/report.md");
  if (report === undefined) throw new Error("the explanation's workspace/reviews/report.md is missing");
  const parsed = parseReport(report.toString("utf8"));
  if (parsed === null) throw new Error("the explanation's workspace/reviews/report.md is malformed");
  lines.push(...(parsed.findings.length === 0 ? ["- none"] : parsed.findings.map((finding) => `- ${finding.id} [${finding.severity}]`)));
  return `${lines.join("\n")}\n`;
}

/** One line per archived script folder: its README's reason, read without following a link. */
function archiveEntries(node: PaperNode): string[] {
  const found = locate(node.explanation, "workspace/archive");
  if (found.kind === "absent") return [];
  if (found.kind === "refused") throw new Error(found.problem);
  if (found.kind === "file") throw new Error("workspace/archive is not a folder");
  const entries: string[] = [];
  for (const entry of fs.readdirSync(path.join(node.explanation, "workspace", "archive"), { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) throw new Error(`workspace/archive/${entry.name} is a link: refusing to read it`);
    if (!entry.isDirectory()) continue;
    const readme = readRegular(node.explanation, `workspace/archive/${entry.name}/README.md`);
    const reason = readme?.toString("utf8").split(/\r?\n/).find((line) => line.startsWith("Reason: "));
    entries.push(`- archive/${entry.name}: ${reason === undefined ? "no README reason" : reason.slice("Reason: ".length).trim()}`);
  }
  return entries;
}

/** The pins as `init_paper` writes them. */
function pinsOf(node: PaperNode): string {
  const pins = {
    argumentSha: argumentSha(node.explanation),
    workspaceHash: reproductionHash(node),
    predictionsSha: sha256(predictionsOf(node)),
    reopens: readReopens(node.runDir, node.explanationId).length,
    outlineShaAtReopen: null,
  };
  return `${JSON.stringify(pins, null, 2)}\n`;
}

/**
 * The explanation's generated copies in the paper: `_variables.yml` and `variables_sources.csv` (paths under
 * `workspace/`), the table fragments (`output/assets/*.qmd`) and the figures (`output/figures/*`). Every source is read
 * here, without following a link, so a refusal is raised before anything is written.
 */
function copiesOf(node: PaperNode): { assets: Planned[]; tables: Planned[]; figures: Planned[] } {
  const assets = ["_variables.yml", "variables_sources.csv"].map((name) => ({
    rel: name,
    bytes: explanationFile(node, `workspace/output/assets/${name}`),
  }));
  const tables = folderFiles(node, "workspace/output/assets", (name) => name.endsWith(".qmd")).map((file) => ({
    rel: `embeds/tables/${file.name}`,
    bytes: file.bytes,
  }));
  const figures = folderFiles(node, "workspace/output/figures", () => true).map((file) => ({
    rel: `embeds/figures/${file.name}`,
    bytes: file.bytes,
  }));
  return { assets, tables, figures };
}

/**
 * The names in a generated copy folder of the paper (`workspace/embeds/tables`, say). A link, a file where the folder
 * belongs, or an entry that is not a regular file is refused by name, so nothing outside the copies is ever removed.
 */
function copyNames(paper: string, folder: string): string[] {
  const found = locate(paper, folder);
  if (found.kind === "absent") return [];
  if (found.kind === "refused") throw new Error(found.problem);
  if (found.kind === "file") throw new Error(`${folder} is not a folder`);
  return fs.readdirSync(path.join(paper, ...folder.split("/")), { withFileTypes: true }).map((entry) => {
    if (entry.isSymbolicLink()) throw new Error(`${folder}/${entry.name} is a link: refusing to use it`);
    if (!entry.isFile()) throw new Error(`${folder}/${entry.name} is not a regular file`);
    return entry.name;
  });
}

/**
 * Scaffolds the paper node `paperDir` (a `W<nn>` node under an explanation in phase 4). Creates what does not exist;
 * refuses (and writes nothing) when a source is missing, linked or unreadable. Returns a summary line, and a warning
 * line when `authors.yml` is linked or unreadable (the placeholder is used).
 */
export function initPaper(runDir: string, paperDir: string): string {
  const node = paperNodeOf(runDir, paperDir);
  const state = findNode(node.runDir, node.explanationId);
  if (state.phase !== 4) {
    throw new Error(`${node.explanationId} is in phase ${state.phase}, not phase 4: a paper is initialised for an explanation handed on to Phase 4`);
  }

  const argument = explanationFile(node, "workspace/argument.md");
  const predictions = sectionText(argument.toString("utf8"), "Predictions");
  if (predictions === "") throw new Error(`${node.explanationId}'s argument has an empty ## Predictions section`);

  // Every source is read before anything is written.
  const copies = copiesOf(node);
  const planned: Planned[] = [...copies.assets];
  for (const name of TEMPLATES) planned.push({ rel: name, bytes: fs.readFileSync(path.join(TEMPLATE_DIR, name)) });
  planned.push(...copies.tables, ...copies.figures);
  planned.push({ rel: "embeds/predictions.qmd", bytes: Buffer.from(`${predictions}\n`, "utf8") });
  const authors = authorsOf(node.runDir);
  planned.push({ rel: "paper.qmd", bytes: Buffer.from(skeleton(authors.names), "utf8") });
  planned.push({ rel: "outline.md", bytes: Buffer.from(OUTLINE, "utf8") });
  planned.push({ rel: "checks/pins.json", bytes: Buffer.from(pinsOf(node), "utf8") });
  planned.push({ rel: "audit/index.md", bytes: Buffer.from(auditIndex(node), "utf8") });

  let created = 0;
  let kept = 0;
  for (const file of planned) {
    const found = locate(node.paper, `workspace/${file.rel}`);
    if (found.kind === "refused") throw new Error(found.problem);
    if (found.kind !== "absent") {
      kept++;
      continue;
    }
    writeAtomic(path.join(node.paper, "workspace", ...file.rel.split("/")), file.bytes);
    created++;
  }
  const summary = [`${node.paperId} under ${node.explanationId}: created ${created} file(s), kept ${kept}`];
  if (authors.warning !== undefined) summary.push(`warning: ${authors.warning}`);
  return summary.join("\n");
}

/** The default runner: `deepis` in the paper's workspace, so `paper.qmd` is rewritten in place and `references.bib` written beside it. */
function deepisIn(workspace: string): (args: string[]) => { code: number; stderr: string } {
  return (args) => {
    const result = spawnSync("deepis", args, { cwd: workspace, encoding: "utf8", timeout: DEEPIS_TIMEOUT_MS });
    if (result.error !== undefined) return { code: 2, stderr: result.error.message };
    return { code: result.status ?? 2, stderr: result.stderr ?? "" };
  };
}

/**
 * Runs `deepis bib paper.qmd` on the paper (or `exec`, for tests) and returns what is wrong with the result: a failed
 * run; a numeric chunk id still cited; a cited key missing from `references.bib`; an embed (variable, include, image,
 * quote) changed, or a different number of citations. An embed change restores the manuscript and removes a bib the
 * run created. An empty list means the finalisation is sound.
 */
export function finalizeBib(
  runDir: string,
  paperDir: string,
  exec?: (args: string[]) => { code: number; stderr: string },
): string[] {
  const node = paperNodeOf(runDir, paperDir);
  const workspace = path.join(node.paper, "workspace");
  const before = readRegular(node.paper, "workspace/paper.qmd");
  if (before === undefined) return ["workspace/paper.qmd is missing"];
  const hadBib = locate(node.paper, "workspace/references.bib").kind !== "absent";
  const beforeEmbeds = scanEmbeds(before.toString("utf8"));

  const run = exec ?? deepisIn(workspace);
  let result: { code: number; stderr: string };
  try {
    result = run(["bib", "paper.qmd"]);
  } catch (error) {
    return [`deepis bib paper.qmd could not run: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (result.code !== 0) {
    return [`deepis bib paper.qmd failed (exit ${result.code}): ${result.stderr.trim().split(/\r?\n/)[0] ?? ""}`.trimEnd()];
  }

  const after = readRegular(node.paper, "workspace/paper.qmd");
  if (after === undefined) return ["workspace/paper.qmd is missing after deepis bib"];
  const afterEmbeds = scanEmbeds(after.toString("utf8"));
  const problems: string[] = [];

  const changed = embedSetDiff({ ...beforeEmbeds, citations: [] }, { ...afterEmbeds, citations: [] });
  if (changed.length > 0) {
    problems.push(...changed.map((line) => `deepis bib changed an embed: ${line}`));
    undo(node, before, hadBib);
    return problems;
  }
  if (beforeEmbeds.citations.length !== afterEmbeds.citations.length) {
    problems.push(
      `deepis bib changed the number of citations: ${beforeEmbeds.citations.length} before, ${afterEmbeds.citations.length} after`,
    );
  }

  const afterKeys = new Set(afterEmbeds.citations);
  for (const id of new Set(beforeEmbeds.citations.filter((key) => NUMERIC_ID.test(key)))) {
    if (afterKeys.has(id)) problems.push(`chunk id @${id} is still cited (not rewritten to a key)`);
  }

  const bib = readRegular(node.paper, "workspace/references.bib");
  if (bib === undefined) {
    problems.push("workspace/references.bib is missing after deepis bib");
  }
  const keys = bib === undefined ? new Set<string>() : bibKeys(bib.toString("utf8"));
  for (const key of [...new Set(afterEmbeds.citations)].sort()) {
    if (!keys.has(key) && !NUMERIC_ID.test(key)) problems.push(`citation @${key} is not in references.bib`);
  }
  return problems;
}

/** Restores the manuscript to its bytes before `deepis bib`, and removes a `references.bib` the run created. */
function undo(node: PaperNode, before: Buffer, hadBib: boolean): void {
  writeAtomic(path.join(node.paper, "workspace", "paper.qmd"), before);
  if (!hadBib) fs.rmSync(path.join(node.paper, "workspace", "references.bib"), { force: true });
}

/**
 * Re-pins a paper after its explanation came back from a reopen to phase 4 `ready`. Refuses unless the outline changed
 * since the reopen (`outlineShaAtReopen`), and unless the explanation's Predictions are the pinned ones. Then refreshes
 * the generated copies (`_variables.yml`, `variables_sources.csv`, `embeds/tables`, `embeds/figures`,
 * `embeds/predictions.qmd`) byte for byte from the explanation, removing the copies it no longer has, and writes the
 * pins with the explanation's current argument and reproduction hashes, the reopen count, and no reopen pinned. The
 * manuscript, outline, audit, bibliography and quote and diagram embeds are not touched.
 */
export function repinPaper(runDir: string, paperDir: string): string {
  const node = paperNodeOf(runDir, paperDir);
  const state = findNode(node.runDir, node.explanationId);
  if (state.phase !== 4 || state.status !== "ready") {
    throw new Error(`${node.explanationId} is ${state.status} in phase ${state.phase}, not phase 4 ready`);
  }
  const pinsBytes = readRegular(node.paper, "workspace/checks/pins.json");
  if (pinsBytes === undefined) throw new Error("workspace/checks/pins.json is missing (run init_paper)");
  let pins: { predictionsSha?: unknown; outlineShaAtReopen?: unknown };
  try {
    pins = JSON.parse(pinsBytes.toString("utf8")) as typeof pins;
  } catch {
    throw new Error("workspace/checks/pins.json is unreadable");
  }
  const outline = readRegular(node.paper, "workspace/outline.md");
  if (outline === undefined) throw new Error("workspace/outline.md is missing");
  if (typeof pins.outlineShaAtReopen !== "string") {
    throw new Error("no reopen is pinned: the explanation has not been reopened from this paper");
  }
  if (sha256(outline) === pins.outlineShaAtReopen) {
    throw new Error("workspace/outline.md has not changed since the reopen: revise the outline for the changed parts first");
  }
  if (sha256(predictionsOf(node)) !== pins.predictionsSha) {
    throw new Error("the explanation's Predictions changed since the paper was pinned: refused");
  }
  // Everything is read, and every copy folder checked, before anything is written.
  const copies = copiesOf(node);
  const predictions: Planned = { rel: "embeds/predictions.qmd", bytes: Buffer.from(`${predictionsOf(node)}\n`, "utf8") };
  const wanted = [...copies.assets, ...copies.tables, ...copies.figures, predictions];
  const keep = new Set(wanted.map((file) => file.rel));
  const stale = ["embeds/tables", "embeds/figures"].flatMap((folder) =>
    copyNames(node.paper, `workspace/${folder}`)
      .map((name) => `${folder}/${name}`)
      .filter((rel) => !keep.has(rel)),
  );
  for (const file of wanted) writeAtomic(path.join(node.paper, "workspace", ...file.rel.split("/")), file.bytes);
  for (const rel of stale) fs.rmSync(path.join(node.paper, "workspace", ...rel.split("/")), { force: true });

  const repinned = pinsOf(node);
  writeAtomic(path.join(node.paper, "workspace", "checks", "pins.json"), repinned);
  const next = JSON.parse(repinned) as { argumentSha: string; workspaceHash: string; reopens: number };
  return `${node.paperId} repinned to ${node.explanationId}: argument ${next.argumentSha.slice(0, 7)}, reproduction ${next.workspaceHash}, reopens ${next.reopens}`;
}
