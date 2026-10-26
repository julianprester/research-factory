// The Quarto render of a paper (design §8, code check 5): `renderPaper` renders `workspace/paper.qmd` to HTML and
// Word in the paper image, and says what is wrong with the result. The container has no network, a read-only root
// and `/tmp` as tmpfs; the paper's `workspace/` is its only writable mount, at /work, and it runs as the host uid.
//
// Quarto 1.9 keeps only the last `--to`, so the formats come from the paper's `_quarto.yml` (the harness template
// lists html and docx) and the command has no `--to`. Quarto writes its project state under `workspace/.quarto`;
// that is removed after the run. The render cannot be trusted with the files the checks read, so the workspace is
// snapshotted before and after: a file the render changed or added is a problem (the outputs under checks/render
// are the render's own). An earlier render's outputs are removed first, so an old docx cannot pass a failed render.
//
// The problems: a WARNING line of the render's output (a citation not found, an empty include); a non-zero exit or
// a timeout (the container is killed by name, as `runScript` does); a missing or empty html or docx; and a table
// include whose HTML holds fewer `<table` elements than the paper has table includes. The count is a floor: a
// hand-typed table would hide a missing one, so the shortfall is the only claim made. Nothing here throws: a failure
// is a problem line.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { realExec, type Exec } from "../analysis/run.ts";
import { locate, readRegular } from "../explain/rounds.ts";
import { readConfig } from "../launch.ts";
import { scanEmbeds } from "./embeds.ts";

/** The paper's workspace, relative to the paper node. */
export const WORKSPACE = "workspace";
/** Where the render writes its html and docx, relative to the workspace. */
export const RENDER_DIR = "checks/render";
/** Terminal colour codes Quarto may print in a WARNING line. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** A cross-reference Quarto could not resolve: printed as `?@` and a label. */
const UNRESOLVED_REFERENCE = /\?@[\p{L}\p{N}_-]+/gu;

export interface PaperDockerOptions {
  image: string;
  /** Absolute host folder, mounted read-write at /work: the only writable mount. */
  folder: string;
  /** The command in the image, for example `["quarto", "render", "paper.qmd"]`. */
  command: string[];
  uid: number;
  gid: number;
}

/**
 * The `docker run` argv of one command in the paper image (everything after `docker`). Pure: nothing here touches
 * the disk or docker. No network, a read-only root, `/tmp` as tmpfs, the host uid, and one writable mount.
 */
export function paperDockerArgs(o: PaperDockerOptions): string[] {
  if (!path.isAbsolute(o.folder)) throw new Error(`${o.folder} must be an absolute folder`);
  if (o.image === "") throw new Error("the paper image must be named");
  if (o.command.length === 0) throw new Error("a paper container needs a command");
  return [
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
    `${o.uid}:${o.gid}`,
    "-v",
    `${o.folder}:/work`,
    "-w",
    "/work",
    o.image,
    ...o.command,
  ];
}

/** The host uid and gid the container runs as, so its output stays the harness user's. */
export function hostIds(): { uid: number; gid: number } {
  return { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 };
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether `rel` under `node` is a real folder (true), absent (false). A link, or a file where a folder belongs,
 * throws with the path that is wrong, so nothing is created or removed through it.
 */
export function realFolder(node: string, rel: string): boolean {
  const found = locate(node, rel);
  if (found.kind === "refused") throw new Error(found.problem);
  if (found.kind === "file") throw new Error(`${rel} is not a folder`);
  return found.kind === "folder";
}

/** The last non-blank line of a text, or "" for none. */
function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.at(-1)?.trim() ?? "";
}

/** The sha256 of each regular file under the workspace (links and folders by kind), leaving out the render's own folders. */
function snapshot(workspace: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const shown = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (shown === RENDER_DIR || shown === ".quarto") continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) out.set(shown, "link");
      else if (entry.isDirectory()) {
        out.set(shown, "folder");
        walk(full, shown);
      } else if (entry.isFile()) out.set(shown, createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
      else out.set(shown, "other");
    }
  };
  walk(workspace, "");
  return out;
}

/** The problems of a snapshot taken before a run against one taken after it. */
function changedBy(before: Map<string, string>, after: Map<string, string>): string[] {
  const problems: string[] = [];
  for (const [shown, sum] of before) {
    if (after.get(shown) !== sum) problems.push(`${WORKSPACE}/${shown} was changed by the render`);
  }
  for (const shown of after.keys()) {
    if (!before.has(shown)) problems.push(`${WORKSPACE}/${shown} was added by the render`);
  }
  return problems;
}

/** The problems of a finished render's output: its warnings, its exit, and the html and docx it should have written. */
function outputProblems(
  node: string,
  result: { code: number; stdout: string; stderr: string; timedOut: boolean },
  timeoutMs: number,
): string[] {
  const problems: string[] = [];
  if (result.timedOut) problems.push(`quarto render timed out after ${timeoutMs} ms`);
  else if (result.code !== 0) {
    const reason = lastLine(result.stderr) || lastLine(result.stdout);
    problems.push(`quarto render failed (exit ${result.code})${reason === "" ? "" : `: ${reason}`}`);
  }
  const warnings = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.replace(ANSI, "").trim())
    .filter((line) => /\bWARNING\b/.test(line));
  for (const warning of new Set(warnings)) problems.push(`${WORKSPACE}/paper.qmd render: ${warning}`);

  const html = fileOutput(node, `${RENDER_DIR}/paper.html`, problems);
  fileOutput(node, `${RENDER_DIR}/paper.docx`, problems);
  if (html !== undefined) problems.push(...crossReferenceProblems(html));
  return problems.concat(tableProblems(node, html));
}

/** An unresolved cross-reference: Quarto prints `@fig-x` it cannot resolve as `?@fig-x`, with no WARNING. */
function crossReferenceProblems(html: Buffer): string[] {
  const hits = new Set(html.toString("utf8").match(UNRESOLVED_REFERENCE) ?? []);
  return [...hits].map((hit) => `${WORKSPACE}/${RENDER_DIR}/paper.html has an unresolved cross-reference: ${hit}`);
}

/** The bytes of one render output, or nothing (a problem is added for a missing, empty or refused one). */
function fileOutput(node: string, rel: string, problems: string[]): Buffer | undefined {
  try {
    const bytes = readRegular(path.join(node, WORKSPACE), rel);
    if (bytes === undefined) problems.push(`${WORKSPACE}/${rel} is missing`);
    else if (bytes.length === 0) problems.push(`${WORKSPACE}/${rel} is empty`);
    else return bytes;
  } catch (error) {
    problems.push(message(error));
  }
  return undefined;
}

/** A shortfall: the paper has more table includes than the HTML has `<table` elements. Nothing is said without the HTML. */
function tableProblems(node: string, html: Buffer | undefined): string[] {
  if (html === undefined) return [];
  const qmd = readRegular(node, `${WORKSPACE}/paper.qmd`)?.toString("utf8") ?? "";
  const tables = scanEmbeds(qmd).includes.filter((target) => target.startsWith("embeds/tables/")).length;
  const elements = (html.toString("utf8").match(/<table[\s>]/g) ?? []).length;
  if (tables <= elements) return [];
  const plural = tables === 1 ? "" : "s";
  return [`${WORKSPACE}/paper.qmd has ${tables} table include${plural} but the HTML has ${elements} <table elements`];
}

/**
 * Renders the paper at `nodeDir` in the paper image and returns its problems. A paper with no `paper.qmd` has none to
 * render (the gate names the missing file). Never throws: a refusal or a failure is a problem.
 */
export async function renderPaper(runDir: string, nodeDir: string, exec?: Exec): Promise<{ problems: string[] }> {
  try {
    return { problems: await renderProblems(runDir, nodeDir, exec) };
  } catch (error) {
    return { problems: [message(error)] };
  }
}

async function renderProblems(runDir: string, nodeDir: string, exec: Exec | undefined): Promise<string[]> {
  const node = path.resolve(nodeDir);
  // The workspace is the container's mount source: it must be a real folder (not a link) before anything is read or run through it.
  if (!realFolder(node, WORKSPACE)) return [`${WORKSPACE} is missing`];
  const manuscript = locate(path.join(node, WORKSPACE), "paper.qmd");
  if (manuscript.kind === "refused") return [manuscript.problem];
  if (manuscript.kind !== "file") return [];

  const config = readConfig(runDir);
  const workspace = path.join(node, WORKSPACE);
  realFolder(workspace, "checks");
  if (realFolder(workspace, RENDER_DIR)) fs.rmSync(path.join(workspace, ...RENDER_DIR.split("/")), { recursive: true, force: true });
  fs.mkdirSync(path.join(workspace, ...RENDER_DIR.split("/")), { recursive: true });
  realFolder(workspace, RENDER_DIR);

  const before = snapshot(workspace);
  const ids = hostIds();
  const result = await (exec ?? realExec)(
    paperDockerArgs({
      image: config.paperImage,
      folder: workspace,
      command: ["quarto", "render", "paper.qmd", "--output-dir", RENDER_DIR],
      ...ids,
    }),
    { timeoutMs: config.paperTimeoutMs },
  );
  // The mount source is checked again after the run: the container could have replaced it with a link.
  if (!realFolder(node, WORKSPACE)) return [`${WORKSPACE} was replaced by a link during the render: nothing is trusted`];
  // Quarto's project state is not part of the paper; it is removed, and a link there is simply not followed.
  if (realFolder(workspace, ".quarto")) fs.rmSync(path.join(workspace, ".quarto"), { recursive: true, force: true });
  const problems = changedBy(before, snapshot(workspace));
  problems.push(...outputProblems(node, result, config.paperTimeoutMs));
  return problems;
}
