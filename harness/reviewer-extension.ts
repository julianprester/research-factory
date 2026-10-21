// The reviewer extension: one puzzle in, one review out, no review read.
//
// Pi loads this into every `ctc-reviewer` child (see
// harness/agents/ctc-reviewer.md). Reviewers are Phase 2 only and run with their
// puzzle node as cwd. The guard enforces the independence the Phase 2 design
// promises (§5.3) with code, not with the prompt:
//
// - `write`/`edit` only to `<nodeDir>/workspace/reviews/a.md` or `b.md`; the
//   merge (`merged.md`), the card and `handoff.md` are not a reviewer's files.
//   A session outside a puzzle node folder is refused every tool call, so a
//   dispatch that lands in the run root or a pattern node fails closed instead
//   of silently losing the isolation.
// - `read` and `bash` may not see a review: any path with a `reviews` segment is
//   refused, including the reviewer's own draft (its only exit is
//   `check-citations.ts` in bash), and so is any command naming that segment.
// - `read` and `bash` may not see another puzzle: `siblingRefusal` runs with
//   `allowDerived: false`, so even an evolved puzzle's parent — which its own
//   worker may read — is another puzzle to the reviewer.
// - `owners/` (the ledger, rulings and tournament round files with judge
//   verdicts) is refused on `read` and `bash`.
// - The hold-out stays locked for every Phase 2 session.
//
// None of this is a sandbox. A shell command is only scanned for names and
// globs, and a script that walks the tree is not seen; the guard closes the
// direct, accidental spellings a model reaches for.
import * as path from "node:path";

import { holdoutRefusal, isPuzzleNode, ownersRefusal, reviewsRefusal, reviewerMayWrite, siblingRefusal } from "./guard.ts";
import { findNodeDir } from "./worker-extension.ts";

interface ToolCallEventLike {
  toolName: string;
  input?: { path?: unknown; command?: unknown } | undefined;
}

interface PiLike {
  on(event: string, handler: (event: ToolCallEventLike, ctx?: unknown) => unknown): unknown;
}

/** Why the reviewer extension refuses this call, or undefined when it allows it. */
function refusal(nodeDir: string, event: ToolCallEventLike): string | undefined {
  if (event.toolName === "read" || event.toolName === "bash") {
    return (
      holdoutRefusal(event.toolName, event.input) ??
      siblingRefusal(nodeDir, event.toolName, event.input, { allowDerived: false }) ??
      reviewsRefusal(event.toolName, event.input) ??
      ownersRefusal(event.toolName, event.input)
    );
  }
  if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
  const filePath = event.input?.path;
  if (typeof filePath !== "string" || filePath.length === 0) {
    return "reviewer-extension: write/edit without a path is not allowed";
  }
  if (!reviewerMayWrite(nodeDir, path.resolve(filePath))) {
    return `Reviewers may only write workspace/reviews/a.md or b.md inside ${nodeDir}, not ${filePath}`;
  }
  return undefined;
}

export default function reviewerExtension(pi: PiLike): void {
  pi.on("tool_call", (event) => {
    // A reviewer must sit in a puzzle node: anywhere else (the run root, a
    // pattern node, outside a run) there is no review file to trust it with and
    // no puzzle whose siblings the guard could recognise, so every call fails
    // closed rather than falling open.
    const nodeDir = findNodeDir(process.cwd());
    if (nodeDir === undefined || !isPuzzleNode(nodeDir)) {
      return {
        block: true,
        reason: `Refusing ${event.toolName}: a reviewer must run inside a puzzle node folder (cwd ${process.cwd()})`,
      };
    }
    const reason = refusal(nodeDir, event);
    return reason === undefined ? undefined : { block: true, reason };
  });
}
