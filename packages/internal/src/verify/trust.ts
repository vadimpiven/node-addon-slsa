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

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

  // toRegExp + defaultRefPattern are exercised end-to-end by
  // verify-package.test.ts (default `refs/tags/v<version>` matching) and
  // verify-addons.test.ts (custom string patterns flow through
  // verifyAttestationFromBundle). Only classifyBundle404 has branches
  // (404 retry vs. non-404 abort vs. exhausted-delays) that no e2e flow
  // can trigger without standing up a flaky bundle endpoint, so keep
  // those branch tests here.

  describe("classifyBundle404", () => {
    const delays = [10, 20] as const;
    const classify = classifyBundle404(delays);

    it("retries 404 with delays from the list", ({ expect }) => {
      const err = new HttpError({ kind: "status", status: 404, message: "404", url: "u" });
      expect(classify(err, 1)).toEqual({ retry: true, delayMs: 10 });
      expect(classify(err, 2)).toEqual({ retry: true, delayMs: 20 });
    });

    it("stops retrying once attempt exceeds delay table", ({ expect }) => {
      const err = new HttpError({ kind: "status", status: 404, message: "404", url: "u" });
      expect(classify(err, 3)).toEqual({ retry: false });
    });

    it("does not retry non-404 status errors", ({ expect }) => {
      const err = new HttpError({ kind: "status", status: 500, message: "500", url: "u" });
      expect(classify(err, 1)).toEqual({ retry: false });
    });

    it("does not retry network errors", ({ expect }) => {
      const err = new HttpError({ kind: "network", message: "boom", url: "u" });
      expect(classify(err, 1)).toEqual({ retry: false });
    });

    it("does not retry generic errors", ({ expect }) => {
      expect(classify(new Error("nope"), 1)).toEqual({ retry: false });
    });
  });
}
