// Deterministic stratified hold-out split for a dataset folder.
//
// A stratum is a file's first `depth` directory segments (depth 1 by default:
// GitLab Handbook sections; depth 2: sub-sections); a file with fewer directory
// levels uses all of them, and files at the dataset's top level form the ""."
// stratum. Within a stratum the paths are sorted, then shuffled by a PRNG seeded
// from the global seed *and* the stratum name, and the first round(n × fraction)
// become the hold-out - capped at n - 1 so every stratum keeps at least one
// exploration document. Sorting before shuffling and seeding each stratum
// separately make the split independent of input order and of the other strata:
// same files + same depth + same seed always give the same lists.
import * as fs from "node:fs";
import * as path from "node:path";

export interface SplitOptions {
  fraction: number;
  seed: number;
  /** Directory levels in a stratum: 1 is the top-level folder (the default). */
  depth?: number;
}

export interface Split {
  holdout: string[];
  exploration: string[];
}

/** mulberry32: a small, well-distributed 32-bit PRNG, in [0, 1). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the stratum name, mixed with the seed: one stream per stratum. */
function stratumSeed(seed: number, stratum: string): number {
  let hash = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  for (const char of stratum) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * The stratum of a dataset-relative path at `depth` directory levels: the first
 * `depth` segments of the file's directory (fewer if the path is shallower), or
 * "." for a top-level file. depth 1 gives "handbook", depth 2
 * "handbook/engineering" for "handbook/engineering/a.md"; "teamops/x.md" is
 * "teamops" at either depth.
 */
export function stratumOf(file: string, depth = 1): string {
  const segments = file
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".");
  const directories = segments.slice(0, -1);
  const levels = Number.isFinite(depth) ? Math.max(Math.trunc(depth), 1) : 1;
  const stratum = directories.slice(0, levels);
  return stratum.length > 0 ? stratum.join("/") : ".";
}

/** Fisher-Yates over a copy of `items`, driven by `random`. */
function shuffle<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const swap = items[i] as T;
    items[i] = items[j] as T;
    items[j] = swap;
  }
  return items;
}

/**
 * Split dataset-relative `files` into a hold-out and an exploration half.
 * The result is a partition, both lists are sorted, and no stratum is ever
 * entirely held out.
 */
export function splitHoldout(files: string[], opts: SplitOptions): Split {
  const { fraction, seed } = opts;
  const depth = opts.depth ?? 1;
  const strata = new Map<string, string[]>();
  for (const file of files) {
    const stratum = stratumOf(file, depth);
    const bucket = strata.get(stratum);
    if (bucket) bucket.push(file);
    else strata.set(stratum, [file]);
  }

  const holdout: string[] = [];
  const exploration: string[] = [];
  for (const [stratum, bucket] of [...strata].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const shuffled = shuffle([...bucket].sort(), mulberry32(stratumSeed(seed, stratum)));
    const n = shuffled.length;
    const wanted = Number.isFinite(fraction) ? Math.round(n * fraction) : 0;
    const take = Math.min(Math.max(wanted, 0), Math.max(n - 1, 0));
    holdout.push(...shuffled.slice(0, take));
    exploration.push(...shuffled.slice(take));
  }
  return { holdout: holdout.sort(), exploration: exploration.sort() };
}

/** Every file under `root` ending in `ext`, as posix-separated relative paths. */
function listFiles(root: string, ext: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile() && entry.name.endsWith(ext)) {
        found.push(path.relative(root, abs).split(path.sep).join("/"));
      }
    }
  };
  visit(root);
  return found;
}

function usage(message: string): number {
  console.error(`holdout: ${message}`);
  console.error(
    "usage: node harness/tools/holdout.ts <datasetDir> <outDir> [--fraction 0.2] [--seed 1] [--depth 1] [--ext .md]",
  );
  return 2;
}

function parseNumber(flag: string, value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} needs a number, got ${value ?? "nothing"}`);
  return parsed;
}

interface Row {
  stratum: string;
  total: number;
  holdout: number;
}

/** Print the per-stratum table: `stratum total holdout`. */
function printTable(rows: Row[]): void {
  const stratumWidth = Math.max("stratum".length, ...rows.map((row) => row.stratum.length));
  const totalWidth = Math.max("total".length, ...rows.map((row) => String(row.total).length));
  console.log(`${"stratum".padEnd(stratumWidth)}  ${"total".padStart(totalWidth)}  holdout`);
  for (const row of rows) {
    console.log(
      `${row.stratum.padEnd(stratumWidth)}  ${String(row.total).padStart(totalWidth)}  ${row.holdout}`,
    );
  }
}

function writeLines(file: string, entries: string[]): void {
  fs.writeFileSync(file, entries.length > 0 ? `${entries.join("\n")}\n` : "");
}

function main(argv: string[]): number {
  const positional: string[] = [];
  let fraction = 0.2;
  let seed = 1;
  let depth = 1;
  let ext = ".md";
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i] as string;
    // Both `--flag value` and `--flag=value` are accepted.
    const equals = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = equals === -1 ? raw : raw.slice(0, equals);
    const inline = equals === -1 ? undefined : raw.slice(equals + 1);
    if (flag === "--fraction" || flag === "--seed" || flag === "--depth" || flag === "--ext") {
      const value = inline ?? argv[++i];
      try {
        if (flag === "--fraction") fraction = parseNumber(flag, value);
        else if (flag === "--seed") seed = parseNumber(flag, value);
        else if (flag === "--depth") depth = parseNumber(flag, value);
        else if (value !== undefined) ext = value.startsWith(".") ? value : `.${value}`;
        else return usage("--ext needs a file extension");
      } catch (error) {
        return usage((error as Error).message);
      }
    } else if (flag.startsWith("--")) {
      return usage(`unknown option ${flag}`);
    } else {
      positional.push(raw);
    }
  }
  const [datasetDir, outDir] = positional;
  if (datasetDir === undefined || outDir === undefined || positional.length > 2) {
    return usage("expected a dataset directory and an output directory");
  }
  if (fraction < 0 || fraction > 1) return usage(`--fraction must be between 0 and 1, got ${fraction}`);
  if (!Number.isInteger(depth) || depth < 1) {
    return usage(`--depth must be a whole number of directory levels >= 1, got ${depth}`);
  }
  if (!fs.existsSync(datasetDir) || !fs.statSync(datasetDir).isDirectory()) {
    return usage(`${datasetDir} is not a directory`);
  }

  const files = listFiles(datasetDir, ext);
  const { holdout, exploration } = splitHoldout(files, { fraction, seed, depth });

  fs.mkdirSync(outDir, { recursive: true });
  writeLines(path.join(outDir, "holdout.txt"), holdout);
  writeLines(path.join(outDir, "exploration.txt"), exploration);

  const totals = new Map<string, number>();
  for (const file of files) {
    const stratum = stratumOf(file, depth);
    totals.set(stratum, (totals.get(stratum) ?? 0) + 1);
  }
  const held = new Map<string, number>();
  for (const file of holdout) {
    const stratum = stratumOf(file, depth);
    held.set(stratum, (held.get(stratum) ?? 0) + 1);
  }
  const rows = [...totals]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([stratum, total]) => ({ stratum, total, holdout: held.get(stratum) ?? 0 }));
  printTable(rows);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
