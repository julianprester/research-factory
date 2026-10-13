// Helper process for the parallel-writers test in tree.test.ts.
// Usage: node harness/test/writer-child.ts <runDir>
import { createChild } from "../tree.ts";

const runDir = process.argv[2];
if (!runDir) {
  console.error("usage: node harness/test/writer-child.ts <runDir>");
  process.exit(2);
}

for (let index = 0; index < 10; index++) {
  createChild(runDir, "D01", `Child ${index}`, { index }, `writer-${process.pid}`);
}
