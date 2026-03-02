// SPDX-License-Identifier: Apache-2.0 OR MIT

import process from "node:process";
import { parseArgs } from "node:util";

import { pack, wget } from "./commands.ts";
import { isSecurityError } from "./util/security-error.ts";

const HELP = `Usage: slsa <command> [options]

Commands:
  wget   Download, verify, and install the native binary
  pack   Gzip-compress the native binary for release

Options:
  --no-verify  Skip provenance verification (wget only)
  -h, --help   Show this help message
`;

/**
 * CLI entry point. Parses flags and dispatches to pack() or wget().
 */
export function runSlsa(): void {
  process.once("unhandledRejection", (reason) => {
    console.error(reason);
    process.exit(1);
  });

  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h", default: false },
      "no-verify": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const command = positionals[0];

  if (values.help || !command) {
    process.stdout.write(HELP);
    process.exit(0);
    return;
  }

  const packageDir = process.cwd();

  let task: Promise<void>;

  switch (command) {
    case "pack":
      task = pack(packageDir);
      break;
    case "wget":
      task = wget(packageDir, values["no-verify"]);
      break;
    default:
      console.error(`Unknown command: ${command}. Use "pack" or "wget".`);
      process.exit(1);
      return;
  }

  task.catch((err: unknown) => {
    if (isSecurityError(err)) {
      console.error(err.message);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}
