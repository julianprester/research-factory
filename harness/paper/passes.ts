// The style-pass bracket (design §8): two worker passes over the finished draft, `concise` then `humanize`, each
// bracketed by a begin and an end the code records. A pass may reword prose; it may not change an embed.
//
// `beginPass` needs a passing `checks/result.json` for the paper as it stands (so a draft that failed its checks is
// not polished), the passes in order (`humanize` only after `concise` is accepted), and the paper as the last
// accepted pass left it. It records the paper's sha and its embeds in `checks/pass-<pass>.begin.json` and commits
// them with `paper.qmd` as `[P4:pass-begin] W<nn> <pass>`.
//
// `endPass` compares the embeds of the paper now with the begin record (`scanEmbeds`, `embedSetDiff`). A difference
// is a rejection: `paper.qmd` is restored byte for byte from the begin commit, the begin record is consumed, and the
// rejection is committed as `[P4:pass-rejected] W<nn> <pass>` with the diff returned. Otherwise the pass is appended
// to `checks/passes.json` (`{ pass, beforeSha, afterSha }`) and committed as `[P4:pass-accepted] W<nn> <pass>`. An
// end with no begin is refused.
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

/** The accepted passes, in order; a file that exists but cannot be read is an error, not "none". */
function acceptedOf(node: PaperNode): PassRecord[] {
  const bytes = readRegular(node.paper, "workspace/checks/passes.json");
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

/** The begin record of `pass`, or undefined when there is none; a record that cannot be read is an error. */
function beginOf(node: PaperNode, pass: Pass): BeginRecord | undefined {
  const bytes = readRegular(node.paper, `workspace/checks/pass-${pass}.begin.json`);
  if (bytes === undefined) return undefined;
  try {
    const record = JSON.parse(bytes.toString("utf8")) as Partial<BeginRecord>;
    if (record.pass !== pass || typeof record.paperSha !== "string" || typeof record.embeds !== "object" || record.embeds === null) {
      throw new Error("not a begin record");
    }
    return record as BeginRecord;
  } catch (error) {
    throw new Error(`workspace/checks/pass-${pass}.begin.json is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The newest `[P4:pass-begin] <W> <pass>` commit: the commit `endPass` restores `paper.qmd` from. */
function beginCommitOf(run: string, node: PaperNode, pass: Pass): string {
  const subject = `[P4:pass-begin] ${node.paperId} ${pass}`;
  const log = execFileSync("git", ["log", "--format=%h%x09%s"], { cwd: run, encoding: "utf8" });
  const found = log
    .split("\n")
    .map((line) => line.split("\t"))
    .find((parts) => parts[1] === subject);
  if (found === undefined) throw new Error(`no ${subject} commit to restore ${node.paperId}/workspace/paper.qmd from`);
  return found[0] ?? "";
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
  const accepted = acceptedOf(node);
  if (accepted.some((record) => record.pass === name)) throw new Error(`${name} is already accepted for ${node.paperId}`);
  for (const earlier of PASSES.slice(0, PASSES.indexOf(name))) {
    if (!accepted.some((record) => record.pass === earlier)) throw new Error(`${name} comes after ${earlier}: accept ${earlier} first`);
  }
  const qmd = manuscriptOf(node);
  const paperSha = sha256(qmd);
  const last = accepted.at(-1);
  if (last !== undefined && last.afterSha !== paperSha) {
    throw new Error(`workspace/paper.qmd changed since ${last.pass} was accepted: check the paper again first`);
  }
  if (!checkedOk(node, paperSha)) {
    throw new Error(`checks/result.json is not ok for the current paper.qmd: run check_paper before a style pass`);
  }
  const embeds = scanEmbeds(qmd.toString("utf8"));
  const record: BeginRecord = { pass: name, paperSha, embeds };
  writeAtomic(file.begin(name), `${JSON.stringify(record, null, 2)}\n`);
  commitFiles(runDir, [rel(runDir, file.qmd), rel(runDir, file.begin(name))], ACTOR, `[P4:pass-begin] ${node.paperId} ${name}`);
  return { paperSha, embeds };
}

/**
 * Ends `pass`: accepts it when no embed changed, else restores `paper.qmd` from the begin commit and rejects it. The
 * returned `diff` lists each embed whose count changed (empty when accepted). Refused when the pass has no begin.
 */
export function endPass(runDir: string, paperDir: string, pass: string): { accepted: boolean; diff: string[] } {
  const name = passOf(pass);
  const node = paperNodeOf(runDir, paperDir);
  const file = paths(node);
  const begin = beginOf(node, name);
  if (begin === undefined) throw new Error(`no pass-begin for ${name} on ${node.paperId}: run pass_begin first`);
  const qmd = manuscriptOf(node);
  const diff = embedSetDiff(begin.embeds, scanEmbeds(qmd.toString("utf8")));

  if (diff.length > 0) {
    const original = execFileSync("git", ["show", `${beginCommitOf(runDir, node, name)}:${rel(runDir, file.qmd)}`], { cwd: runDir });
    writeAtomic(file.qmd, original);
    fs.rmSync(file.begin(name), { force: true });
    commitFiles(runDir, [rel(runDir, file.qmd), rel(runDir, file.begin(name))], ACTOR, `[P4:pass-rejected] ${node.paperId} ${name}`);
    return { accepted: false, diff };
  }

  const records = [...acceptedOf(node), { pass: name, beforeSha: begin.paperSha, afterSha: sha256(qmd) }];
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
