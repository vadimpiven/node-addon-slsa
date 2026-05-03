// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Sigstore trust-material loaders and small regex / retry helpers shared
 * by `verify.ts` and `manifest-lookup.ts`.
 */

import { bundleFromJSON } from "@sigstore/bundle";
import { getTrustedRoot } from "@sigstore/tuf";
import {
  toSignedEntity,
  toTrustMaterial,
  Verifier as SigstoreVerifier,
  type TrustMaterial,
} from "@sigstore/verify";

import { HttpError } from "../http.ts";
import type { BundleVerifier } from "../types.ts";
import { escapeRegExp } from "./constants.ts";

/**
 * Load sigstore trust material (Fulcio CAs, Rekor public keys) from the
 * TUF repository.
 *
 * Cost: one network round-trip via TUF. Cache the result and pass it back
 * via {@link createBundleVerifier} or `VerifyOptions.trustMaterial`.
 */
export async function loadTrustMaterial(): Promise<TrustMaterial> {
  return toTrustMaterial(await getTrustedRoot());
}

/**
 * Build a {@link BundleVerifier} over given trust material. Reuse across
 * many calls to amortize TUF load.
 */
export function createBundleVerifier(trustMaterial: TrustMaterial): BundleVerifier {
  const verifier = new SigstoreVerifier(trustMaterial);
  return {
    verify(bundle) {
      verifier.verify(toSignedEntity(bundleFromJSON(bundle)));
    },
  };
}

/** Normalize a `RegExp | string` pattern to a `RegExp`. Strings are anchored and escaped. */
export function toRegExp(pattern: RegExp | string): RegExp {
  if (pattern instanceof RegExp) return pattern;
  return new RegExp(`^${escapeRegExp(pattern)}$`);
}

/** Default `refPattern` for a given installed package version. */
export function defaultRefPattern(version: string): RegExp {
  return new RegExp(`^refs/tags/v?${escapeRegExp(version)}$`);
}

// Retry sidecar 404s only — see BUNDLE_FETCH_RETRY_DELAYS for the why.
export function classifyBundle404(
  delays: readonly number[],
): (err: unknown, attempt: number) => { retry: true; delayMs: number } | { retry: false } {
  return (err, attempt) => {
    const index = attempt - 1;
    if (index >= delays.length) return { retry: false };
    if (err instanceof HttpError && err.kind === "status" && err.status === 404) {
      return { retry: true, delayMs: delays[index] ?? 0 };
    }
    return { retry: false };
  };
}
