// The Phase 0 skill and its role files are prose, so these tests check the two
// things prose can silently lose: the frontmatter and tool names a caller relies
// on, and the paths the prose sends workers to (a role that names a tool that
// does not exist, or a role file nobody briefs, is a broken dispatch).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG } from "../factory.ts";
import {
  explanationWorkerMayWrite,
  holdoutRefusal,
  ownerMayWrite,
  ownersRefusal,
  reviewerMayWrite,
  reviewsRefusal,
  siblingRefusal,
  taskOf,
} from "../guard.ts";
import { checkRevision, parseReport } from "../tools/check-argument.ts";
import { parseReview, reviewProblems } from "../tools/merge-reviews.ts";

const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILLS = path.join(HARNESS_ROOT, "harness", "skills");

/** The role files Phase 0's briefs name on their Skill line. */
const ROLES = ["prep-profile", "prep-expectations", "prep-assemble", "deepis"];

/** The role files Phase 1's briefs name on their Skill line. */
const PHASE1_ROLES = ["scan-expectation", "scan-blind"];

/** The role files Phase 2's briefs name on their Skill line. */
const PHASE2_ROLES = ["puzzle-generate", "puzzle-review", "puzzle-evolve"];

/** The pattern card's headings, as check-pattern.ts checks them. */
const CARD_HEADINGS = ["## Measure", "## Result", "## Verdict", "## Robustness", "## Worst fits", "## Deviations"];

/** The puzzle card's headings, as check-puzzle.ts checks them. */
const PUZZLE_HEADINGS = [
  "## Pattern",
  "## Violated expectation",
  "## A case of",
  "## Why it matters",
  "## Admissible explanations",
  "## Limits",
  "## Literature log",
];

/** The review's headings, as merge-reviews.ts checks them. */
const REVIEW_HEADINGS = [
  "## Fit",
  "## Plausibility",
  "## Relevance",
  "## Data-character check",
  "## Known-result check",
  "## Findings",
  "## Phase 3 must check",
];

/** The book's three evaluation questions, as docs/abduction.md states them. */
const BOOK_QUESTIONS = [
  "Are the theoretical claims supported by the empirical materials?",
  "Are the theoretical claims stronger than competing theories?",
  "Do the theorizations matter in the broader intellectual community?",
];

function read(relative: string): string {
  return readFileSync(path.join(HARNESS_ROOT, relative), "utf8");
}

/** Curly quotes to ASCII, any run of whitespace to one space. */
function normalise(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
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
  assert.ok(
    (body.match(/except its hold-out lists/gi) ?? []).length >= 2,
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
  assert.match(
    handoff.replace(/\s+/g, " "),
    /same check \(`--blind` for blind nodes\)/,
    "the re-run names --blind for blind nodes",
  );
  assert.match(handoff, /before you close the input node/i, "the re-run happens before the final input-node close");
  assert.match(handoff.replace(/\s+/g, " "), /safety net/i, "the re-run is described as a safety net, not the real ordering check");
  assert.match(section("## 4. ", "## 5. "), /§2/, "§4 points at §2 rather than restating the order");

  // A blind batch of null results saturates the phase; the two-batch cap is a backstop.
  const saturation = section("## 5. ", "## Never");
  assert.match(
    saturation,
    /`unmeasurable: no regularity`/,
    "a batch of null blind results counts towards saturation",
  );
  assert.match(saturation, /duplicates, artifacts/i, "duplicates and artifacts still saturate too");
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
    assert.match(markdown, /plus your own node folder/i, `${file} lets the worker re-read its own node folder`);
  }
});

test("a blind scanner that misses its criterion reports unmeasurable, not open", () => {
  const markdown = read("harness/skills/roles/scan-blind.md");
  const verdict = markdown.slice(markdown.indexOf("## Verdict"), markdown.indexOf("## Robustness"));
  assert.match(verdict, /not met/i, "the verdict section names the criterion-not-met case");
  assert.match(verdict, /unmeasurable/, "a criterion not met is unmeasurable");
  assert.match(verdict, /counts/i, "it reports the measured counts");
  assert.match(verdict, /shortfall/i, "and the shortfall against the criterion");
  const worstFitsStart = markdown.indexOf("## Worst fits");
  assert.ok(worstFitsStart >= 0, "scan-blind has a Worst fits section");
  assert.match(
    markdown.slice(worstFitsStart, markdown.indexOf("## Deviations", worstFitsStart)),
    /fell short/i,
    "Worst fits names the slices that fell short of an unmet criterion",
  );
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

test("Phase 1 roles read the paths the brief lists, not an unlisted manifest", () => {
  for (const role of PHASE1_ROLES) {
    const file = `harness/skills/roles/${role}.md`;
    const prose = read(file).replace(/\s+/g, " ");
    assert.match(
      prose,
      /the paths the brief lists first \(they come from the run's `manifest\.md`\)/,
      `${file} reads the paths the brief lists`,
    );
    assert.ok(
      !/Read the brief's inputs first: the run's `manifest\.md`/.test(prose),
      `${file} does not send the worker to a manifest the brief may not list`,
    );
  }
  // The briefs hand on the manifest's paths, never the manifest's own path.
  const inputs = read("harness/skills/phase-1/SKILL.md")
    .split("\n")
    .filter((line) => line.includes("**Inputs:**") || line.includes("manifest paths except"));
  assert.ok(inputs.length >= 1, "the expectation brief lists its Inputs");
  assert.ok(
    inputs.some((line) => /every path in `workspace\/manifest\.md` except its hold-out lists/.test(line)),
    "the Inputs are the manifest's paths minus its hold-out lists",
  );
});

test("phase-1 blocks on a missing manifest instead of improvising paths", () => {
  const body = read("harness/skills/phase-1/SKILL.md").replace(/\s+/g, " ");
  assert.match(body, /no `workspace\/manifest\.md`, or that manifest names no exploration list/);
  assert.match(body, /Ruling: Phase 1 blocked/);
  assert.match(body, /BLOCKED/);
  assert.match(body, /do not improvise paths/);
});

test("a problem found after routing is a ledger finding, not a reopen", () => {
  const body = read("harness/skills/phase-1/SKILL.md");
  const handoff = body.slice(body.indexOf("## 2. On each handoff"), body.indexOf("## 3. ")).replace(/\s+/g, " ");
  assert.match(handoff, /cannot be fixed from here/);
  assert.match(handoff, /refuses another phase's nodes/, "names the tree_update refusal");
  assert.match(handoff, /finding for the run's review/, "records the problem as a finding");
  assert.match(handoff, /do not try to reopen/, "does not try to reopen the node");
});

test("Phase 1 roles pre-register before any measurement file exists", () => {
  for (const role of PHASE1_ROLES) {
    const file = `harness/skills/roles/${role}.md`;
    const prose = read(file).replace(/\s+/g, " ");
    assert.match(
      prose,
      /before you create `workspace\/scripts\/`, `workspace\/results\/` or `workspace\/pattern\.md`/,
      `${file} calls preregister before the measurement files exist`,
    );
    assert.match(prose, /measure first is not allowed/, `${file} names the refusal`);
  }
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

test("DEFAULT_CONFIG configures Phases 0 to 3", () => {
  assert.deepEqual(DEFAULT_CONFIG.phases, {
    "0": "harness/skills/phase-0",
    "1": "harness/skills/phase-1",
    "2": "harness/skills/phase-2",
    "3": "harness/skills/phase-3",
  });
  for (const [phase, skill] of Object.entries(DEFAULT_CONFIG.phases)) {
    assert.ok(existsSync(path.join(HARNESS_ROOT, skill, "SKILL.md")), `phase ${phase}'s skill ${skill} exists`);
  }
});

test("the Phase 1 skill carries Phase 0's caveats forward and closes pre-known violations as known", () => {
  const body = read("harness/skills/phase-1/SKILL.md").replace(/\s+/g, " ");
  for (const needed of ["summary.md", "pre-known contradicted", "Caveat:", "— caveat:", "known: contradicted before measuring", "<q> known"]) {
    assert.ok(body.includes(needed), `the skill mentions ${needed}`);
  }
  // The caveat is read before anything is briefed, and routing applies it.
  assert.ok(body.indexOf("Caveat: E<n>") < body.indexOf("## 1. One expectation scanner"), "caveats are recorded before briefing");
  assert.match(body, /comes back `violated` is not a surprise/);
});

test("both scanner roles tell the worker to declare directory listing in measure.md", () => {
  for (const role of PHASE1_ROLES) {
    const markdown = read(`harness/skills/roles/${role}.md`).replace(/\s+/g, " ");
    assert.match(markdown, /Enumerates: <why/, `${role} names the Enumerates: line`);
    assert.match(markdown, /os\.walk/, `${role} says which calls count`);
  }
});

test("the assembler marks pre-known and inferred entries in summary.md for Phase 1", () => {
  const markdown = read("harness/skills/roles/prep-assemble.md").replace(/\s+/g, " ");
  assert.match(markdown, /\*\*Pre-known contradicted\*\* or \*\*Inferred\*\*/);
  assert.match(markdown, /closes a pre-known entry that is measured `violated` as `known`/);
});

test("phase-2 has the phase-2 frontmatter and describes the puzzle workflow", () => {
  const file = "harness/skills/phase-2/SKILL.md";
  assert.ok(existsSync(path.join(HARNESS_ROOT, file)), `${file} exists`);
  const markdown = read(file);

  const fields = frontmatter(markdown);
  assert.equal(fields.name, "phase-2");
  assert.match(fields.description ?? "", /Phase 2/);
  assert.match(fields.description ?? "", /puzzles/);

  const body = markdown.slice(markdown.indexOf("\n---\n") + 5);
  // The job list, generation, reviews, the round tool and promotion are the
  // workflow's spine; a skill that omits one sends the owner improvising.
  for (const needed of [
    "tree_list({ phase: 2 })",
    'tree_update({ nodeId: "<T..>", status: "input" })',
    'tree_create({ parentId: "<T..>", title: "<lens>: <short title>" })',
    "judge_round",
    "check_duplicates",
    "promote",
    "merge-reviews.ts",
    "check-puzzle.ts",
    "PARTIAL",
    "identical arguments",
    "pairs",
    "STOP",
    "input",
    "parked",
    "submitted",
    "Pattern request:",
    "Caveat:",
    "meta-review",
    "ctc-reviewer",
    "brief-review.md",
    "Ruling:",
  ]) {
    assert.ok(body.includes(needed), `the body mentions ${needed}`);
  }
  // The two calls the barrier will not wait for, and the independence rule.
  assert.match(body, /both reviewers of a puzzle concurrently/i, "the reviewers are dispatched concurrently");
  assert.match(body, /no analysis/i, "Phase 2 runs no analysis");
  assert.match(body, /never shown to the judge/i, "the meta-review never reaches the judge");
});

test("phase-2 puts the ledger, the closing call and the STOP latch in order", () => {
  const body = read("harness/skills/phase-2/SKILL.md").replace(/\s+/g, " ");
  assert.match(body, /ledger line (immediately )?before/i, "every ledger line goes before its tree/tool call");
  assert.match(body, /as the \*\*last\*\* tree call/i, "the pattern nodes are closed by the last tree call");
  assert.match(body, /never create an evolution child after STOP/i, "no evolved puzzle after STOP");
  assert.match(body, /never call `judge_round` again/i, "no second judge_round after STOP");
  assert.match(body, /repeat it with the identical arguments/i, "a PARTIAL round is resumed unchanged");
  assert.match(body, /never write or edit anything under `owners\/phase-2\/tournament\/`/i, "the tournament files are tools-only");
  assert.match(body, /Never promote around `promote`/i, "promotion only through the gated tool");
});

test("every Phase 2 role file exists and is named by absolute path in the skill", () => {
  const body = read("harness/skills/phase-2/SKILL.md");
  for (const role of PHASE2_ROLES) {
    const file = path.join(SKILLS, "roles", `${role}.md`);
    assert.ok(existsSync(file), `${file} exists`);
    const markdown = readFileSync(file, "utf8");
    assert.match(frontmatter(markdown).name ?? "", new RegExp(role), `${role}.md names itself`);
    assert.ok(body.includes(file), `phase-2's Skill lines use the absolute path ${file}`);
  }
});

test("the Phase 2 skills only name tool and skill paths that exist", () => {
  const files = ["harness/skills/phase-2/SKILL.md", ...PHASE2_ROLES.map((role) => `harness/skills/roles/${role}.md`)];
  const named = new Set<string>();
  for (const file of files) {
    for (const match of read(file).matchAll(/harness\/(?:tools|skills)\/[\w./-]+\.(?:ts|md)/g)) named.add(match[0]);
  }
  for (const file of [
    "harness/tools/check-puzzle.ts",
    "harness/tools/merge-reviews.ts",
    "harness/tools/check-citations.ts",
  ]) {
    assert.ok(named.has(file), `a Phase 2 skill names ${file}`);
  }
  for (const file of named) assert.ok(existsSync(path.join(HARNESS_ROOT, file)), `${file} exists`);
});

test("puzzle-generate and puzzle-evolve teach the seven-heading card and its header lines", () => {
  for (const role of ["puzzle-generate", "puzzle-evolve"]) {
    const markdown = read(`harness/skills/roles/${role}.md`);
    for (const needed of [...PUZZLE_HEADINGS, "Lens:", "Round:"]) {
      assert.ok(markdown.includes(needed), `${role}.md mentions ${needed}`);
    }
  }
  const evolve = read("harness/skills/roles/puzzle-evolve.md");
  for (const needed of ["Derived from:", "Move:", "grounding", "simplification", "out-of-the-box", "combination"]) {
    assert.ok(evolve.includes(needed), `puzzle-evolve.md mentions ${needed}`);
  }
});

test("puzzle-review teaches every review heading and the rating lines", () => {
  const markdown = read("harness/skills/roles/puzzle-review.md");
  for (const needed of [...REVIEW_HEADINGS, "Rating:", "Result:", "Status:"]) {
    assert.ok(markdown.includes(needed), `puzzle-review.md mentions ${needed}`);
  }
});

test("the three book questions appear verbatim in docs/abduction.md and in puzzle-review.md", () => {
  const book = normalise(read("docs/abduction.md"));
  const review = normalise(read("harness/skills/roles/puzzle-review.md"));
  for (const question of BOOK_QUESTIONS) {
    assert.ok(book.includes(normalise(question)), `the book states: ${question}`);
    assert.ok(review.includes(normalise(question)), `puzzle-review.md quotes: ${question}`);
  }
});

test("puzzle-review forbids analysis and keeps the reviewer independent", () => {
  const prose = read("harness/skills/roles/puzzle-review.md").replace(/\s+/g, " ");
  for (const needed of [
    "No analysis",
    "no scripts",
    "no dataset reads",
    "Phase 3 must check:",
    "strongest rival account",
    "existing theory already explains",
    "Data-character check",
    "Known-result check",
    "ALL findings only under `## Findings`",
    "never read another review",
    "write tool",
    "spell paths in full",
    "without pipes",
    "same severity",
  ]) {
    assert.ok(prose.includes(needed), `puzzle-review.md says ${needed}`);
  }
  assert.match(prose, /plausibility `fails`/i, "a breakdown is plausibility fails");
  assert.match(prose, /never read under `owners\/`/i, "a reviewer never reads owner files");
});

test("puzzle-generate grounds the card and parks when no puzzle exists", () => {
  const prose = read("harness/skills/roles/puzzle-generate.md").replace(/\s+/g, " ");
  for (const needed of [
    "RECOMMEND_PARK",
    "check-citations",
    "data-character.md",
    "glossary.md",
    "never the dataset",
    "No scripts, no counts",
    "known result",
    "T04",
    "T10",
  ]) {
    assert.ok(prose.includes(needed), `puzzle-generate.md says ${needed}`);
  }
});

test("puzzle-evolve reads the parent's card and merge, and freezes the parent", () => {
  const prose = read("harness/skills/roles/puzzle-evolve.md").replace(/\s+/g, " ");
  for (const needed of [
    "workspace/puzzle.md",
    "workspace/reviews/merged.md",
    "meta-review",
    "parent is frozen",
    "combination",
    "check-citations",
    "No scripts, no counts",
  ]) {
    assert.ok(prose.includes(needed), `puzzle-evolve.md says ${needed}`);
  }
});

test("the design spec follows the Phase 2 design's §10 edits", () => {
  const spec = read("docs/superpowers/specs/2026-10-12-ctc-research-factory-design.md");
  const phase2 = spec.slice(spec.indexOf("### Phase 2: Puzzles"), spec.indexOf("### Phase 3: Explanations"));
  for (const criterion of ["fit", "plausibility", "relevance"]) {
    assert.match(phase2, new RegExp(criterion), `§6 Phase 2 names ${criterion}`);
  }
  assert.match(phase2, /Tavory & Timmermans/, "§6 Phase 2 names the book's criteria");
  assert.match(phase2, /Phase 1's evidence/, "step 2 judges fit against Phase 1's evidence");
  assert.match(phase2, /may not reopen Phase 1/, "step 5 forbids reopening Phase 1");
  assert.match(phase2, /no fixed number/i, "promotion has no fixed number");

  const tournament = spec.slice(spec.indexOf("### 7.1 Tournament mechanics"), spec.indexOf("### 7.2 Sibling distinctness"));
  assert.match(tournament, /judgeModel/, "§7.1 names the judgeModel config key");
  assert.match(tournament, /`promote` tool/, "§7.1 says promotion is code-gated through promote");
  assert.match(tournament, /three-part stopping rule/, "§7.1 names the plateau/stopping rule");
  assert.match(tournament, /fit, plausibility and relevance/, "§7.1 uses the three criteria for puzzles");
});

test("the reviewer slot comes from the task text, not the shared brief", () => {
  const owner = normalise(read("harness/skills/phase-2/SKILL.md"));
  assert.match(owner, /your task text names your slot/i, "the owner skill says the task text names the slot");
  assert.match(owner, /the brief never names a slot/i, "the owner skill says the brief does not name it");

  const role = normalise(read("harness/skills/roles/puzzle-review.md"));
  assert.match(role, /your task text names the slot/i, "the review role says the task text names the slot");
  assert.match(role, /the brief never names a slot/i, "the review role says the brief does not name it");

  const agent = normalise(read("harness/agents/ctc-reviewer.md"));
  assert.match(agent, /your task text names which review you write/i, "the reviewer agent says the task text names the file");
  assert.match(agent, /does not name your output slot/i, "the reviewer agent says the brief does not name the file");
});

test("every evolution round teaches the seven-identity minimum", () => {
  const body = normalise(read("harness/skills/phase-2/SKILL.md"));
  assert.match(body, /at least 7 identities in total — entrants plus children/);
  assert.match(body, /a fresh child must play 6 matches,? and two puzzles meet only once per round/i);
  assert.match(body, /the previous round's top 8/);
  assert.match(body, /count `entrants \+ children` before you/);
  assert.match(body, /The `Ruling:` records the count/);

  const example = /judge_round\(\{ round: 1, entrants: \[([^\]]+)\], pairs:/.exec(body);
  assert.ok(example, "the evolution example is a round-1 judge_round call");
  assert.ok((example[1] as string).match(/P\d+/g)?.length === 8, "the example names the top 8 as entrants, so the round has nine identities");
});

test("the Phase 2 design requires seven identities in a later round", () => {
  const design = normalise(read("docs/superpowers/specs/2026-10-21-ctc-phase2-puzzles-design.md"));
  assert.match(design, /at least 7 identities in total \(children plus incumbents\)/);
  assert.match(design, /a fresh child must play 6 matches and two puzzles meet once per round/);
});

test("an owner ruling cannot fake the STOP that promotion needs", () => {
  const body = normalise(read("harness/skills/phase-2/SKILL.md"));
  assert.match(body, /records no STOP/, "the skill says a ruling records no STOP");
  assert.match(body, /`loop truncated: no STOP recorded, nothing promotable`/);
  assert.match(body, /park every puzzle `no STOP reached`/);
  assert.match(body, /rounds funded: round 0 plus <N> evolution rounds/, "the budget ruling states how many rounds it funds");
  assert.match(body, /Fund the whole cap as §0 says \(round 0 plus up to four evolution rounds\): anything less may leave no code STOP, and then nothing is promotable/);
  assert.doesNotMatch(body, /at least one evolution round that can reach a code STOP/);
  assert.doesNotMatch(body, /round 4 is the bounded cap/);

  const design = normalise(read("docs/superpowers/specs/2026-10-21-ctc-phase2-puzzles-design.md"));
  assert.match(design, /an early stop by ruling records no STOP, so nothing is promotable/);
  assert.doesNotMatch(design, /may stop early by ruling/);
});

test("the evolution child brief names the move, round, lens and both combination parents", () => {
  const body = normalise(read("harness/skills/phase-2/SKILL.md"));
  assert.match(body, /\*\*Role:\*\* evolution worker for `<P\.\.>` — move `<grounding\|simplification\|out-of-the-box\|combination>`, round `<n>`, lens `<lens>`/);
  assert.match(body, /for a \*\*combination\*\*, \*\*both parents'\*\* `workspace\/puzzle\.md` and `workspace\/reviews\/merged\.md`/);
  assert.match(body, /meta-review-<n-1>\.md/);
  assert.match(body, /pattern's evidence at the absolute paths/);
});

test("a failed review is re-dispatched under a stated cap and then parked", () => {
  const body = normalise(read("harness/skills/phase-2/SKILL.md"));
  assert.match(body, /re-dispatch \*\*only that reviewer\*\*/);
  assert.match(body, /up to 2 times, then once with a fresh `ctc-reviewer`/);
  assert.match(body, /park the puzzle `review-failed: <why>`/);
  assert.match(body, /same cap applies when `reviewBlocked` is set/);
});

test("the review and card roles forbid wrapping the deliverable in a fence", () => {
  const review = normalise(read("harness/skills/roles/puzzle-review.md"));
  assert.match(review, /write the file's content, not a code fence around it/);
  assert.match(review, /the closing fence would become the last line/);
  assert.match(review, /spell paths in full in your bash commands — a review is free prose/);
  for (const role of ["puzzle-generate", "puzzle-evolve"]) {
    const prose = normalise(read(`harness/skills/roles/${role}.md`));
    assert.match(prose, /do not wrap them in a code fence/, `${role}.md warns against copying the fence`);
  }
});

test("Phase 2 states the real puzzle status and the Phase 0 absolute paths", () => {
  const body = normalise(read("harness/skills/phase-2/SKILL.md"));
  assert.match(body, /there is no `promoted` status to set/);
  assert.match(body, /moves a submitted puzzle to phase 3 as `ready`/);
  assert.match(body, /absolute paths `manifest\.md` names/);
  assert.match(body, /starts with neither `DONE`\/`DONE_WITH_CONCERNS` nor `RECOMMEND_PARK`\/`BLOCKED`/);
  assert.match(body, /still enters the round-0 pool/);
  assert.match(body, /it names the run id from the dispatch receipt/);
  assert.match(body, /refuses an empty `pairs` list/);
});

test("promotion and distinctness use the latest round's scores and real files", () => {
  const body = normalise(read("harness/skills/phase-2/SKILL.md"));
  assert.match(body, /Every id needs a Bradley-Terry score in the latest recorded round/);
  assert.match(body, /has files under `workspace\/scripts\/` or `workspace\/results\/` \(an empty directory passes\)/);
});

test("the design spec no longer lets Phase 2 run analyses", () => {
  const spec = normalise(read("docs/superpowers/specs/2026-10-12-ctc-research-factory-design.md"));
  assert.match(spec, /Phase 1 may use small analyses only; Phase 2 runs none \(its evidence is Phase 1's cards\)/);
  assert.doesNotMatch(spec, /Phases 1–2 may use small analyses/);
});


test("the review role's worked example parses cleanly and rates the criteria differently", () => {
  const markdown = read("harness/skills/roles/puzzle-review.md");
  const start = markdown.indexOf("BEGIN REVIEW EXAMPLE\n");
  const end = markdown.indexOf("END REVIEW EXAMPLE", start);
  assert.ok(start >= 0 && end > start, "the role marks its worked example with BEGIN/END");
  const example = markdown.slice(start + "BEGIN REVIEW EXAMPLE\n".length, end).trim();

  assert.deepEqual(reviewProblems(example), [], "the worked example is a valid review");
  const parsed = parseReview(example);
  assert.ok(parsed !== null, "parseReview accepts the worked example");
  assert.deepEqual(parsed.criteria, { fit: "weak", plausibility: "adequate", relevance: "strong" });
  assert.equal(parsed.dataCharacter, "ok");
  assert.equal(parsed.knownResult, "ok");
  assert.equal(parsed.findings.length, 3, "the example has one finding per severity");
  assert.deepEqual(parsed.findings.map((finding) => finding.severity), ["blocking", "major", "minor"]);
  assert.equal(parsed.status, "DONE");
  assert.ok(parsed.phase3MustCheck.length >= 2, "the example has a Phase 3 list");

  const prose = normalise(markdown);
  assert.match(prose, /its values are ILLUSTRATIVE and must be replaced by your own judgement/);
  assert.match(prose, /The file stops at the `Status:` line — add nothing after it/);
});

test("Phase 2's budget funds round 0 plus four evolution rounds", () => {
  const body = normalise(read("harness/skills/phase-2/SKILL.md"));
  assert.match(body, /Budget round 0 plus up to four evolution rounds/);
  assert.match(body, /the cap at round 4 is the only point where a code STOP is guaranteed/);
  assert.match(body, /funds fewer than four can end in `CONTINUE` with no STOP/);
  assert.match(body, /generation and reviews are hours at concurrency 4/);
  assert.match(body, /each judge round is the engine's 8-minute stretches repeated/);
  assert.match(body, /each evolution round adds its children, their two reviews and a judge round/);
  assert.match(body, /rounds funded: round 0 plus <N> evolution rounds/);
});

test("the reviewer recovery cap overrides phase-owner's and a breakdown stays in the pool", () => {
  const body = normalise(read("harness/skills/phase-2/SKILL.md"));
  assert.match(body, /This cap \(2 re-dispatches plus 1 fresh reviewer\) overrides phase-owner's fix-loop cap here/);
  assert.match(body, /rate plausibility `fails` — a breakdown — \*\*still enters the round-0 pool\*\*/);
  assert.doesNotMatch(body, /breakdown or a restatement/);
});

test("the Phase 2 design has no promoted status", () => {
  const design = normalise(read("docs/superpowers/specs/2026-10-21-ctc-phase2-puzzles-design.md"));
  assert.match(design, /there is no `promoted` status/);
  assert.doesNotMatch(design, /→ promoted/);
});

test("the reviewer agent attaches the free-prose rule to bash paths", () => {
  const agent = normalise(read("harness/agents/ctc-reviewer.md"));
  assert.match(agent, /Spell paths in full in your bash commands — a review is free prose — and never combine/);
  const role = normalise(read("harness/skills/roles/puzzle-review.md"));
  assert.match(role, /The rules for bash: spell paths in full in your bash commands/);
});

test("the close step parks every non-promoted puzzle, including never-submitted ones", () => {
  const body = normalise(read("harness/skills/phase-2/SKILL.md"));
  assert.match(body, /park — as part of this same last step — \*\*every Phase 2 puzzle that is not promoted\*\*/);
  assert.match(body, /including one you created but never submitted/);
  assert.match(body, /The run cannot finish while any puzzle is `ready`/);
  assert.match(body, /`created but never submitted`/);
});

test("the skill does not send the owner to read a whole round file", () => {
  const body = normalise(read("harness/skills/phase-2/SKILL.md"));
  assert.match(body, /Do \*\*not\*\* `read` the whole round file/);
  assert.match(body, /150–260 KB and `read` truncates it/);
  assert.match(body, /jq -c '\.fit\.scores, \.fit\.lower, \.fit\.upper, \.played'/);
  assert.doesNotMatch(body, /2\. Read the final round file/);
});

test("a restarted owner rebuilds a partial round's arguments from the match log", () => {
  const body = normalise(read("harness/skills/phase-2/SKILL.md"));
  assert.match(body, /round-<n>\.matches\.jsonl` exists without `round-<n>\.json`/);
  assert.match(body, /first line \(the header names the seed and every entrant id\)/);
  assert.match(body, /`"batch":-1` lines \(the forced child\/parent pairs\)/);
  assert.match(body, /call `judge_round` with exactly those arguments/);
  assert.match(body, /Never move the log aside unless `judge_round` refuses with a clear header mismatch/);
});

test("an empty break list still has a taught ruling", () => {
  const body = normalise(read("harness/skills/phase-2/SKILL.md"));
  assert.match(body, /If `breaks` is empty, either promote nothing or promote the top k by score/);
  assert.match(body, /say in the ruling that the intervals overlap/);
});

test("the Phase 0 caveat sources are ordered, with the git note only a pointer", () => {
  const body = normalise(read("harness/skills/phase-2/SKILL.md"));
  assert.match(body, /caveats, in order of reliability: the Phase 0 input node's/);
  assert.match(body, /`handoff\.md` and its `workspace\/summary\.md` first/);
  assert.match(body, /is only a pointer — in `runs\/gl1` it says "Phase 1 complete…" and carries no caveat/);
});

test("the owner is told to check and revive a dead async subagent", () => {
  const body = normalise(read("harness/skills/phase-2/SKILL.md"));
  assert.match(body, /killed by a provider error \(429\/503\)/);
  assert.match(body, /after about 15 minutes, check the dispatched run id/);
  assert.match(body, /subagent\(\{ action: "status", id \}\)/);
  assert.match(body, /`resume` it \(the same session\) or re-dispatch it/);
  assert.match(body, /record the outcome in the ledger/);
});

test("a combination child's card carries the second parent's evidence itself", () => {
  const evolve = normalise(read("harness/skills/roles/puzzle-evolve.md"));
  assert.match(evolve, /The judge sees a child behind the pattern it sits under and nothing else/);
  assert.match(evolve, /the second parent's claims and evidence must appear in this card itself/);
  assert.match(evolve, /never see the second pattern's Measure, Result, Verdict or Worst fits/);
});

test("the worker and reviewer agents leave their model to the run config", () => {
  for (const file of ["harness/agents/ctc-worker.md", "harness/agents/ctc-reviewer.md"]) {
    assert.ok(!("model" in frontmatter(read(file))), `${file} has no model: frontmatter line`);
  }
});

test("every subagent dispatch in the skills names the model it runs on", () => {
  const dispatches: string[] = [];
  for (const file of readdirSync(SKILLS, { recursive: true })) {
    if (!file.endsWith(".md")) continue;
    for (const line of readFileSync(path.join(SKILLS, file), "utf8").split("\n")) {
      if (line.includes("subagent({ agent:")) dispatches.push(`${file}: ${line.trim()}`);
    }
  }
  assert.ok(dispatches.length > 0, "the skills dispatch subagents");
  for (const dispatch of dispatches) {
    assert.match(dispatch, /\bmodel: "/, `names a model: ${dispatch}`);
  }
});

// ---------------------------------------------------------------------------
// Phase 3: the explanation loop's skill and its three role files.

const PHASE3_ROLES = ["explain-analysis", "explain-literature", "explain-review"];

/** The literal strings of a `const NAME = [ ... ];` array in a source file. */
function sourceStrings(file: string, name: string): string[] {
  const match = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(read(file));
  assert.ok(match, `${file} declares ${name}`);
  return [...(match[1] as string).matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

test("phase-3 has the phase-3 frontmatter and describes the explanation loop", () => {
  const file = "harness/skills/phase-3/SKILL.md";
  assert.ok(existsSync(path.join(HARNESS_ROOT, file)), `${file} exists`);
  const markdown = read(file);
  const fields = frontmatter(markdown);
  assert.equal(fields.name, "phase-3");
  assert.match(fields.description ?? "", /Phase 3/);
  assert.match(fields.description ?? "", /explanation/);

  const body = markdown.slice(markdown.indexOf("\n---\n") + 5);
  for (const needed of [
    "tree_list",
    "tree_create",
    "tree_update",
    "open_round",
    "close_round",
    "archive_script",
    "reproduce",
    "submit",
    "check-argument.ts",
    "tasks/lit-",
    "input",
    "Ruling:",
    "two consecutive",
    "cwd",
    "ctc-reviewer",
    "ctc-worker",
    "brief-review.md",
    "revision.md",
    "data-requests.md",
    "rounds.json",
    "roundCap",
    "must-check.md",
    "## Questions",
    "### Task <L>: <aim>",
    "Alternatives considered",
    "Contribution:",
    "Predictions",
    "preregistration",
    "assets.R",
  ]) {
    assert.ok(body.includes(needed), `the body mentions ${needed}`);
  }
  const prose = normalise(body);
  assert.match(prose, /literature workers? (run|are dispatched) \*\*after\*\* the analysis workers/i, "literature runs after analysis");
  assert.match(prose, /never in parallel with them/i, "literature is never parallel with analysis");
  assert.match(prose, /nothing is fetched|never fetch/i, "nothing is fetched");
  assert.match(prose, /never dispatched/i, "the explanation node is never dispatched");
  assert.match(prose, /absolute paths/i, "workers are told to use absolute paths");
  assert.match(prose, /greatest letter|highest letter|last letter/i, "the assets job gets the last letter");
  assert.match(prose, /records no STOP/i, "an early stop by ruling records no STOP");
  assert.match(prose, /call it again|call `reproduce` again/i, "reproduce PARTIAL is repeated");
});

test("every Phase 3 role file exists and is named by absolute path in the skill", () => {
  const body = read("harness/skills/phase-3/SKILL.md");
  for (const role of PHASE3_ROLES) {
    const file = path.join(SKILLS, "roles", `${role}.md`);
    assert.ok(existsSync(file), `${file} exists`);
    const markdown = readFileSync(file, "utf8");
    assert.match(frontmatter(markdown).name ?? "", new RegExp(role), `${role}.md names itself`);
    assert.ok(body.includes(file), `phase-3's Skill lines use the absolute path ${file}`);
  }
});

test("the Phase 3 skills only name tool and skill paths that exist", () => {
  const files = ["harness/skills/phase-3/SKILL.md", ...PHASE3_ROLES.map((role) => `harness/skills/roles/${role}.md`)];
  const named = new Set<string>();
  for (const file of files) {
    for (const match of read(file).matchAll(/harness\/(?:tools|skills)\/[\w./-]+\.(?:ts|md)/g)) named.add(match[0]);
  }
  for (const file of ["harness/tools/check-argument.ts", "harness/tools/check-citations.ts", "harness/skills/roles/deepis.md"]) {
    assert.ok(named.has(file), `a Phase 3 skill names ${file}`);
  }
  for (const file of named) assert.ok(existsSync(path.join(HARNESS_ROOT, file)), `${file} exists`);
});

test("every tool the Phase 3 skill calls is registered by the owner extension", () => {
  const registered = new Set([...read("harness/owner-extension.ts").matchAll(/registerTool\(\{\s*name: "(\w+)"/g)].map((m) => m[1] as string));
  for (const tool of ["open_round", "close_round", "archive_script", "reproduce", "submit", "tree_list", "tree_create", "tree_update"]) {
    assert.ok(registered.has(tool), `owner-extension registers ${tool}`);
  }
  const body = read("harness/skills/phase-3/SKILL.md");
  for (const tool of ["open_round", "close_round", "archive_script", "reproduce", "submit"]) {
    assert.ok(new RegExp(`\\b${tool}\\(\\{`).test(body), `the skill shows a ${tool}({ ... }) call`);
  }
  // Every `name({` call in the skill that looks like a tool is a registered one (subagent is pi's own).
  for (const match of body.matchAll(/\b([a-z]+(?:_[a-z]+)+)\(\{/g)) {
    const tool = match[1] as string;
    assert.ok(registered.has(tool), `${tool} is a registered owner tool`);
  }
  // The worker's tool is registered by the worker extension.
  const worker = read("harness/worker-extension.ts");
  assert.match(worker, /name: "run_analysis"/);
  for (const role of ["explain-analysis"]) assert.ok(read(`harness/skills/roles/${role}.md`).includes("run_analysis"), `${role}.md names run_analysis`);
});

test("the Phase 3 owner calls use the parameter names the tools declare", () => {
  const source = read("harness/owner-extension.ts");
  const params = (name: string): string[] => {
    const block = new RegExp(`const ${name} = Type\\.Object\\(\\{([\\s\\S]*?)\\n\\}\\);`).exec(source);
    assert.ok(block, `${name} is declared`);
    return [...(block[1] as string).matchAll(/^  (\w+): /gm)].map((m) => m[1] as string);
  };
  const body = read("harness/skills/phase-3/SKILL.md");
  const calls: Record<string, string> = {
    open_round: "OpenRoundParams",
    close_round: "CloseRoundParams",
    archive_script: "ArchiveScriptParams",
    reproduce: "ReproduceParams",
    submit: "SubmitParams",
  };
  for (const [tool, declared] of Object.entries(calls)) {
    const call = new RegExp(`${tool}\\(\\{([^}]*)\\}\\)`).exec(body);
    assert.ok(call, `the skill shows ${tool}({ ... })`);
    const used = [...(call[1] as string).matchAll(/(\w+):/g)].map((m) => m[1] as string);
    for (const name of used) assert.ok(params(declared).includes(name), `${tool} has a parameter ${name}`);
    for (const name of params(declared).filter((p) => p !== "note")) assert.ok(used.includes(name), `the ${tool} example passes ${name}`);
  }
});

test("the argument and report headings the roles name are the ones check-argument.ts checks", () => {
  const argumentHeadings = sourceStrings("harness/tools/check-argument.ts", "ARGUMENT_HEADINGS");
  const reportHeadings = sourceStrings("harness/tools/check-argument.ts", "REPORT_HEADINGS");
  const reviewHeadings = sourceStrings("harness/tools/check-argument.ts", "REVIEW_HEADINGS");
  assert.equal(argumentHeadings.length, 7);
  assert.equal(reportHeadings.length, 6);
  assert.equal(reviewHeadings.length, 5);

  const skill = read("harness/skills/phase-3/SKILL.md");
  for (const heading of argumentHeadings) assert.ok(skill.includes(heading), `phase-3 names the argument heading ${heading}`);
  for (const heading of reportHeadings) {
    assert.ok(read("harness/skills/roles/explain-literature.md").includes(heading), `explain-literature.md names ${heading}`);
  }
  for (const heading of reviewHeadings) {
    assert.ok(read("harness/skills/roles/explain-review.md").includes(heading), `explain-review.md names ${heading}`);
  }
  // Every `## ` heading a role file shows is one check-argument knows, or one of the file's own structural headings.
  const known = new Set([...argumentHeadings, ...reportHeadings, ...reviewHeadings]);
  for (const role of ["explain-literature", "explain-review"]) {
    const headings = [...read(`harness/skills/roles/${role}.md`).matchAll(/^## .+$/gm)].map((m) => m[0]);
    assert.ok(headings.length > 6, `${role}.md has headings`);
    for (const heading of headings) {
      if (heading === "## Definition of Done" || /^## \d+\. /.test(heading)) continue;
      assert.ok(known.has(heading), `${role}.md heading ${heading} is not one check-argument.ts checks`);
    }
  }
});

test("explain-analysis teaches one task, one letter, the helpers and the data-request heading", () => {
  const prose = normalise(read("harness/skills/roles/explain-analysis.md"));
  for (const needed of [
    "run_analysis",
    "save_numbers",
    "Data requests:",
    "source(\"/opt/ctc/ctc.R\")",
    "import ctc",
    "put_var",
    "write_variables",
    "assets.R",
    "absolute path",
    "never overwrite",
    "set.seed",
    "output/numbers/<section>.csv#<key>",
    "bare file name",
    "no network",
    "hold-out",
    "dead end",
  ]) {
    assert.ok(prose.includes(needed), `explain-analysis.md says ${needed}`);
  }
  assert.match(prose, /never (name|read|write)[^.]*dataset/i, "the dataset root is off limits");
});

test("explain-literature writes the round report and asks for rivals and artifacts", () => {
  const prose = normalise(read("harness/skills/roles/explain-literature.md"));
  for (const needed of [
    "Round:",
    "workspace/reports/",
    "check-citations",
    "chunk id",
    "verbatim",
    "rival",
    "artifact",
    "precedent",
    "roles/deepis.md",
    "Status:",
  ]) {
    assert.ok(prose.includes(needed), `explain-literature.md says ${needed}`);
  }
});

test("explain-review is a report, not a score, with the finding and status formats", () => {
  const prose = normalise(read("harness/skills/roles/explain-review.md"));
  for (const needed of [
    "Result: ok|concerns",
    "- [F<n>] [blocking|major|minor]",
    "Status: DONE",
    "workspace/reviews/report.md",
    "not a score",
    "no analysis",
    "never read",
    "owners/",
    "check-citations",
    "output/numbers/",
    "Result:",
  ]) {
    assert.ok(prose.includes(needed), `explain-review.md says ${needed}`);
  }
});

test("the design spec follows the Phase 3 design's §12 edits", () => {
  const spec = read("docs/superpowers/specs/2026-10-12-ctc-research-factory-design.md");
  const phase3 = spec.slice(spec.indexOf("### Phase 3: Explanations"), spec.indexOf("### Phase 4: Writing"));
  assert.ok(phase3.length > 100, "found the Phase 3 section");
  assert.doesNotMatch(phase3, /Explanation tournament/i, "no explanation tournament");
  assert.doesNotMatch(phase3, /proposal tournament/i, "no proposal tournament");
  assert.doesNotMatch(phase3, /Propose rivals/i, "no rival proposals");
  assert.doesNotMatch(phase3, /unlock the hold-out for this node only/i, "no per-node unlock");
  assert.match(phase3, /Phase 5/, "Phase 3 names the single Phase 5 hold-out unlock");
  assert.match(phase3, /two consecutive/i, "Phase 3 names the stop rule");
  assert.match(phase3, /check-argument/, "Phase 3 names the end gate");

  const phase5 = spec.slice(spec.indexOf("### Phase 5: Review and evaluation"), spec.indexOf("## 7. Tournaments"));
  assert.match(phase5, /hold-out/i, "Phase 5 holds the single hold-out unlock");

  const pools = spec.slice(spec.indexOf("- **Pools:**"), spec.indexOf("- **Ratings:**"));
  assert.doesNotMatch(pools, /explanation proposals within a puzzle/);
  assert.doesNotMatch(pools, /explanations within a puzzle/);
  assert.doesNotMatch(spec, /\*Explanations:\* plausibility, coherence/);

  const integrity = spec.slice(spec.indexOf("## 8. Integrity checks"), spec.indexOf("## 9. Integrating"));
  assert.doesNotMatch(integrity, /per node and logged/i, "hold-out discipline is no longer per node");
  assert.match(integrity, /Phase 5/, "hold-out discipline names Phase 5");
  assert.match(integrity, /analysis container/i, "sandboxing names the analysis container");
});

test("explain-review's worked example is a report the code accepts, and its findings can be ruled on", () => {
  const markdown = read("harness/skills/roles/explain-review.md");
  const start = markdown.indexOf("BEGIN REPORT EXAMPLE\n");
  const end = markdown.indexOf("END REPORT EXAMPLE", start);
  assert.ok(start >= 0 && end > start, "the role marks its worked example with BEGIN/END");
  const example = markdown.slice(start + "BEGIN REPORT EXAMPLE\n".length, end).trim();

  const parsed = parseReport(example);
  assert.ok(parsed !== null, "parseReport accepts the worked example");
  assert.equal(parsed.status, "DONE");
  assert.deepEqual(parsed.findings.map((finding) => finding.id), ["F1", "F2", "F3"]);
  assert.deepEqual(parsed.findings.map((finding) => finding.severity), ["major", "blocking", "minor"]);
  // Each of the four checks opens with a Result: line.
  for (const heading of ["Citation fidelity", "Number provenance", "Overclaiming", "Abductive honesty"]) {
    const body = example.slice(example.indexOf(`## ${heading}`)).split("\n").slice(1).find((line) => line.trim() !== "");
    assert.match(body ?? "", /^Result: (ok|concerns)\b/, `${heading} opens with Result:`);
  }
  const revision = "F1: taken — cited a chunk about the same platform\nF2: overruled — the boundary is already stated in Limitations\nF3: taken — reworded\n";
  assert.deepEqual(checkRevision(parsed.findings, revision), []);
  assert.deepEqual(checkRevision(parsed.findings, "F1: taken — x\n"), ["revision.md has no ruling for F2", "revision.md has no ruling for F3"]);
  assert.match(normalise(read("harness/skills/phase-3/SKILL.md")), /F<n>: taken — <what changed>.*F<n>: overruled — <reason>/);
});

test("the agent files carry the explanation-node overrides", () => {
  const worker = normalise(read("harness/agents/ctc-worker.md"));
  assert.match(worker, /working directory is a task folder of an explanation node \(`…\/tasks\/<L>\/` or `…\/tasks\/lit-<NN>\/`\)/);
  assert.match(worker, /your handoff is `handoff\.md` in that folder/);
  assert.match(worker, /ABSOLUTE paths your brief names/);
  assert.match(worker, /a relative `workspace\/` would land inside the task folder, and `rounds\.md` is not used/);
  const reviewer = normalise(read("harness/agents/ctc-reviewer.md"));
  assert.match(reviewer, /working directory is an explanation node/);
  assert.match(reviewer, /overrides the Phase 2 wording here \(one puzzle, `a\.md`\/`b\.md`, `Phase 3 must check:`\)/);
  assert.match(reviewer, /`workspace\/reviews\/report\.md`/);
});

test("the reviewer's Status line is bare, and the code rejects anything else", () => {
  const role = normalise(read("harness/skills/roles/explain-review.md"));
  assert.match(role, /is \*\*bare\*\*: exactly `Status: DONE`, `Status: DONE_WITH_CONCERNS` or `Status: BLOCKED`, nothing after it/);
  assert.match(role, /what you could not check goes in the relevant check section/i);
  const example = read("harness/skills/roles/explain-review.md");
  const body = example.slice(example.indexOf("BEGIN REPORT EXAMPLE\n") + "BEGIN REPORT EXAMPLE\n".length, example.indexOf("END REPORT EXAMPLE")).trim();
  assert.ok(parseReport(body) !== null, "the bare form parses");
  const withStatus = (status: string): string => body.replace(/Status: DONE$/, status);
  for (const bad of ["Status: DONE_WITH_CONCERNS (could not check)", "Status: BLOCKED — deepis down", "**Status: DONE**"]) {
    assert.equal(parseReport(withStatus(bad)), null, `${bad} is malformed`);
  }
  for (const good of ["Status: DONE_WITH_CONCERNS", "Status: BLOCKED"]) {
    assert.ok(parseReport(withStatus(good)) !== null, `${good} parses`);
  }
});

test("the Phase 3 skill closes a round that cannot finish, and ranks the two caps", () => {
  const body = normalise(read("harness/skills/phase-3/SKILL.md"));
  assert.match(body, /you cannot drop a task from the plan and you cannot write a handoff yourself/);
  assert.match(body, /one more fresh worker whose only job is to close the task\*\* with `Status: DONE_WITH_CONCERNS`, stating exactly what could not be done/);
  assert.match(body, /park the explanation and its puzzle/);
  assert.match(body, /This cap \(2 re-dispatches plus 1 fresh reviewer\) overrides phase-owner's fix-loop cap here/);
  assert.match(body, /closes `Status: BLOCKED`/);
  assert.match(body, /at most 4 lettered tasks per round, the assets task included/);
  assert.match(body, /call `close_round` again with the same arguments/);
  assert.match(body, /already `ready` in Phase 4 \(it was submitted\): then only close the puzzle input node/);
  assert.match(body, /`tasks\/lit-<NN2>` with `NN2` = 50 \+ the round number/);
  assert.match(body, /still the \*\*real round number\*\*/);
  assert.match(body, /cwd: "<node dir>\/tasks\/lit-51"/);
  assert.match(body, /pattern's `<pattern node dir>\/handoff\.md`/);
});

test("the Phase 3 skill moves every queued puzzle to input at the start and works one at a time", () => {
  const skill = normalise(read("harness/skills/phase-3/SKILL.md"));
  assert.match(skill, /\*\*At the very start, before anything else, move every queued phase-3 puzzle to `input`/);
  assert.match(skill, /so that none stays `ready`/);
  assert.match(skill, /a `ready` puzzle makes the supervisor nudge you while your workers run/);
  assert.match(skill, /An `input` puzzle with no explanation under it is queued/);
  assert.match(skill, /work \*\*one puzzle at a time\*\*/);
  assert.match(skill, /the cap of 4 active workers still holds/);
});

test("the assets task keeps earlier variables across rounds, in one language", () => {
  const skill = normalise(read("harness/skills/phase-3/SKILL.md"));
  assert.match(skill, /reads the existing assets script first and keeps every earlier variable and table fragment/);
  assert.match(skill, /keeps the language of the existing assets script \(never both `assets\.R` and `assets\.py`\)/);
  assert.match(skill, /the one exception to "never overwrite"/);
  assert.match(skill, /only the \*\*highest-lettered\*\* task's worker/);
  const role = normalise(read("harness/skills/roles/explain-analysis.md"));
  assert.match(role, /read it first, \*\*keep its language\*\*/);
  assert.match(role, /Rewriting it is the one exception to never-overwrite/);
  assert.match(role, /the assets script instead ends with `write_variables\(\)`, need not call `save_numbers`/);
  assert.match(normalise(read("harness/skills/roles/explain-literature.md")), /refuses any bash command that contains the word `hold-out`[^.]*a `deepis` query included/);
  assert.match(normalise(read("harness/skills/roles/explain-literature.md")), /`lit-51` writes `reports\/51\.md`/);
});

test("the paths the Phase 3 skill and roles name pass the guards", (t) => {
  const run = mkdtempSync(path.join(tmpdir(), "ctc-skill-guards-"));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  const puzzle = path.join(run, "patterns", "T01-p", "puzzles", "P01-q");
  const node = path.join(puzzle, "explanations", "E01-x");
  const pattern = path.join(run, "patterns", "T01-p");
  mkdirSync(path.join(node, "workspace", "scripts"), { recursive: true });
  for (const task of ["A", "B", "C", "D", "lit-01", "lit-51"]) mkdirSync(path.join(node, "tasks", task), { recursive: true });
  mkdirSync(path.join(pattern, "workspace"), { recursive: true });
  for (const file of [path.join(pattern, "workspace", "pattern.md"), path.join(pattern, "workspace", "measure.md"), path.join(pattern, "handoff.md")]) {
    writeFileSync(file, "x\n");
  }
  const w = (task: string, file: string): boolean => explanationWorkerMayWrite(node, task, path.join(node, ...file.split("/")));

  // The analysis workers: own scripts and handoff by absolute path; the assets script only for the greatest letter.
  assert.equal(taskOf(node, path.join(node, "tasks", "B")), "B");
  assert.ok(w("B", "workspace/scripts/B_01.R") && w("B", "workspace/scripts/B_02.py") && w("B", "tasks/B/handoff.md"));
  assert.ok(!w("B", "workspace/scripts/A_01.R") && !w("B", "workspace/scripts/assets.R") && !w("B", "handoff.md"));
  assert.ok(!w("B", "workspace/argument.md") && !w("B", "workspace/output/numbers/B_01.csv") && !w("B", "workspace/archive/B_01/README.md"));
  assert.ok(!w("B", "workspace/data-requests.md") && !w("B", "workspace/reviews/revision.md") && !w("B", "workspace/scripts/helper.R"));
  assert.ok(w("D", "workspace/scripts/assets.R") && w("D", "workspace/scripts/assets.py") && !w("C", "workspace/scripts/assets.R"));
  mkdirSync(path.join(node, "tasks", "E"));
  assert.ok(w("E", "workspace/scripts/assets.R") && !w("D", "workspace/scripts/assets.R"), "a later round's higher letter takes the assets script");
  // A relative workspace/ lands inside the task folder: allowed by the guard, so the skill must (and does) say absolute paths.
  assert.ok(explanationWorkerMayWrite(node, "A", path.join(node, "tasks", "A", "workspace", "scripts", "A_01.R")));
  assert.match(read("harness/skills/phase-3/SKILL.md"), /use absolute paths/i);
  // The literature workers: their numbered report and handoff only; the second worker's `lit-51` writes reports/51.md.
  assert.ok(w("lit-01", "workspace/reports/01.md") && w("lit-01", "tasks/lit-01/handoff.md") && !w("lit-01", "workspace/reports/51.md"));
  assert.ok(w("lit-51", "workspace/reports/51.md") && !w("lit-51", "workspace/reports/01.md") && !w("lit-01", "workspace/scripts/A_01.R"));
  // The owner's own files, and not the code's.
  const o = (file: string): boolean => ownerMayWrite(run, 3, path.join(node, ...file.split("/")));
  for (const file of ["workspace/argument.md", "workspace/reviews/revision.md", "workspace/data-requests.md", "brief-review.md", "tasks/A/brief.md", "tasks/lit-01/brief.md", "tasks/lit-51/brief.md"]) {
    assert.ok(o(file), `the owner writes ${file}`);
  }
  for (const file of ["rounds/01/plan.md", "rounds/01/verdict.md", "tasks/A/handoff.md", "workspace/reviews/report.md", "workspace/scripts/A_01.R"]) {
    assert.ok(!o(file), `the owner does not write ${file}`);
  }
  assert.ok(!ownerMayWrite(run, 3, path.join(run, "owners", "phase-3", "loop", "E01", "rounds.json")));
  assert.ok(ownerMayWrite(run, 3, path.join(run, "owners", "phase-3", "ledger.md")));
  // The reviewer: report.md only, and its check-citations call is allowed.
  assert.ok(reviewerMayWrite(node, path.join(node, "workspace", "reviews", "report.md")));
  assert.ok(!reviewerMayWrite(node, path.join(node, "workspace", "reviews", "revision.md")));
  assert.equal(
    reviewsRefusal("bash", { command: "node ./harness/tools/check-citations.ts workspace/reviews/report.md" }),
    undefined,
  );
  assert.notEqual(reviewsRefusal("read", { path: path.join(node, "workspace", "reviews", "report.md") }), undefined);
  assert.notEqual(ownersRefusal("read", { path: path.join(run, "owners", "phase-3", "ledger.md") }), undefined);
  // The paths the briefs name are readable by workers: the pattern's files, the node's own, and other tasks' handoffs.
  for (const file of [
    path.join(pattern, "workspace", "pattern.md"),
    path.join(pattern, "workspace", "measure.md"),
    path.join(pattern, "handoff.md"),
    path.join(node, "workspace", "puzzle.md"),
    path.join(node, "workspace", "must-check.md"),
    path.join(node, "tasks", "A", "handoff.md"),
    path.join(node, "rounds", "01", "plan.md"),
  ]) {
    assert.equal(siblingRefusal(node, "read", { path: file }), undefined, `${file} is readable`);
    assert.equal(siblingRefusal(node, "read", { path: file }, { allowDerived: false }), undefined, `${file} is readable by the reviewer`);
  }
  // The hold-out word is refused in any bash command, a deepis query included: the literature role warns about it.
  assert.notEqual(holdoutRefusal("bash", { command: 'timeout 60 deepis search "hold-out validation" -n 10' }), undefined);
  assert.equal(holdoutRefusal("bash", { command: 'timeout 60 deepis search "validation sample" -n 10' }), undefined);
});
