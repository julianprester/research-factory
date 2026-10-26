// The embeds a paper names (design §5, §8.1): its `{{< var >}}` keys, its `{{< include >}}` paths, its images
// and its citation keys. `scanEmbeds` reads the raw manuscript and masks nothing: Quarto and pandoc render code
// spans, fences, comments and raw blocks too, so an embed in any of them is an embed. `checkPaper` refuses the
// constructs that would hide one (fences, raw HTML, TeX commands, other shortcodes), so a raw scan is the whole
// story.
//
// `embedSetDiff` says how two scans differ, so a style pass that adds or drops an embed is caught by counts.
// A citation is an `@key` or `-@key` that is not a part of a word, a path or a URL (`foo@bar.com`,
// `https://x.org/@user`), and that is not a cross-reference (`fig-`, `tbl-`, `sec-`, `eq-`). Keys may hold Unicode
// letters.

/** A var shortcode, in the spellings Quarto accepts: `{{<var x>}}`, extra spaces and a newline inside. The key is the first group. */
export const VAR_SHORTCODE = /\{\{<\s*var\s+([^\s>}]+)\s*>\}\}/g;
/**
 * An include shortcode, in the two spellings Quarto renders: `{{< include X >}}` and `{{< include "X" >}}`, with single
 * spaces exactly as written. Quarto renders the other spellings (no space before `>}}`, no space after `<`, a line break
 * inside) as nothing, with exit 0, so they are not includes; `checkPaper` refuses them as malformed. The path is the first
 * group, or the second when quoted.
 */
export const INCLUDE_SHORTCODE = /\{\{< include (?:"([^"\n]+)"|([^\s>"}]+)) >\}\}/g;
/** An inline image `![alt](target "title")`; the target is the first group. A reference-style image is not one. */
export const IMAGE = /!\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;
/** A citation or cross-reference token: `@key`, or `-@key`, not preceded by a word, a dot, a slash or an `@`. The key is the first group. */
export const CITATION_TOKEN = /(?<![\p{L}\p{N}_@./])-?@([\p{L}\p{N}_](?:[\p{L}\p{N}_:.-]*[\p{L}\p{N}_])?)/gu;

export interface EmbedSet {
  vars: string[];
  includes: string[];
  images: string[];
  quotes: string[];
  citations: string[];
}

const CROSS_REFERENCE = /^(?:fig|tbl|sec|eq)-/;
const QUOTES_PREFIX = "embeds/quotes/";

/** The embeds of a manuscript, read raw: its variables, includes (and the quotation ones), images and citation keys. */
export function scanEmbeds(qmd: string): EmbedSet {
  const includes = captures(qmd, INCLUDE_SHORTCODE);
  return {
    vars: captures(qmd, VAR_SHORTCODE),
    includes,
    images: captures(qmd, IMAGE),
    quotes: includes.filter((target) => target.startsWith(QUOTES_PREFIX)),
    citations: captures(qmd, CITATION_TOKEN).filter((key) => !CROSS_REFERENCE.test(key)),
  };
}

/** The first or second capture of each match of a global pattern (the second for a quoted include path), sorted. */
function captures(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? "").sort();
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
