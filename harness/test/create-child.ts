// Helper process for the live-lock test in tree.test.ts: one createChild calls
// under the lock, with the error message on stderr and a non-zero exit when it
// cannot acquire the lock.
// Usage: node harness/test/create-child.ts <runDir>
import { createChild } from "../tree.ts";

const runDir = process.argv[2];
if (!runDir) {
  console.error("usage: node harness/test/create-child.ts <runDir>");
  process.exit(2);
}

try {
  createChild(runDir, "D01", "Child", `writer-${process.pid}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
