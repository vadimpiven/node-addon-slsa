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
  -h, --help   Show this help message
`;

/**
 * CLI entry point. Parses flags and dispatches to pack() or wget().
 */
export async function runSlsa(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const command = positionals[0];

  if (values.help || !command) {
    process.stdout.write(HELP);
    process.exit(0);
    return;
  }

  const packageDir = process.cwd();

  try {
    switch (command) {
      case "pack":
        await pack(packageDir);
        break;
      case "wget":
        await wget(packageDir);
        break;
      default:
        console.error(`Unknown command: ${command}. Use "pack" or "wget".`);
        process.exit(1);
        return;
    }
  } catch (err: unknown) {
    if (isSecurityError(err)) {
      console.error(err.message);
    } else {
      console.error(err);
    }
    process.exit(1);
  }
}
