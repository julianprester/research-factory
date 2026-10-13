// The init command: create a fresh run from a dataset path and an interest.
//
//   node harness/init.ts <runDir> <datasetPath> "<interest>"
//
// Resolves both paths to absolute paths and hands them to the tree module.
import * as path from "node:path";
import { initRun } from "./tree.ts";

const USAGE = 'usage: node harness/init.ts <runDir> <datasetPath> "<interest>"';

function main(args: string[]): number {
  const [runDir, datasetPath, interest] = args;
  if (runDir === undefined || datasetPath === undefined || interest === undefined) {
    console.error(USAGE);
    return 2;
  }

  initRun(path.resolve(runDir), path.resolve(datasetPath), interest);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
