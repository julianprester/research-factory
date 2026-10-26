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
// A draft (no `workspace/references.bib` yet: `submit_paper` writes it) cannot render in place, because Quarto fails on
// the front matter's bibliography. So the render runs on a scratch copy under `.analysis/paper-render/<node>/` with an
// empty `references.bib`; numeric chunk-id citations then warn "citation <digits> not found", which is ignored (the
// check-citations pass has verified them). The real workspace receives only the two outputs, and only when the draft renders clean.
//
// The problems: a WARNING line of the render's output (a citation not found, an empty include); a non-zero exit or
// a timeout (the container is killed by name, as `runScript` does); a missing or empty html or docx; and a table
// include whose HTML holds fewer `<table` elements than the paper has table includes. The count is a floor: a
// hand-typed table would hide a missing one, so the shortfall is the only claim made. Nothing here throws: a failure
// is a problem line.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { ignoreScratch, realExec, type Exec } from "../analysis/run.ts";
import { locate, readRegular, writeAtomic } from "../explain/rounds.ts";
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
/** The draft's citation warning for a numeric chunk id: the empty bibliography has no entry for it (see the header). */
const NUMERIC_CITATION = /Citeproc: citation \d+ not found$/;
/** The render's outputs in the workspace, in draft mode published only when clean. */
const OUTPUTS = [`${RENDER_DIR}/paper.html`, `${RENDER_DIR}/paper.docx`];

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
  folder: string,
  result: { code: number; stdout: string; stderr: string; timedOut: boolean },
  timeoutMs: number,
  draft: boolean,
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
    .filter((line) => /\bWARNING\b/.test(line))
    .filter((line) => !(draft && NUMERIC_CITATION.test(line)));
  for (const warning of new Set(warnings)) problems.push(`${WORKSPACE}/paper.qmd render: ${warning}`);

  const html = fileOutput(folder, `${RENDER_DIR}/paper.html`, problems);
  fileOutput(folder, `${RENDER_DIR}/paper.docx`, problems);
  if (html !== undefined) problems.push(...crossReferenceProblems(html));
  return problems.concat(tableProblems(folder, html));
}

/** An unresolved cross-reference: Quarto prints `@fig-x` it cannot resolve as `?@fig-x`, with no WARNING. */
function crossReferenceProblems(html: Buffer): string[] {
  const hits = new Set(html.toString("utf8").match(UNRESOLVED_REFERENCE) ?? []);
  return [...hits].map((hit) => `${WORKSPACE}/${RENDER_DIR}/paper.html has an unresolved cross-reference: ${hit}`);
}

/** The bytes of one render output, or nothing (a problem is added for a missing, empty or refused one). */
function fileOutput(folder: string, rel: string, problems: string[]): Buffer | undefined {
  try {
    const bytes = readRegular(folder, rel);
    if (bytes === undefined) problems.push(`${WORKSPACE}/${rel} is missing`);
    else if (bytes.length === 0) problems.push(`${WORKSPACE}/${rel} is empty`);
    else return bytes;
  } catch (error) {
    problems.push(message(error));
  }
  return undefined;
}

/** A shortfall: the paper has more table includes than the HTML has `<table` elements. Nothing is said without the HTML. */
function tableProblems(folder: string, html: Buffer | undefined): string[] {
  if (html === undefined) return [];
  const qmd = readRegular(folder, "paper.qmd")?.toString("utf8") ?? "";
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
  const workspace = path.join(node, WORKSPACE);
  const manuscript = locate(workspace, "paper.qmd");
  if (manuscript.kind === "refused") return [manuscript.problem];
  if (manuscript.kind !== "file") return [];

  const config = readConfig(runDir);
  const bibliography = locate(workspace, "references.bib");
  if (bibliography.kind === "refused") return [bibliography.problem];
  if (bibliography.kind === "absent") return draftProblems(runDir, node, config, exec);

  freshRenderDir(workspace);
  const { problems } = await runRender(workspace, () => realFolder(node, WORKSPACE), config, exec, false);
  return problems;
}

/**
 * A draft: the render runs on a scratch copy of the workspace with an empty `references.bib`, and the real workspace
 * gets the two outputs only when the render is clean. Its stale outputs are removed first, so none outlives a failure.
 */
async function draftProblems(runDir: string, node: string, config: ReturnType<typeof readConfig>, exec: Exec | undefined): Promise<string[]> {
  const workspace = path.join(node, WORKSPACE);
  const name = path.basename(node);
  const scratchRoot = path.join(runDir, ".analysis", "paper-render");
  const scratch = path.join(scratchRoot, name);
  // `.analysis/` must be ignored before the first scratch file exists, or a partial run leaves the tree dirty.
  ignoreScratch(runDir);
  // The scratch is written by the harness only: a link or file on its path is refused before anything is written through it.
  realFolderOrAbsent(runDir, ".analysis");
  realFolderOrAbsent(runDir, ".analysis/paper-render");
  const scratchFound = locate(runDir, `.analysis/paper-render/${name}`);
  if (scratchFound.kind === "refused") return [scratchFound.problem];
  for (const rel of OUTPUTS) {
    const found = locate(workspace, rel);
    if (found.kind === "refused") return [found.problem];
    if (found.kind === "file") fs.rmSync(path.join(workspace, ...rel.split("/")), { force: true });
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  copyWorkspace(workspace, scratch);
  fs.writeFileSync(path.join(scratch, "references.bib"), "");
  freshRenderDir(scratch);
  const { problems, clean } = await runRender(scratch, () => realFolder(runDir, `.analysis/paper-render/${name}`), config, exec, true);
  if (!clean) return problems;

  // Only the two outputs are written into the real workspace, through real folders only.
  realFolderOrAbsent(workspace, "checks");
  realFolderOrAbsent(workspace, RENDER_DIR);
  for (const rel of OUTPUTS) {
    const bytes = readRegular(scratch, rel);
    if (bytes === undefined) return [`${WORKSPACE}/${rel} is missing`];
    writeAtomic(path.join(workspace, ...rel.split("/")), bytes);
  }
  return problems;
}

/** A folder that is absent or real, created when absent; a link or a file where it belongs throws. */
function realFolderOrAbsent(base: string, rel: string): void {
  const found = locate(base, rel);
  if (found.kind === "refused") throw new Error(found.problem);
  if (found.kind === "file") throw new Error(`${rel} is not a folder`);
  if (found.kind === "absent") fs.mkdirSync(path.join(base, ...rel.split("/")), { recursive: true });
}

/**
 * Copies a draft workspace into `scratch`: regular files and folders only. The render's own folders (`checks/render`,
 * `paper_files`, `.quarto`) and the deepis output (`deepis.bib`) are left out. A link, or anything else that is not a
 * regular file or folder, throws with the path, so nothing is copied past it.
 */
function copyWorkspace(workspace: string, scratch: string): void {
  const skip = new Set([RENDER_DIR, "paper_files", ".quarto", "deepis.bib"]);
  const walk = (rel: string): void => {
    const dir = rel === "" ? workspace : path.join(workspace, ...rel.split("/"));
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const shown = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (skip.has(shown)) continue;
      if (entry.isSymbolicLink()) throw new Error(`${WORKSPACE}/${shown} is a link: refusing to use it`);
      if (entry.isDirectory()) {
        fs.mkdirSync(path.join(scratch, ...shown.split("/")), { recursive: true });
        walk(shown);
      } else if (entry.isFile()) {
        const bytes = readRegular(workspace, shown);
        if (bytes !== undefined) fs.writeFileSync(path.join(scratch, ...shown.split("/")), bytes);
      } else throw new Error(`${WORKSPACE}/${shown} is not a regular file or folder`);
    }
  };
  walk("");
}

/** Makes `checks/render` in `base` a fresh empty folder: an earlier render's outputs are removed first. */
function freshRenderDir(base: string): void {
  realFolder(base, "checks");
  if (realFolder(base, RENDER_DIR)) fs.rmSync(path.join(base, ...RENDER_DIR.split("/")), { recursive: true, force: true });
  fs.mkdirSync(path.join(base, ...RENDER_DIR.split("/")), { recursive: true });
  realFolder(base, RENDER_DIR);
}

/**
 * One hardened render of `folder` (mounted at /work and the only writable mount), with the snapshot checks. `stillFolder`
 * says whether the mount source is still a real folder after the run. `clean` is true when there are no problems.
 */
async function runRender(
  folder: string,
  stillFolder: () => boolean,
  config: ReturnType<typeof readConfig>,
  exec: Exec | undefined,
  draft: boolean,
): Promise<{ problems: string[]; clean: boolean }> {
  const before = snapshot(folder);
  const result = await (exec ?? realExec)(
    paperDockerArgs({
      image: config.paperImage,
      folder,
      command: ["quarto", "render", "paper.qmd", "--output-dir", RENDER_DIR],
      ...hostIds(),
    }),
    { timeoutMs: config.paperTimeoutMs },
  );
  // The mount source is checked again after the run: the container could have replaced it with a link.
  if (!stillFolder()) {
    const problems = [`${WORKSPACE} was replaced by a link during the render: nothing is trusted`];
    return { problems, clean: false };
  }
  // Quarto's project state is not part of the paper; it is removed, and a link there is simply not followed.
  if (realFolder(folder, ".quarto")) fs.rmSync(path.join(folder, ".quarto"), { recursive: true, force: true });
  const problems = changedBy(before, snapshot(folder));
  problems.push(...outputProblems(folder, result, config.paperTimeoutMs, draft));
  return { problems, clean: problems.length === 0 };
}
