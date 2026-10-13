// The /research-factory subcommands without pi, for scripts and checks:
//
//   node harness/factory-cli.ts <init <dataset> "<interest>" [runDir] | status [runDir] | stop [runDir] | resume [runDir]>
//
// It runs the same functions as the pi command and prints the text; an error
// goes to stderr and exits 1.
import { realDeps, runCommand } from "./factory.ts";

/** Single-quote one argv element for factory.parseCommand's shell-like parse. */
function quote(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

function main(argv: string[]): number {
  try {
    console.log(runCommand(argv.map(quote).join(" "), realDeps()));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
