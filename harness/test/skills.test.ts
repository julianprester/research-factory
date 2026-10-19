// The Phase 0 skill and its role files are prose, so these tests check the two
// things prose can silently lose: the frontmatter and tool names a caller relies
// on, and the paths the prose sends workers to (a role that names a tool that
// does not exist, or a role file nobody briefs, is a broken dispatch).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG } from "../factory.ts";

const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILLS = path.join(HARNESS_ROOT, "harness", "skills");

/** The role files Phase 0's briefs name on their Skill line. */
const ROLES = ["prep-profile", "prep-expectations", "prep-assemble", "deepis"];

function read(relative: string): string {
  return readFileSync(path.join(HARNESS_ROOT, relative), "utf8");
}

/** The frontmatter's `key: value` pairs, with surrounding quotes removed. */
function frontmatter(markdown: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  assert.ok(match, "the file starts with a frontmatter block");
  const fields: Record<string, string> = {};
  for (const line of (match[1] as string).split("\n")) {
    const pair = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (pair) fields[pair[1] as string] = (pair[2] as string).replace(/^["']|["']$/g, "");
  }
  return fields;
}

test("phase-0 has the phase-0 frontmatter and describes the Phase 0 workflow", () => {
  const file = "harness/skills/phase-0/SKILL.md";
  assert.ok(existsSync(path.join(HARNESS_ROOT, file)), `${file} exists`);
  const markdown = read(file);

  const fields = frontmatter(markdown);
  assert.equal(fields.name, "phase-0");
  assert.match(fields.description ?? "", /Phase 0/);
  assert.match(fields.description ?? "", /preparation/);

  const body = markdown.slice(markdown.indexOf("\n---\n") + 5);
  // The prep nodes, the three roles and the hand-off are the workflow's spine.
  for (const needed of [
    "tree_list",
    "tree_create",
    'type: "prep"',
    "prep-profile",
    "prep-expectations",
    "prep-assemble",
    "closed",
    "phase: 1",
  ]) {
    assert.ok(body.includes(needed), `the body mentions ${needed}`);
  }
  // The owner reads the interest; it is never hard-coded here.
  assert.match(body, /node\.json/, "the body says to read the root node.json");
});

test("every Phase 0 role file exists and is named by absolute path in the skill", () => {
  const body = read("harness/skills/phase-0/SKILL.md");
  for (const role of ROLES) {
    const file = path.join(SKILLS, "roles", `${role}.md`);
    assert.ok(existsSync(file), `${file} exists`);
    const markdown = readFileSync(file, "utf8");
    assert.match(frontmatter(markdown).name ?? "", new RegExp(role), `${role}.md names itself`);
    assert.ok(body.includes(file), `phase-0's Skill lines use the absolute path ${file}`);
  }
});

test("role files only point at harness/tools files that exist", () => {
  const named = new Set<string>();
  for (const role of ROLES) {
    const markdown = read(`harness/skills/roles/${role}.md`);
    for (const match of markdown.matchAll(/harness\/tools\/[\w.-]+\.ts/g)) named.add(match[0]);
  }
  assert.ok(named.size > 0, "some role names a tool from harness/tools");
  for (const file of named) assert.ok(existsSync(path.join(HARNESS_ROOT, file)), `${file} exists`);
});

test("roles/deepis.md keeps every search bounded", () => {
  const markdown = read("harness/skills/roles/deepis.md");
  assert.ok(markdown.includes("--no-rerank"), "names the --no-rerank retry");
  assert.ok(markdown.includes("timeout 60"), "names the 60 s timeout");
  assert.ok(!markdown.includes("NEAR/"), "gives no NEAR proximity example, which websearch syntax lacks");
  // NEAR may be named only to say it does not work; otherwise it reads as advice.
  const nearLines = markdown.split("\n").filter((line) => line.includes("NEAR"));
  assert.ok(nearLines.length > 0, "names NEAR as unsupported so a reader does not try it");
  for (const line of nearLines) {
    assert.match(line, /(nothing|ignored|not supported)/i, "NEAR appears only where it is called unsupported");
  }
  assert.ok(markdown.includes("--fts"), "names the websearch --fts form");
  assert.match(markdown, /deepis context/, "names progressive disclosure's second step");
  assert.match(markdown, /deepis metadata/, "names progressive disclosure's third step");
});

test("role files and ctc-worker allow reads only of the brief's listed paths", () => {
  const files = [
    "harness/agents/ctc-worker.md",
    ...ROLES.map((role) => `harness/skills/roles/${role}.md`),
  ];
  for (const file of files) {
    const prose = read(file).replace(/\s+/g, " ");
    assert.ok(
      !prose.includes("never read another node"),
      `${file} does not ban cross-node reads outright`,
    );
  }
  const worker = read("harness/agents/ctc-worker.md");
  assert.match(
    worker,
    /read only the (input )?paths the brief lists/i,
    "ctc-worker.md says to read the paths the brief lists",
  );
});

test("roles/deepis.md tells workers to cite the chunk id printed next to the quote", () => {
  const markdown = read("harness/skills/roles/deepis.md").replace(/\s+/g, " ");
  assert.match(
    markdown,
    /cite the `chunk_id` printed next to the sentence you quote/i,
    "names the chunk id next to the quoted sentence as the one to cite",
  );
});

test("the hand-off contract names the manifest, the prep group, italics and the nudge rule", () => {
  assert.match(
    read("harness/skills/roles/prep-assemble.md"),
    /manifest\.md/,
    "prep-assemble writes workspace/manifest.md",
  );
  assert.match(
    read("harness/skills/phase-owner/SKILL.md"),
    /`prep\/`/,
    "phase-owner lists prep/ among the node folders",
  );
  assert.match(
    read("harness/skills/roles/deepis.md"),
    /Titles and terms go in italics/,
    "deepis.md italicises titles and terms rather than quoting them",
  );
  const phase0 = read("harness/skills/phase-0/SKILL.md");
  assert.match(phase0, /not a dispatch order/, "phase-0 says a nudge is not a dispatch order");
  assert.match(phase0, /manifest\.md/, "phase-0's hand-off note names manifest.md");
});

test("DEFAULT_CONFIG configures Phase 0", () => {
  assert.deepEqual(DEFAULT_CONFIG.phases, { "0": "harness/skills/phase-0" });
});
