// The pi command: /research-factory init|status|stop|resume.
//
// The handler only parses and prints; all the work is in harness/factory.ts.
// It is loaded as a project extension through the symlink
// .pi/extensions/research-factory.ts -> ../../harness/research-factory-extension.ts,
// and pi's jiti resolves the symlink to the real file, so the relative imports
// below land in harness/.
//
// ctx.ui.notify accepts multi-line text: interactive mode renders it through
// ThemedText/Text, which wraps each line (verified in pi 1.1.0's dist), so the
// status output is shown as-is.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { realDeps, runCommand } from "./factory.ts";

export default function researchFactory(pi: ExtensionAPI): void {
  pi.registerCommand("research-factory", {
    description: "Start, inspect, stop or resume a research-factory run",
    handler: async (args, ctx) => {
      try {
        ctx.ui.notify(runCommand(args, realDeps()), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
