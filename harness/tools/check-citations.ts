// Deterministic citation check: every `[@chunk_id]` in a markdown paper must be
// a chunk that deepis knows about.
//
// Observed `deepis metadata` shape (verified with
// `deepis metadata 144636,999999999 -f json`):
//
//   {
//     "papers": [
//       {
//         "paper_id": 1411,
//         "chunk_ids": [144636],          // ints: one entry per requested chunk that exists
//         "doi": "10.2307/4132331",
//         "title": "Studying Knowledge Management ...",
//         "authors": "[{\"name\": ...}]",  // a JSON-encoded string, not an array
//         "year": 2002,
//         "journal": "MIS Quarterly",
//         "abstract": "..."
//       }
//     ]
//   }
//
// An unknown chunk id is simply absent from every paper's `chunk_ids` - a query
// for only unknown ids returns `{"papers": []}` - and deepis still exits 0. So
// the comparison here, not the exit code, is what decides whether a citation is
// missing. (`deepis metadata` with no ids at all is a usage error, exit 120;
// this tool never makes that call.)
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** deepis metadata accepts a bounded comma-separated id list, so resolve in batches. */
const BATCH_SIZE = 50;
/** Every deepis call is bounded; a hung database must not hang the tool. */
const DEEPIS_TIMEOUT_MS = 60_000;

/** deepis could not be reached or answered with something unusable (exit 2, not exit 1). */
export class DeepisUnavailable extends Error {}

/**
 * The chunk ids cited by `markdown`, unique and in first-seen order.
 * Citation forms: `[@123]`, `[@1;@2]` and `[-@3, p. 4]`. An `@` is only a
 * citation inside square brackets and after `[` (via `^`), `;`, `,` or `-`, so
 * an email such as `foo@123.com` and prose brackets like `[see above]` are ignored.
 */
export function extractChunkIds(markdown: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const bracket of markdown.matchAll(/\[[^\]]*\]/g)) {
    const body = bracket[0].slice(1, -1);
    for (const citation of body.matchAll(/(?:^|[;,\-])\s*@(\d+)/g)) {
      const id = citation[1];
      if (id !== undefined && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

/** Which of `ids` the resolver does not know about, in input order. */
export function checkCitations(
  ids: string[],
  resolve: (ids: string[]) => Set<string>,
): { missing: string[] } {
  const resolved = resolve(ids);
  return { missing: ids.filter((id) => !resolved.has(id)) };
}

/**
 * Resolve chunk ids through `deepis metadata <ids> -f json`, in batches of 50,
 * collecting every `papers[].chunk_ids` entry. Throws DeepisUnavailable for any
 * infrastructure failure (not installed, timeout, non-zero exit, bad JSON).
 */
export function deepisResolver(ids: string[]): Set<string> {
  const resolved = new Set<string>();
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const result = spawnSync("deepis", ["metadata", batch.join(","), "-f", "json"], {
      encoding: "utf8",
      timeout: DEEPIS_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new DeepisUnavailable("deepis is not installed or not on PATH");
      if (code === "ETIMEDOUT") {
        throw new DeepisUnavailable(`deepis did not answer within ${DEEPIS_TIMEOUT_MS / 1000}s`);
      }
      throw new DeepisUnavailable(`could not run deepis: ${result.error.message}`);
    }
    if (result.status === null) {
      throw new DeepisUnavailable(`deepis did not answer within ${DEEPIS_TIMEOUT_MS / 1000}s`);
    }
    if (result.status !== 0) {
      throw new DeepisUnavailable(
        `deepis metadata exited ${result.status}: ${(result.stderr ?? "").trim()}`,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      throw new DeepisUnavailable("deepis metadata returned invalid JSON");
    }
    const papers = (payload as { papers?: { chunk_ids?: unknown }[] }).papers;
    if (!Array.isArray(papers)) throw new DeepisUnavailable("deepis metadata returned no papers array");
    for (const paper of papers) {
      if (!Array.isArray(paper.chunk_ids)) continue;
      for (const id of paper.chunk_ids) resolved.add(String(id));
    }
  }
  return resolved;
}

function main(argv: string[]): number {
  const file = argv[0];
  if (file === undefined || argv.length > 1) {
    console.error("usage: node harness/tools/check-citations.ts <file.md>");
    return 2;
  }
  let markdown: string;
  try {
    markdown = fs.readFileSync(file, "utf8");
  } catch (error) {
    console.error(`check-citations: cannot read ${file}: ${(error as Error).message}`);
    return 2;
  }

  const ids = extractChunkIds(markdown);
  if (ids.length === 0) {
    console.log("ok 0 citations");
    return 0;
  }

  let missing: string[];
  try {
    missing = checkCitations(ids, deepisResolver).missing;
  } catch (error) {
    if (error instanceof DeepisUnavailable) {
      console.error(`check-citations: deepis is not reachable: ${error.message}`);
      return 2;
    }
    throw error;
  }

  if (missing.length === 0) {
    console.log(`ok ${ids.length} citations`);
    return 0;
  }
  for (const id of missing) console.error(`missing chunk id ${id}`);
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
