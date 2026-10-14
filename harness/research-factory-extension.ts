// The pi command: /research-factory init|status|stop|resume.
//
// The handler only parses and prints; all the work is in harness/factory.ts.
// It is loaded as a project extension through the re-export shim
// .pi/extensions/research-factory.ts, which must be a real file: pi 1.1.0's
// jiti does not resolve a symlinked entry point before resolving this module's
// relative imports, so a symlink would make ./factory.ts resolve against
// .pi/extensions/ and fail.
//
// ctx.ui.notify accepts multi-line text: interactive mode renders it through
// ThemedText/Text, which wraps each line (verified in pi 1.1.0's dist), so the
// status output is shown as-is. Non-interactive modes (pi -p, --mode json) have
// a no-op UI (pi 1.1.0 runner.js noOpUIContext) and pi takes over stdout during
// the run (core/output-guard.js), so without a UI the text is also written with
// console.log, which lands on stderr.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { realDeps, runCommand } from "./factory.ts";

export default function researchFactory(pi: ExtensionAPI): void {
  pi.registerCommand("research-factory", {
    description: "Start, inspect, stop or resume a research-factory run",
    handler: async (args, ctx) => {
      try {
        const text = runCommand(args, realDeps());
        ctx.ui.notify(text, "info");
        if (!ctx.hasUI) console.log(text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
        if (!ctx.hasUI) console.error(message);
      }
    },
  });
}
