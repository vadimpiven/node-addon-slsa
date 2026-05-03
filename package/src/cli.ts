// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * CLI entry point (`slsa wget`, `slsa pack`).
 * {@link runSlsaInner} is the testable core; {@link runSlsa}
 * adds signal handling and process.exit().
 */

import process from "node:process";
import { parseArgs } from "node:util";

import { pack, wget } from "./commands.ts";
import type { FetchOptions } from "./types.ts";
import { log } from "./util/log.ts";
import { isProvenanceError } from "./util/provenance-error.ts";

const DEBUG_HINT = `Set SLSA_DEBUG=1 for detailed diagnostics.`;

const HELP = `Usage: slsa <command> [options]

Commands:
  wget          Download, verify, and install the native addon
  pack          Gzip-compress the native addon for release

Options:
  -h, --help    Show this help message

Environment:
  SLSA_DEBUG=1  Debug logging to stderr
`;

/**
 * Testable CLI core. Returns an exit code instead of calling process.exit().
 * Accepts an optional AbortSignal for graceful shutdown.
 */
export async function runSlsaInner(options?: FetchOptions): Promise<{ exitCode: number }> {
  let values: { help: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: process.argv.slice(2),
      options: {
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: true,
    }));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 1 };
  }

  const command = positionals[0];

  if (values.help || !command) {
    console.log(HELP);
    return { exitCode: 0 };
  }

  const packageDir = process.cwd();
  const signal = options?.signal;

  try {
    switch (command) {
      case "pack":
        await pack(packageDir, signal ? { signal } : undefined);
        break;
      case "wget":
        await wget(packageDir, {
          ...(signal && { signal }),
          ...(options?.dispatcher && { dispatcher: options.dispatcher }),
        });
        break;
      default:
        console.error(HELP);
        return { exitCode: 1 };
    }
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error(err.message);
      if (!isProvenanceError(err)) {
        if (err.stack) log(err.stack);
        console.error(DEBUG_HINT);
      }
    } else {
      console.error(String(err));
    }
    return { exitCode: 1 };
  }

  return { exitCode: 0 };
}

/**
 * CLI entry point. Sets up signal handling and sets process.exitCode.
 */
export async function runSlsa(): Promise<void> {
  const ac = new AbortController();

  const onSignal = (): void => {
    ac.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const { exitCode } = await runSlsaInner({ signal: ac.signal });
    process.exitCode = ac.signal.aborted ? 130 : exitCode;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
