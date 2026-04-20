// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Argument parser and dispatch for the `slsa` CLI (`slsa wget`, `slsa pack`).
 * {@link runSlsaInner} is the testable core — returns an exit code and takes
 * an injectable signal/dispatcher. {@link runSlsa} is the production wrapper
 * that wires SIGINT/SIGTERM to an AbortController and sets `process.exitCode`.
 * Command implementations live in `./commands.ts`.
 */

import process from "node:process";
import { parseArgs } from "node:util";

import type { Dispatcher } from "undici";

import { errorMessage, isProvenanceError } from "@node-addon-slsa/internal";

import { pack, wget } from "./commands.ts";

const HELP = `Usage: slsa <command> [options]

Commands:
  wget          Download, verify, and install the native addon
  pack          Gzip-compress the native addon for release

Options:
  -h, --help    Show this help message

Environment:
  SLSA_DEBUG=1  Emit [slsa] diagnostics on stderr
`;

const DEBUG_HINT = "Set SLSA_DEBUG=1 for detailed diagnostics.";

/**
 * Injection points for {@link runSlsaInner}. Not exported from the package;
 * exists so tests can pass an AbortSignal and a custom undici dispatcher
 * (proxy / mock transport) without touching `process`.
 */
export type RunOptions = {
  /** Cancellation for the entire CLI invocation. */
  readonly signal?: AbortSignal | undefined;
  /** undici dispatcher forwarded to `wget`'s fetch layer. */
  readonly dispatcher?: Dispatcher | undefined;
};

/**
 * Testable CLI core. Parses argv, dispatches to the command, and returns
 * an exit code instead of calling `process.exit`. Never throws — errors
 * are logged to stderr and surface as exit code 1.
 */
export async function runSlsaInner(options?: RunOptions): Promise<{ exitCode: number }> {
  let values: { help: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: process.argv.slice(2),
      options: { help: { type: "boolean", short: "h", default: false } },
      strict: true,
      allowPositionals: true,
    }));
  } catch (err) {
    console.error(errorMessage(err));
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
    // ProvenanceError already carries the full narrative (what failed, why,
    // what to check) — a stack trace adds noise without signal. For any
    // other failure (network, schema, logic), emit the stack and hint at
    // the debug flag so the user can reproduce with verbose diagnostics.
    if (isProvenanceError(err)) {
      console.error(err.message);
    } else if (err instanceof Error) {
      console.error(err.stack ?? err.message);
      if (!process.env["SLSA_DEBUG"]) console.error(DEBUG_HINT);
    } else {
      console.error(String(err));
    }
    return { exitCode: 1 };
  }

  return { exitCode: 0 };
}

/**
 * Production CLI entry point invoked by `bin/slsa.mjs`. Wires SIGINT/SIGTERM
 * to an AbortController and sets `process.exitCode` (130 on signal abort,
 * otherwise the code returned by {@link runSlsaInner}).
 */
export async function runSlsa(): Promise<void> {
  const ac = new AbortController();
  const onSignal = (): void => ac.abort();
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
