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

/** The role files Phase 1's briefs name on their Skill line. */
const PHASE1_ROLES = ["scan-expectation", "scan-blind"];

/** The pattern card's headings, as check-pattern.ts checks them. */
const CARD_HEADINGS = ["## Measure", "## Result", "## Verdict", "## Robustness", "## Worst fits", "## Deviations"];

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

test("the input status is handed on in phase-0 §4 and the manifest names node.json and the dataset root", () => {
  const phase0 = read("harness/skills/phase-0/SKILL.md");
  const section4 = phase0.slice(phase0.indexOf("## 4. Hand-off"), phase0.indexOf("## Never"));
  assert.match(section4, /status: "input"/, "§4 hands the assembler on with status input");
  assert.doesNotMatch(section4, /status: "ready"/, "§4 no longer hands it on as ready");
  assert.match(phase0, /Phase 0 review edge 1|go straight to §4/, "resume rule goes straight to §4");

  const assemble = read("harness/skills/roles/prep-assemble.md");
  const manifest = assemble.slice(assemble.indexOf("## Manifest"), assemble.indexOf("## Citations"));
  assert.match(manifest, /node\.json/, "the manifest lists the run's node.json");
  assert.match(manifest, /dataset root/, "the manifest lists the dataset root");
  assert.match(manifest, /split-<ext>/, "the manifest names the analysed extension's split");

  assert.match(
    read("harness/skills/roles/prep-expectations.md"),
    /exploration column of `profile\.md` §5/,
    "denominators come from the exploration column of profile.md §5",
  );
  assert.match(read("harness/skills/phase-owner/SKILL.md"), /`input`/, "phase-owner describes the input status");
});

test("phase-1 has the phase-1 frontmatter and describes the pattern workflow", () => {
  const file = "harness/skills/phase-1/SKILL.md";
  assert.ok(existsSync(path.join(HARNESS_ROOT, file)), `${file} exists`);
  const markdown = read(file);

  const fields = frontmatter(markdown);
  assert.equal(fields.name, "phase-1");
  assert.match(fields.description ?? "", /Phase 1/);
  assert.match(fields.description ?? "", /patterns/);

  const body = markdown.slice(markdown.indexOf("\n---\n") + 5);
  // The pattern nodes, the hand-off to Phase 2 and the two scanner roles are the
  // workflow's spine; the card's hygiene notes are what close a node instead.
  for (const needed of [
    "tree_list",
    "tree_create",
    "tree_update",
    "manifest.md",
    "input",
    "check-pattern.ts",
    "preregister",
    "phase: 2",
    "closed",
    "blind",
    "duplicate of",
    "artifact:",
    "Phase 1 complete:",
  ]) {
    assert.ok(body.includes(needed), `the body mentions ${needed}`);
  }
  // phase-owner's loop filters on `ready`, which never returns the input node.
  assert.match(body, /tree_list\(\{ phase: 1 \}\)/, "reads the job list with an unfiltered tree_list");
  assert.match(body, /never (brief|dispatch)/i, "says the input node is never briefed or dispatched");
  // check-pattern prints its problems to stdout and `ok` is the only pass.
  assert.match(body, /other than `ok`/i, "says any output other than ok is a failure");
  assert.match(body, /fix loop/, "sends a failing check back through the fix loop");
});

test("Phase 1 briefs exclude the hold-out lists and apply hygiene before routing", () => {
  const markdown = read("harness/skills/phase-1/SKILL.md");
  const body = markdown.slice(markdown.indexOf("\n---\n") + 5);

  // The manifest lists the hold-out on purpose; a brief must not hand it on.
  const inputs = body.split("\n").filter((line) => line.includes("**Inputs:**"));
  assert.ok(inputs.length >= 1, "the expectation brief lists its Inputs");
  for (const line of inputs) {
    assert.match(line, /except its hold-out lists/i, `the brief's Inputs exclude the hold-out lists: ${line}`);
  }
  // The blind brief is prose, so count the phrase instead of the field label.
  assert.equal(
    (body.match(/except its hold-out lists/gi) ?? []).length,
    2,
    "both briefs exclude the hold-out lists",
  );

  const section = (from: string, to: string): string => body.slice(body.indexOf(from), body.indexOf(to));
  const handoff = section("## 2. On each handoff", "## 3. ");
  // Checker → hygiene → routing: a duplicate must close while it is still phase 1.
  assert.ok(handoff.indexOf("check-pattern.ts") < handoff.indexOf("duplicate of"), "the checker runs before the duplicate test");
  assert.ok(handoff.indexOf("duplicate of") < handoff.indexOf("phase: 2"), "hygiene runs before the verdict routing");
  assert.match(handoff, /artifact:/, "the handoff step tests for artifacts too");
  assert.match(handoff, /no regularity/, "a blind criterion not met closes with note unmeasurable: no regularity");
  assert.match(handoff, /cannot\s+see/i, "the skill says the handoff check cannot see pattern.md's commit order");
  assert.match(handoff, /re-run/i, "the owner re-runs the checker after the tree_update commits the card");
  assert.match(section("## 4. ", "## 5. "), /§2/, "§4 points at §2 rather than restating the order");
});

test("Phase 1 roles refuse a hold-out input in any spelling and keep analyses small", () => {
  for (const role of PHASE1_ROLES) {
    const file = `harness/skills/roles/${role}.md`;
    const markdown = read(file).replace(/\s+/g, " ");
    assert.match(
      markdown,
      /never a hold-out list, even when the manifest names it/i,
      `${file} refuses a hold-out even when the manifest names it`,
    );
    for (const spelling of ["`holdout`", "`hold-out`", "`hold_out`"]) {
      assert.ok(markdown.includes(spelling), `${file} names the ${spelling} spelling`);
    }
    assert.match(markdown, /case-insensitive/i, `${file} says the match is case-insensitive`);
    assert.match(markdown, /no fitted models/i, `${file} forbids fitted models`);
  }
});

test("a blind scanner that misses its criterion reports unmeasurable, not open", () => {
  const markdown = read("harness/skills/roles/scan-blind.md");
  const verdict = markdown.slice(markdown.indexOf("## Verdict"), markdown.indexOf("## Robustness"));
  assert.match(verdict, /not met/i, "the verdict section names the criterion-not-met case");
  assert.match(verdict, /unmeasurable/, "a criterion not met is unmeasurable");
  assert.match(verdict, /counts/i, "it reports the measured counts");
  assert.match(verdict, /shortfall/i, "and the shortfall against the criterion");
  assert.match(
    markdown.slice(markdown.indexOf("## 4. Handoff"), markdown.indexOf("## Rules")),
    /not met/i,
    "the handoff rule covers the criterion not met",
  );
  assert.match(
    markdown.slice(markdown.indexOf("## Definition of Done")),
    /not met/i,
    "the DoD covers the criterion not met",
  );
});

test("every Phase 1 role file exists and is named by absolute path in the skill", () => {
  const body = read("harness/skills/phase-1/SKILL.md");
  for (const role of PHASE1_ROLES) {
    const file = path.join(SKILLS, "roles", `${role}.md`);
    assert.ok(existsSync(file), `${file} exists`);
    const markdown = readFileSync(file, "utf8");
    assert.match(frontmatter(markdown).name ?? "", new RegExp(role), `${role}.md names itself`);
    assert.ok(body.includes(file), `phase-1's Skill lines use the absolute path ${file}`);
  }
});

test("Phase 1 role files pre-register, measure the exploration split and write the six-heading card", () => {
  for (const role of PHASE1_ROLES) {
    const file = `harness/skills/roles/${role}.md`;
    const markdown = read(file);
    for (const needed of ["preregister", "measure.md", "exploration", ...CARD_HEADINGS]) {
      assert.ok(markdown.includes(needed), `${file} mentions ${needed}`);
    }
    assert.match(markdown, /Node or Python 3 stdlib/, `${file} keeps scripts to Node or Python 3 stdlib`);
    assert.match(
      markdown,
      /never write the word `holdout`/i,
      `${file} tells the worker never to write the word holdout in a script`,
    );
  }
});

test("scan-blind does not read expectations.md and reports open or unmeasurable", () => {
  const markdown = read("harness/skills/roles/scan-blind.md").replace(/\s+/g, " ");
  assert.match(markdown, /expectations\.md/, "scan-blind names the file it must not read");
  assert.match(markdown, /(do not|never) read `expectations\.md`/i, "scan-blind says not to read the expectations list");
  assert.match(markdown, /`open`/, "scan-blind's verdict is open");
  assert.match(markdown, /unmeasurable/, "scan-blind may report unmeasurable");
});

test("phase-1 and its roles only point at harness/tools files that exist", () => {
  const files = [
    "harness/skills/phase-1/SKILL.md",
    ...PHASE1_ROLES.map((role) => `harness/skills/roles/${role}.md`),
  ];
  const named = new Set<string>();
  for (const file of files) {
    for (const match of read(file).matchAll(/harness\/tools\/[\w.-]+\.ts/g)) named.add(match[0]);
  }
  assert.ok(named.has("harness/tools/check-pattern.ts"), "phase-1 runs check-pattern.ts");
  for (const file of named) assert.ok(existsSync(path.join(HARNESS_ROOT, file)), `${file} exists`);
});

test("DEFAULT_CONFIG configures Phases 0 and 1", () => {
  assert.deepEqual(DEFAULT_CONFIG.phases, {
    "0": "harness/skills/phase-0",
    "1": "harness/skills/phase-1",
  });
  for (const [phase, skill] of Object.entries(DEFAULT_CONFIG.phases)) {
    assert.ok(existsSync(path.join(HARNESS_ROOT, skill, "SKILL.md")), `phase ${phase}'s skill ${skill} exists`);
  }
});
