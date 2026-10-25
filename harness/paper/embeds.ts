// The embeds a paper names (design §5, §8.1): its `{{< var >}}` keys, its `{{< include >}}` paths, its
// images and its citation keys. `scanEmbeds` reads a Quarto manuscript, and `embedSetDiff` says how two
// scans differ, so a style pass that changes an embed is caught by counts (design §8).
//
// Fenced code, inline code, HTML comments and the YAML front matter are not prose and hold no embeds:
// they are blanked line by line first, so every line keeps its number. A citation is an `@key` that is
// not part of a word (an email is not one) and that is not a cross-reference (`fig-`, `tbl-`, `sec-`, `eq-`).
import { maskCode } from "../tools/check-argument.ts";
import { maskFences } from "../tools/check-puzzle.ts";

/** Each list is sorted, with repeats kept: a multiset of the embeds in one manuscript. */
export interface EmbedSet {
  vars: string[];
  includes: string[];
  images: string[];
  quotes: string[];
  citations: string[];
}

const VAR = /\{\{<\s*var\s+([^\s>]+)\s*>\}\}/g;
const INCLUDE = /\{\{<\s*include\s+([^\s>]+)\s*>\}\}/g;
const IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
/** `[@key]`, `[-@key]`, `@key`: the `@` is not part of a word, so `foo@bar.com` is not a citation. */
const CITATION = /(?<![\w@.])-?@([\w](?:[\w:.-]*[\w])?)/g;
const CROSS_REFERENCE = /^(?:fig|tbl|sec|eq)-/;
const QUOTES_PREFIX = "embeds/quotes/";

/**
 * The lines of a Quarto document with everything that is not prose blanked to spaces: fenced code, the YAML
 * front matter, HTML comments and inline code. Every line keeps its number, so a line of the result is the
 * line of the source.
 */
export function proseLines(qmd: string): string[] {
  const lines = maskFences(qmd);
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
    if (close > 0) for (let index = 0; index <= close; index++) lines[index] = "";
  }
  const text = lines.join("\n").replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));
  return text.split("\n").map(maskCode);
}

/** The embeds of a manuscript: its variables, includes (and the quotation ones), images and citation keys. */
export function scanEmbeds(qmd: string): EmbedSet {
  const text = proseLines(qmd).join("\n");
  const includes = matchesOf(text, INCLUDE);
  return {
    vars: matchesOf(text, VAR),
    includes,
    images: matchesOf(text, IMAGE),
    quotes: includes.filter((target) => target.startsWith(QUOTES_PREFIX)),
    citations: matchesOf(text, CITATION).filter((key) => !CROSS_REFERENCE.test(key)),
  };
}

/** The first capture of each match, sorted. */
function matchesOf(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1] ?? "").sort();
}

const CATEGORIES: [keyof EmbedSet, string][] = [
  ["vars", "variable"],
  ["includes", "include"],
  ["images", "image"],
  ["quotes", "quote"],
  ["citations", "citation"],
];

/**
 * One line per embed whose count differs between the two sets, `<kind> <name>: <a> before, <b> after`, in a fixed
 * order. Equal sets have no lines.
 */
export function embedSetDiff(a: EmbedSet, b: EmbedSet): string[] {
  const lines: string[] = [];
  for (const [field, kind] of CATEGORIES) {
    const before = countsOf(a[field]);
    const after = countsOf(b[field]);
    for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const was = before.get(name) ?? 0;
      const now = after.get(name) ?? 0;
      if (was !== now) lines.push(`${kind} ${field === "citations" ? `@${name}` : name}: ${was} before, ${now} after`);
    }
  }
  return lines;
}

function countsOf(list: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of list) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}
