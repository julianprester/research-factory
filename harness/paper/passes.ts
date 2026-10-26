// The style-pass bracket (design §8): two worker passes over the finished draft, `concise` then `humanize`, each
// bracketed by a begin and an end the code records. A pass may reword prose; it may not change an embed.
//
// `beginPass` needs a passing `checks/result.json` for the paper as it stands (so a draft that failed its checks is
// not polished), the passes in order (`humanize` only after `concise` is accepted), and the paper as the last
// accepted pass left it. It records the paper's sha and its embeds in `checks/pass-<pass>.begin.json` and commits
// the workspace as `[P4:pass-begin] W<nn> <pass>`, so the commit is the baseline the pass is measured against.
//
// `endPass` reads the begin record from the committed `[P4:pass-begin]` commit, not from disk: a begin record, or a
// `checks/passes.json`, that differs from its commit was written by someone other than the owner, so the pass is refused
// and the paper and workspace are restored from the begin commit. It then compares the embeds of the paper now with the
// committed record (`scanEmbeds`, `embedSetDiff`), and checks that no file of the workspace other than `paper.qmd` and
// the tool's own `checks/` changed since the begin commit. A difference is a rejection: `paper.qmd` and any such other
// file are restored from the begin commit, the begin record is consumed, and the rejection is committed as
// `[P4:pass-rejected] W<nn> <pass>` with the diff returned. Otherwise the pass is appended to `checks/passes.json`
// (`{ pass, beforeSha, afterSha }`) and committed as `[P4:pass-accepted] W<nn> <pass>`. An end with no begin is refused.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { readRegular, writeAtomic } from "../explain/rounds.ts";
import { commitFiles } from "../tree.ts";
import { embedSetDiff, scanEmbeds, type EmbedSet } from "./embeds.ts";
import { paperNodeOf, type PaperNode } from "./project.ts";

export const PASSES = ["concise", "humanize"] as const;
export type Pass = (typeof PASSES)[number];

/** The commits are the owner's: the owner runs the passes and their bracket. */
const ACTOR = "owner-p4";

/** One accepted pass, as `checks/passes.json` records it. */
export interface PassRecord {
  pass: Pass;
  beforeSha: string;
  afterSha: string;
}

interface BeginRecord {
  pass: Pass;
  paperSha: string;
  embeds: EmbedSet;
}

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const rel = (run: string, file: string): string => path.relative(run, file).split(path.sep).join("/");
const sameBytes = (a: Buffer | undefined, b: Buffer | undefined): boolean => (a === undefined || b === undefined ? a === b : a.equals(b));
const GIT_BYTES = 64 * 1024 * 1024;

/** The bytes of `file` (run-relative) at `commit`, or undefined when the commit has no such file. */
function shownAt(run: string, commit: string, file: string): Buffer | undefined {
  try {
    return execFileSync("git", ["show", `${commit}:${file}`], { cwd: run, maxBuffer: GIT_BYTES, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return undefined;
  }
}

/** Puts each run-relative file back as `commit` has it (removes it when the commit has none). */
function restoreFrom(run: string, commit: string, files: string[]): void {
  for (const file of files) {
    const bytes = shownAt(run, commit, file);
    const abs = path.join(run, ...file.split("/"));
    if (bytes === undefined) fs.rmSync(abs, { force: true });
    else writeAtomic(abs, bytes);
  }
}

function passOf(value: string): Pass {
  if (!(PASSES as readonly string[]).includes(value)) throw new Error(`${JSON.stringify(value)} is not a style pass (${PASSES.join(", ")})`);
  return value as Pass;
}

function paths(node: PaperNode) {
  const workspace = path.join(node.paper, "workspace");
  return {
    qmd: path.join(workspace, "paper.qmd"),
    passes: path.join(workspace, "checks", "passes.json"),
    begin: (pass: Pass) => path.join(workspace, "checks", `pass-${pass}.begin.json`),
    result: path.join(workspace, "checks", "result.json"),
  };
}

/**
 * The accepted passes, in order; a file that exists but cannot be read is an error, not "none". The file must be the
 * one last committed: the owner writes it in `pass_end`, so a rewrite by anyone else is refused.
 */
function acceptedOf(run: string, node: PaperNode): PassRecord[] {
  const bytes = readRegular(node.paper, "workspace/checks/passes.json");
  const committed = shownAt(run, "HEAD", rel(run, paths(node).passes));
  if (!sameBytes(bytes, committed)) {
    throw new Error("workspace/checks/passes.json differs from its last commit: refused (the owner writes the passes)");
  }
  if (bytes === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("workspace/checks/passes.json is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("workspace/checks/passes.json is not an array");
  return parsed.map((value) => {
    const record = value as Partial<PassRecord>;
    if (typeof record.pass !== "string" || typeof record.beforeSha !== "string" || typeof record.afterSha !== "string") {
      throw new Error("workspace/checks/passes.json holds a record that is not a pass");
    }
    return { pass: passOf(record.pass), beforeSha: record.beforeSha, afterSha: record.afterSha };
  });
}

/**
 * The accepted passes that still stand for the paper as it is: the records, unless the paper has changed since the last
 * one was accepted (its `afterSha` is not the paper's sha now), when none stand and both passes must run again.
 */
export function acceptedPasses(runDir: string, paperDir: string): PassRecord[] {
  const node = paperNodeOf(runDir, paperDir);
  return standing(acceptedOf(runDir, node), sha256(manuscriptOf(node)));
}

function standing(records: PassRecord[], paperSha: string): PassRecord[] {
  const last = records.at(-1);
  return last === undefined || last.afterSha === paperSha ? records : [];
}

/** A begin record as its bytes read; a record that cannot be read is an error. */
function parseBegin(bytes: Buffer, pass: Pass): BeginRecord {
  try {
    const record = JSON.parse(bytes.toString("utf8")) as Partial<BeginRecord>;
    if (record.pass !== pass || typeof record.paperSha !== "string" || typeof record.embeds !== "object" || record.embeds === null) {
      throw new Error("not a begin record");
    }
    return record as BeginRecord;
  } catch (error) {
    throw new Error(`the ${pass} begin record is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The newest `[P4:pass-begin] <W> <pass>` commit: the commit `endPass` reads the begin record and restores from. */
function beginCommitOf(run: string, node: PaperNode, pass: Pass): string {
  const subject = `[P4:pass-begin] ${node.paperId} ${pass}`;
  const log = execFileSync("git", ["log", "--format=%h%x09%s"], { cwd: run, encoding: "utf8" });
  const found = log
    .split("\n")
    .map((line) => line.split("\t"))
    .find((parts) => parts[1] === subject);
  if (found === undefined) throw new Error(`no ${subject} commit: the pass was not begun by the owner`);
  return found[0] ?? "";
}

/**
 * The workspace files other than `paper.qmd` and the tool's own `checks/` that differ from the begin commit: changed,
 * deleted or added (run-relative names).
 */
function changedOthers(run: string, node: PaperNode, commit: string): string[] {
  const workspace = rel(run, path.join(node.paper, "workspace"));
  const git = (args: string[]): string[] =>
    execFileSync("git", args, { cwd: run, encoding: "utf8", maxBuffer: GIT_BYTES })
      .split("\0")
      .filter((name) => name !== "");
  const changed = [
    ...git(["diff", "--relative", "--name-only", "-z", commit, "--", workspace]),
    ...git(["ls-files", "--others", "--exclude-standard", "-z", "--", workspace]),
  ];
  return [...new Set(changed)]
    .filter((name) => name !== `${workspace}/paper.qmd` && !name.startsWith(`${workspace}/checks/`))
    .sort();
}

/** The paper's `paper.qmd`, or a refusal when it is absent. */
function manuscriptOf(node: PaperNode): Buffer {
  const bytes = readRegular(node.paper, "workspace/paper.qmd");
  if (bytes === undefined) throw new Error(`${node.paperId} has no workspace/paper.qmd`);
  return bytes;
}

/** Whether `checks/result.json` is ok for the paper with sha `paperSha`. */
function checkedOk(node: PaperNode, paperSha: string): boolean {
  const bytes = readRegular(node.paper, "workspace/checks/result.json");
  if (bytes === undefined) return false;
  try {
    const result = JSON.parse(bytes.toString("utf8")) as { paperSha?: unknown; ok?: unknown };
    return result.ok === true && result.paperSha === paperSha;
  } catch {
    return false;
  }
}

/**
 * Begins `pass` on the paper at `paperDir`: refused unless the check is ok for the current `paper.qmd`, the earlier
 * passes are accepted and this one is not, and the paper is what the last accepted pass left. Returns the paper's
 * sha and its embeds, which `endPass` compares against.
 */
export function beginPass(runDir: string, paperDir: string, pass: string): { paperSha: string; embeds: EmbedSet } {
  const name = passOf(pass);
  const node = paperNodeOf(runDir, paperDir);
  const file = paths(node);
  const qmd = manuscriptOf(node);
  const paperSha = sha256(qmd);
  const accepted = standing(acceptedOf(runDir, node), paperSha);
  if (accepted.some((record) => record.pass === name)) throw new Error(`${name} is already accepted for ${node.paperId}`);
  for (const earlier of PASSES.slice(0, PASSES.indexOf(name))) {
    if (!accepted.some((record) => record.pass === earlier)) throw new Error(`${name} comes after ${earlier}: accept ${earlier} first`);
  }
  if (!checkedOk(node, paperSha)) {
    throw new Error(`checks/result.json is not ok for the current paper.qmd: run check_paper before a style pass`);
  }
  const embeds = scanEmbeds(qmd.toString("utf8"));
  const record: BeginRecord = { pass: name, paperSha, embeds };
  writeAtomic(file.begin(name), `${JSON.stringify(record, null, 2)}\n`);
  // The whole workspace is the baseline: what `endPass` may find changed is what the pass changed, not what the writer
  // had left uncommitted before it began.
  commitFiles(runDir, [rel(runDir, path.join(node.paper, "workspace"))], ACTOR, `[P4:pass-begin] ${node.paperId} ${name}`);
  return { paperSha, embeds };
}

/**
 * Ends `pass`: accepts it when no embed changed and no other workspace file changed, else restores `paper.qmd` and
 * those files from the begin commit and rejects it. The returned `diff` lists each embed whose count changed and each
 * other file restored (empty when accepted). Refused when the pass has no begin; a begin record or `passes.json` the
 * owner did not commit is refused, with `paper.qmd` and the workspace restored from the begin commit.
 */
export function endPass(runDir: string, paperDir: string, pass: string): { accepted: boolean; diff: string[] } {
  const name = passOf(pass);
  const node = paperNodeOf(runDir, paperDir);
  const file = paths(node);
  const working = readRegular(node.paper, `workspace/checks/pass-${name}.begin.json`);
  if (working === undefined) throw new Error(`no pass-begin for ${name} on ${node.paperId}: run pass_begin first`);
  const commit = beginCommitOf(runDir, node, name);
  const committed = shownAt(runDir, commit, rel(runDir, file.begin(name)));
  if (committed === undefined) throw new Error(`the ${name} begin record is not in its pass-begin commit`);
  const begin = parseBegin(committed, name);
  const others = changedOthers(runDir, node, commit);

  // A record the owner did not commit is not the owner's: the paper and the workspace are put back as the begin left them.
  const forged: string[] = [];
  if (!sameBytes(working, committed)) forged.push(`workspace/checks/pass-${name}.begin.json differs from its pass-begin commit`);
  if (!sameBytes(readRegular(node.paper, "workspace/checks/passes.json"), shownAt(runDir, "HEAD", rel(runDir, file.passes)))) {
    forged.push("workspace/checks/passes.json differs from its last commit");
  }
  if (forged.length > 0) {
    restoreFrom(runDir, commit, [rel(runDir, file.qmd), rel(runDir, file.begin(name)), rel(runDir, file.passes), ...others]);
    throw new Error(
      `pass_end refused for ${name} on ${node.paperId}: ${forged.join("; ")}; paper.qmd and the workspace are restored from the pass-begin commit`,
    );
  }

  const qmd = manuscriptOf(node);
  const diff = [
    ...embedSetDiff(begin.embeds, scanEmbeds(qmd.toString("utf8"))),
    ...others.map((other) => `${other} changed by the pass: restored from the pass-begin commit`),
  ];

  if (diff.length > 0) {
    restoreFrom(runDir, commit, [rel(runDir, file.qmd), ...others]);
    fs.rmSync(file.begin(name), { force: true });
    commitFiles(runDir, [rel(runDir, file.qmd), rel(runDir, file.begin(name)), ...others], ACTOR, `[P4:pass-rejected] ${node.paperId} ${name}`);
    return { accepted: false, diff };
  }

  const records = [...standing(acceptedOf(runDir, node), begin.paperSha), { pass: name, beforeSha: begin.paperSha, afterSha: sha256(qmd) }];
  writeAtomic(file.passes, `${JSON.stringify(records, null, 2)}\n`);
  fs.rmSync(file.begin(name), { force: true });
  commitFiles(
    runDir,
    [rel(runDir, file.qmd), rel(runDir, file.passes), rel(runDir, file.begin(name))],
    ACTOR,
    `[P4:pass-accepted] ${node.paperId} ${name}`,
  );
  return { accepted: true, diff: [] };
}
