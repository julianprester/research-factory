// The theory diagram of a paper (design §5.5): a text spec the writer writes at `workspace/embeds/diagrams/<name>.yml`,
// read by a strict parser, drawn to DOT, and rendered to a PNG by Graphviz in the paper image. Each box and arrow names
// the `## Heading` of the explanation's `argument.md` that it states, so the diagram is traceable to the argument.
//
// The spec's shape is exactly this, and nothing else is read (no anchors, tags, flow collections, block scalars, or
// multi-document markers):
//
//   nodes:
//     - id: example
//       label: "The first example"
//       claim: Explanation
//   edges:
//     - from: example
//       to: example
//       label: leads to        (optional)
//       claim: Explanation
//
// `renderDiagram` writes `<name>.dot` and runs `dot -Tpng` in the paper image, with the diagrams folder the only writable
// mount. The container can write the folder, so the spec and the DOT are checked again after the run. The rendering is
// then recorded in `diagrams.json` (the sha256 of the PNG, the spec and the DOT), atomically. `diagramProblems` checks that
// record: a PNG with no matching record, a PNG whose bytes changed, or a spec edited after its rendering (a stale PNG).
// A link, or an unreadable or garbage record, is a problem too: the check fails closed.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { realExec, type Exec } from "../analysis/run.ts";
import { locate, readRegular, writeAtomic } from "../explain/rounds.ts";
import { readConfig } from "../launch.ts";
import { isPaperNode } from "../guard.ts";
import { hostIds, message, paperDockerArgs, realFolder } from "./render.ts";

export interface DiagramNode {
  id: string;
  label: string;
  claim: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  claim: string;
}

export interface Diagram {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

/** The folder, relative to the paper node, where the specs, DOT, PNGs and the record live. */
export const DIAGRAMS = "workspace/embeds/diagrams";
const RECORD = "diagrams.json";
const DIAGRAM_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const NODE_ID = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const NODE_KEYS = ["id", "label", "claim"];
const EDGE_KEYS = ["from", "to", "label", "claim"];
const SECTION = /^(nodes|edges):(?: \[\])?$/;
const ITEM = /^ {2}- ([a-z]+): (.*)$/;
const FIELD = /^ {4}([a-z]+): (.*)$/;

/** Thrown inside the parser: the spec is refused, and `parseDiagram` returns null. */
class Refused extends Error {}

/** A plain scalar: a letter or digit first, no `: ` or ` #` inside, no flow brackets, no tab. */
function plainScalar(text: string): string {
  const value = text.trimEnd();
  if (!/^[\p{L}\p{N}]/u.test(value)) throw new Refused(`plain value "${value}" must start with a letter or digit`);
  if (/[\t[\]{}]/.test(value) || /:(?: |$)/.test(value) || / #/.test(value)) {
    throw new Refused(`plain value "${value}" has a character only quoted values may hold`);
  }
  return value;
}

/** One scalar value: a plain one, a double-quoted one (only `\\` and `\"` escaped), or a single-quoted one (`''`). */
function scalar(text: string): string {
  if (text.startsWith('"')) {
    const match = /^"((?:[^"\\]|\\[\\"])*)"$/.exec(text);
    if (match === null) throw new Refused(`double-quoted value ${text} is not closed on its line, or uses an escape other than \\\\ and \\"`);
    return (match[1] ?? "").replace(/\\(["\\])/g, "$1");
  }
  if (text.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'$/.exec(text);
    if (match === null) throw new Refused(`single-quoted value ${text} is not closed on its line`);
    return (match[1] ?? "").replace(/''/g, "'");
  }
  return plainScalar(text);
}

/** The mapping of one item: each field once, only the keys its list allows, and every required one present. */
function itemOf(lines: string[][], keys: string[], required: string[], where: string): Record<string, string> {
  const item: Record<string, string> = {};
  for (const [key, raw] of lines) {
    if (key === undefined || raw === undefined) continue;
    if (!keys.includes(key)) throw new Refused(`${where} has an unknown key ${key}`);
    if (key in item) throw new Refused(`${where} repeats ${key}`);
    const value = scalar(raw);
    if (value.trim() === "") throw new Refused(`${where} ${key} is empty`);
    item[key] = value;
  }
  for (const key of required) if (!(key in item)) throw new Refused(`${where} has no ${key}`);
  return item;
}

/**
 * The diagram a spec holds, or null when the spec is anything but the shape above. `nodes` is required and holds at
 * least one node; `edges` may be absent or empty. Ids are letters, digits and `_`, starting with a letter. Duplicate ids
 * and dangling edges are not a parse error: `checkDiagram` names them.
 */
export function parseDiagram(yaml: string): Diagram | null {
  try {
    return parseOrThrow(yaml);
  } catch {
    return null;
  }
}

function parseOrThrow(yaml: string): Diagram {
  if (yaml.includes("\t")) throw new Refused("a spec has no tabs");
  const sections: Record<string, string[][][]> = {};
  let current: string | undefined;
  let item: string[][] | undefined;
  const lines = yaml.replace(/\r\n?/g, "\n").split("\n");
  for (const line of lines) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const section = SECTION.exec(line);
    if (section !== null) {
      current = section[1] ?? "";
      if (current in sections) throw new Refused(`${current} is listed twice`);
      sections[current] = [];
      item = undefined;
      if (line.endsWith("[]")) current = `${current}:empty`;
      continue;
    }
    if (current === undefined || current.endsWith(":empty")) {
      if (line.startsWith(" ") && current !== undefined) throw new Refused(`${line.trim()} is not in a list`);
      if (current === undefined) throw new Refused(`${line} is outside nodes or edges`);
      continue;
    }
    const start = ITEM.exec(line);
    if (start !== null) {
      item = [[start[1] ?? "", start[2] ?? ""]];
      sections[current]?.push(item);
      continue;
    }
    const field = FIELD.exec(line);
    if (field !== null && item !== undefined) {
      item.push([field[1] ?? "", field[2] ?? ""]);
      continue;
    }
    throw new Refused(`line "${line}" is not part of the shape`);
  }
  const nodeItems = sections.nodes ?? [];
  if (!("nodes" in sections) || nodeItems.length === 0) throw new Refused("a spec has at least one node");
  const nodes = nodeItems.map((fields) => {
    const node = itemOf(fields, NODE_KEYS, NODE_KEYS, "a node");
    if (!NODE_ID.test(node.id ?? "")) throw new Refused(`node id ${node.id} must be letters, digits and _, starting with a letter`);
    return { id: node.id ?? "", label: node.label ?? "", claim: node.claim ?? "" };
  });
  const edges = (sections.edges ?? []).map((fields) => {
    const edge = itemOf(fields, EDGE_KEYS, ["from", "to", "claim"], "an edge");
    for (const end of [edge.from, edge.to]) {
      if (!NODE_ID.test(end ?? "")) throw new Refused(`edge end ${end} must be a node id`);
    }
    const out: DiagramEdge = { from: edge.from ?? "", to: edge.to ?? "", claim: edge.claim ?? "" };
    if (edge.label !== undefined) out.label = edge.label;
    return out;
  });
  return { nodes, edges };
}

/** A DOT quoted string: backslashes and quotes escaped, a newline written as DOT's `\n` line break. */
function dotText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");
}

/**
 * The DOT of a diagram, deterministic: nodes and edges in the spec's order, ids quoted, and each label followed by its
 * claim in brackets on the next line, so the diagram carries the argument heading it states.
 */
export function toDot(d: Diagram): string {
  const lines = ["digraph diagram {", '  node [shape=box, fontname="Helvetica"];', '  edge [fontname="Helvetica"];'];
  for (const node of d.nodes) {
    lines.push(`  "${node.id}" [label="${dotText(`${node.label}\n[${node.claim}]`)}"];`);
  }
  for (const edge of d.edges) {
    const label = edge.label === undefined ? "" : `${edge.label}\n`;
    lines.push(`  "${edge.from}" -> "${edge.to}" [label="${dotText(`${label}[${edge.claim}]`)}"];`);
  }
  lines.push("}", "");
  return lines.join("\n");
}

/** The `## Heading` lines of an argument, fenced code left out, each heading's text trimmed. */
function argumentHeadings(markdown: string): Set<string> {
  const headings = new Set<string>();
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(?:`{3}|~{3})/.test(line)) fenced = !fenced;
    const match = /^## (.+?)\s*$/.exec(line);
    if (!fenced && match !== null) headings.add(match[1] ?? "");
  }
  return headings;
}

/** The read of one text file under the paper, or the problem that stops it (a link, a folder, unreadable). */
function readText(paper: string, rel: string): { text?: string; problem?: string } {
  try {
    const bytes = readRegular(paper, rel);
    return bytes === undefined ? {} : { text: bytes.toString("utf8") };
  } catch (error) {
    return { problem: message(error) };
  }
}

/**
 * The problems of a diagram's spec against the explanation's argument: a spec that is missing or not the shape, a claim
 * that is not a `## Heading` of the argument, an edge whose end is not a node, and a duplicate node id.
 */
export function checkDiagram(runDir: string, nodeDir: string, name: string): string[] {
  void runDir;
  const paper = path.resolve(nodeDir);
  if (!DIAGRAM_NAME.test(name)) return [`"${name}" is not a diagram name`];
  const rel = `${DIAGRAMS}/${name}.yml`;
  const spec = readText(paper, rel);
  if (spec.problem !== undefined) return [spec.problem];
  if (spec.text === undefined) return [`${rel} is missing`];
  const diagram = parseDiagram(spec.text);
  if (diagram === null) return [`${rel} is not a diagram spec`];
  const argument = readText(path.dirname(path.dirname(paper)), "workspace/argument.md");
  if (argument.problem !== undefined) return [argument.problem];
  if (argument.text === undefined) return ["the explanation's workspace/argument.md is missing"];
  const headings = argumentHeadings(argument.text);

  const problems: string[] = [];
  const seen = new Set<string>();
  for (const node of diagram.nodes) {
    if (seen.has(node.id)) problems.push(`${rel}: id ${node.id} is used twice`);
    seen.add(node.id);
    if (!headings.has(node.claim)) problems.push(`${rel}: node ${node.id} claims "${node.claim}", which is not a ## heading of the argument`);
  }
  const ids = new Set(diagram.nodes.map((node) => node.id));
  for (const edge of diagram.edges) {
    for (const end of [edge.from, edge.to]) {
      if (!ids.has(end)) problems.push(`${rel}: edge ${edge.from} -> ${edge.to} has ${end}, which is not a node`);
    }
    if (!headings.has(edge.claim)) problems.push(`${rel}: edge ${edge.from} -> ${edge.to} claims "${edge.claim}", which is not a ## heading of the argument`);
  }
  return problems;
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The record of renderings: each name's sha256s, or none when there is no record yet. Throws for a link or an unreadable file. */
function recordOf(paper: string): Record<string, Record<string, string>> {
  const bytes = readRegular(paper, `${DIAGRAMS}/${RECORD}`);
  if (bytes === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${DIAGRAMS}/${RECORD} is unreadable: not JSON`);
  }
  const ok =
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).png === "string" &&
        typeof (entry as Record<string, unknown>).spec === "string" &&
        typeof (entry as Record<string, unknown>).dot === "string",
    );
  if (!ok) throw new Error(`${DIAGRAMS}/${RECORD} is unreadable: not a diagram record`);
  return value as Record<string, Record<string, string>>;
}

/**
 * The problems of the diagrams folder against its record: each PNG is recorded with its sha256 and its spec's sha256
 * still matches (else the PNG is stale), each recorded diagram has its PNG, and a link or an unreadable folder or
 * record is a problem. A folder with no PNG and no record has no problems (nothing was rendered yet).
 */
export function diagramProblems(nodeDir: string): string[] {
  const paper = path.resolve(nodeDir);
  const found = locate(paper, DIAGRAMS);
  if (found.kind === "refused") return [found.problem];
  if (found.kind === "file") return [`${DIAGRAMS} is not a folder`];
  if (found.kind === "absent") return [];

  const folder = path.join(paper, ...DIAGRAMS.split("/"));
  const problems: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch (error) {
    return [`${DIAGRAMS} cannot be listed: ${message(error)}`];
  }
  const pngs: string[] = [];
  for (const entry of entries) {
    const shown = `${DIAGRAMS}/${entry.name}`;
    if (entry.isSymbolicLink()) problems.push(`${shown} is a link: refusing to use it`);
    else if (entry.name.endsWith(".png") && entry.isFile()) pngs.push(entry.name.slice(0, -".png".length));
    else if (entry.name.endsWith(".png")) problems.push(`${shown} is not a regular file`);
  }

  let record: Record<string, Record<string, string>>;
  try {
    record = recordOf(paper);
  } catch (error) {
    problems.push(message(error));
    record = {};
  }
  const recordFile = fs.existsSync(path.join(folder, RECORD));
  if (pngs.length > 0 && !recordFile) {
    problems.push(`${DIAGRAMS}/${RECORD} is missing (diagrams were not rendered by render_diagram)`);
  }
  for (const name of pngs.sort()) {
    const rec = record[name];
    if (rec === undefined) {
      if (recordFile) problems.push(`${DIAGRAMS}/${name}.png is not recorded in diagrams.json: render_diagram it`);
      continue;
    }
    try {
      const bytes = readRegular(paper, `${DIAGRAMS}/${name}.png`);
      if (bytes === undefined || sha256(bytes) !== rec.png) {
        problems.push(`${DIAGRAMS}/${name}.png was not made by render_diagram (its sha256 differs from diagrams.json)`);
      }
    } catch (error) {
      problems.push(message(error));
    }
    const spec = readRegular(paper, `${DIAGRAMS}/${name}.yml`);
    if (spec === undefined) problems.push(`diagram ${name} has no spec (${DIAGRAMS}/${name}.yml)`);
    else if (sha256(spec) !== rec.spec) problems.push(`diagram ${name} is stale: render_diagram again`);
  }
  for (const name of Object.keys(record)) {
    if (!pngs.includes(name)) problems.push(`diagram ${name} is recorded in diagrams.json but its PNG is missing`);
  }
  return problems;
}

/**
 * Renders `<name>.yml` of the paper at `nodeDir` to `<name>.png`: checks the spec, writes `<name>.dot`, runs `dot -Tpng`
 * in the paper image, checks the spec and the DOT were not changed by the run, and records the sha256s. Throws when the
 * spec does not check, when dot fails or writes nothing, and for a link where the folder belongs. Nothing is recorded
 * when it throws.
 */
export async function renderDiagram(runDir: string, nodeDir: string, name: string, exec?: Exec): Promise<{ png: string }> {
  const paper = path.resolve(nodeDir);
  if (!isPaperNode(paper)) throw new Error(`${nodeDir} is not a paper node`);
  if (!DIAGRAM_NAME.test(name)) throw new Error(`"${name}" is not a diagram name: letters, digits, - and _`);
  const specRel = `${DIAGRAMS}/${name}.yml`;
  const specBytes = readRegular(paper, specRel);
  if (specBytes === undefined) throw new Error(`${specRel} is missing: write the spec first`);
  if (!realFolder(paper, "workspace/embeds")) fs.mkdirSync(path.join(paper, "workspace", "embeds"));
  if (!realFolder(paper, DIAGRAMS)) fs.mkdirSync(path.join(paper, ...DIAGRAMS.split("/")));

  const problems = checkDiagram(runDir, paper, name);
  if (problems.length > 0) throw new Error(`diagram ${name} does not check:\n${problems.join("\n")}`);
  const diagram = parseDiagram(specBytes.toString("utf8"));
  if (diagram === null) throw new Error(`${specRel} is not a diagram spec`);
  const dot = toDot(diagram);

  const folder = path.join(paper, ...DIAGRAMS.split("/"));
  const dotRel = `${DIAGRAMS}/${name}.dot`;
  const pngRel = `${DIAGRAMS}/${name}.png`;
  writeAtomic(path.join(paper, ...dotRel.split("/")), dot);
  fs.rmSync(path.join(paper, ...pngRel.split("/")), { force: true });

  const config = readConfig(runDir);
  const result = await (exec ?? realExec)(
    paperDockerArgs({ image: config.paperImage, folder, command: ["dot", "-Tpng", "-o", `${name}.png`, `${name}.dot`], ...hostIds() }),
    { timeoutMs: config.paperTimeoutMs },
  );
  if (result.timedOut) throw new Error(`dot timed out after ${config.paperTimeoutMs} ms`);
  if (result.code !== 0) {
    const reason = (result.stderr || result.stdout).trim().split(/\r?\n/).at(-1) ?? "";
    throw new Error(`dot failed (exit ${result.code})${reason === "" ? "" : `: ${reason}`}`);
  }

  // The container could write this folder: what it rendered must be the spec and DOT that were checked.
  const specAfter = readRegular(paper, specRel);
  const dotAfter = readRegular(paper, dotRel);
  if (specAfter === undefined || !specAfter.equals(specBytes) || dotAfter === undefined || !dotAfter.equals(Buffer.from(dot))) {
    throw new Error(`${name}: the render changed the spec or the DOT; nothing is recorded`);
  }
  const png = readRegular(paper, pngRel);
  if (png === undefined || png.length === 0) throw new Error(`dot wrote no ${name}.png`);

  const current = recordOf(paper);
  current[name] = { png: sha256(png), spec: sha256(specBytes), dot: sha256(dot) };
  writeAtomic(path.join(folder, RECORD), `${JSON.stringify(current, null, 2)}\n`);
  return { png: path.join(folder, `${name}.png`) };
}
