// SPDX-License-Identifier: Apache-2.0 OR MIT

/** Error helpers for call sites that receive `unknown` from catch clauses. */

/**
 * Extract a human-readable message from an `unknown` caught value. Most
 * thrown values are `Error` instances, but a caller may have thrown a
 * string or anything else — falling back to `String(value)` keeps log
 * output useful without `as Error` casts at every catch site.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
