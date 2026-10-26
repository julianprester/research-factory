// The paper's outline and its coverage (design §7.1, §8.4). `workspace/outline.md` maps the genre's sections to the
// argument and to the embeds the writer will use, lists every argument link the paper leaves out with a reason, and
// lists the numbers, tables and figures the paper still needs (one reopen request, §5.1).
//
// The format, which Task 13's skills teach:
//   ## Sections     free text
//   ## Omitted      `- <argument link target> — <reason>`, the target as `argument.md` writes it
//   ## Needs        `- <description of the number, table or figure needed>`
//
// A coverage target is an argument link to a number (`output/numbers/<file>.csv#<key>`), a table
// (`output/tables/<name>` or `output/assets/<name>.qmd`) or a figure (`output/figures/<name>`). Links to URLs and to
// other files are not targets. A number is covered when an embedded `{{< var >}}` has a row of the paper's
// `variables_sources.csv` whose source is that target. A table is covered by an include of `embeds/tables/` and a
// figure by an image of `embeds/figures/` whose name matches the target's (its stem, so `A_01.csv` and `A_01.qmd`
// are one table); a target that is embedded and also omitted is a problem.
//
// Everything under the paper's `workspace/` and the explanation's `workspace/` is read without following a link
// (`readRegular`). `coverage` never throws: each failure is a problem line.
import * as path from "node:path";

import { readRegular } from "../explain/rounds.ts";
import { parseCsv } from "../explain/reproduce.ts";
import { argumentLinks } from "../tools/check-argument.ts";
import { maskFences, normaliseHeading } from "../tools/check-puzzle.ts";
import { scanEmbeds } from "./embeds.ts";

export interface Outline {
  sections: string;
  omitted: { target: string; reason: string }[];
  needs: string[];
}

const HEADINGS = ["Sections", "Omitted", "Needs"] as const;
const NUMBER_TARGET = /^output\/numbers\/[^/#\s]+\.csv#.+$/;
const TABLE_TARGET = /^(?:output\/tables\/[^/\s]+|output\/assets\/[^/\s]+\.qmd)$/;
const FIGURE_TARGET = /^output\/figures\/[^/\s]+$/;
const OMISSION_SEPARATOR = /\s*(?:—|--)/;
const NONE = /^none\.?$/i;
const BULLET = /^[-*+]\s+/;
const OUTLINE_PATH = "workspace/outline.md";

/** The outline's three sections, or null when a heading is missing. Headings match as `check-puzzle.ts` matches them. */
export function parseOutline(markdown: string): Outline | null {
  const lines = markdown.split(/\r?\n/);
  const masked = maskFences(markdown);
  const bodies = new Map<(typeof HEADINGS)[number], string[]>();
  let current: string[] | undefined;
  masked.forEach((line, index) => {
    if (/^ {0,3}##\s/.test(line)) {
      const name = normaliseHeading(line.trimStart());
      const found = HEADINGS.find((heading) => name.startsWith(normaliseHeading(`## ${heading}`)));
      if (found === undefined) {
        current = undefined;
        return;
      }
      if (!bodies.has(found)) bodies.set(found, []);
      current = bodies.get(found);
      return;
    }
    current?.push(lines[index] ?? "");
  });
  if (HEADINGS.some((heading) => !bodies.has(heading))) return null;
  const body = (heading: (typeof HEADINGS)[number]): string[] => bodies.get(heading) ?? [];
  const items = (heading: (typeof HEADINGS)[number]): string[] =>
    body(heading)
      .map((line) => line.trim().replace(BULLET, "").trim())
      .filter((line) => line !== "" && !NONE.test(line));

  const omitted = items("Omitted").map((line) => {
    const parts = OMISSION_SEPARATOR.exec(line);
    if (parts === null) return { target: line, reason: "" };
    return { target: line.slice(0, parts.index).trim(), reason: line.slice(parts.index + parts[0].length).trim() };
  });
  return {
    sections: body("Sections").join("\n").trim(),
    omitted,
    needs: items("Needs"),
  };
}

/** The coverage target of an argument link, as the kind the paper must embed it as, or undefined when it is not one. */
function kindOf(target: string): "number" | "table" | "figure" | undefined {
  if (NUMBER_TARGET.test(target)) return "number";
  if (TABLE_TARGET.test(target)) return "table";
  if (FIGURE_TARGET.test(target)) return "figure";
  return undefined;
}

/** A file name without its extension: the name a table or figure is embedded under. */
function stemOf(file: string): string {
  return path.posix.basename(file).replace(/\.[^.]*$/, "");
}

/**
 * The explanation's coverage targets, each embedded in the paper or listed under `## Omitted` with a reason. A
 * target that is neither is a problem naming it; so is an omission that is embedded, has no reason, or names a
 * target the argument does not link. A non-empty `## Needs` is a problem, before a reopen and after one (`pins.reopens` only picks the message).
 * `covered` counts the targets that are embedded or validly omitted.
 */
export function coverage(runDir: string, nodeDir: string): { covered: number; problems: string[] } {
  const paper = path.resolve(nodeDir);
  const explanation = path.dirname(path.dirname(paper));
  const problems: string[] = [];
  try {
    const argument = readRegular(explanation, "workspace/argument.md");
    if (argument === undefined) return { covered: 0, problems: ["the explanation's workspace/argument.md is missing"] };
    const targets = [...new Set(argumentLinks(argument.toString("utf8")).map((link) => link.target))]
      .filter((target) => kindOf(target) !== undefined)
      .sort();

    const outlineBytes = readRegular(paper, OUTLINE_PATH);
    if (outlineBytes === undefined) return { covered: 0, problems: [`${OUTLINE_PATH} is missing`] };
    const outline = parseOutline(outlineBytes.toString("utf8"));
    if (outline === null) {
      return { covered: 0, problems: [`${OUTLINE_PATH} is missing a ## Sections, ## Omitted or ## Needs heading`] };
    }

    const qmdBytes = readRegular(paper, "workspace/paper.qmd");
    const embeds = scanEmbeds(qmdBytes?.toString("utf8") ?? "");
    const sources = sourcesEmbedded(paper, embeds.vars);
    const includes = new Set(embeds.includes.map(stemOf));
    const images = new Set(embeds.images.map(stemOf));
    const isEmbedded = (target: string): boolean => {
      switch (kindOf(target)) {
        case "number":
          return sources.has(target);
        case "table":
          return includes.has(stemOf(target));
        case "figure":
          return images.has(stemOf(target));
        default:
          return false;
      }
    };

    const listed = new Map<string, string>();
    for (const entry of outline.omitted) {
      if (!targets.includes(entry.target)) {
        problems.push(`outline ## Omitted names ${entry.target}, which argument.md does not link as a number, table or figure`);
        continue;
      }
      if (entry.reason === "") problems.push(`outline ## Omitted: ${entry.target} has no reason`);
      if (isEmbedded(entry.target)) {
        problems.push(`outline ## Omitted: ${entry.target} is embedded in paper.qmd, so it is not omitted`);
      }
      if (!listed.has(entry.target) || listed.get(entry.target) === "") listed.set(entry.target, entry.reason);
    }

    let covered = 0;
    for (const target of targets) {
      if (isEmbedded(target)) {
        covered++;
        continue;
      }
      if (listed.has(target)) {
        if (listed.get(target) !== "") covered++;
        continue;
      }
      problems.push(`argument.md links ${target}, which paper.qmd does not embed and ## Omitted does not list`);
    }

    // A non-empty ## Needs blocks at every stage. Before a reopen the needs go out in one request; after one, the writer
    // clears the ones the reopen satisfied, and asks again only if some remain and a reopen is left.
    if (outline.needs.length > 0) {
      problems.push(
        reopensOf(paper) === 0
          ? "outline lists needs: send them in one reopen request"
          : "outline still lists needs: clear the ones the reopen satisfied, reopen again only if some remain and a reopen is left",
      );
    }
    return { covered, problems };
  } catch (error) {
    return { covered: 0, problems: [...problems, `outline check failed: ${message(error)}`] };
  }
}

/** The number targets a paper embeds: the source of each embedded variable's row in its `variables_sources.csv`. */
function sourcesEmbedded(paper: string, vars: string[]): Set<string> {
  const found = new Set<string>();
  if (vars.length === 0) return found;
  const bytes = readRegular(paper, "workspace/variables_sources.csv");
  if (bytes === undefined) return found;
  const [header = [], ...rows] = parseCsv(bytes.toString("utf8"));
  const variableAt = header.indexOf("variable");
  const sourceAt = header.indexOf("source");
  if (variableAt === -1 || sourceAt === -1) return found;
  const wanted = new Set(vars);
  for (const row of rows) {
    if (wanted.has(row[variableAt] ?? "")) found.add(row[sourceAt] ?? "");
  }
  return found;
}

/** The reopen count pinned in `workspace/checks/pins.json`; anything unreadable counts as none (so `## Needs` still blocks). */
function reopensOf(paper: string): number {
  try {
    const bytes = readRegular(paper, "workspace/checks/pins.json");
    if (bytes === undefined) return 0;
    const pins: unknown = JSON.parse(bytes.toString("utf8"));
    const reopens = typeof pins === "object" && pins !== null ? (pins as { reopens?: unknown }).reopens : undefined;
    return typeof reopens === "number" && Number.isInteger(reopens) ? reopens : 0;
  } catch {
    return 0;
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
