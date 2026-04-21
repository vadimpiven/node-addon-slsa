// SPDX-License-Identifier: Apache-2.0 OR MIT

/** Resolve {@link VerifyOptions} into fully-populated internal config. */

import type { Dispatcher } from "undici";

import { DEFAULT_TIMEOUT_MS } from "../http.ts";
import type { BundleVerifier, TrustMaterial, VerifyOptions } from "../types.ts";
import { BUNDLE_FETCH_RETRY_DELAYS } from "./constants.ts";

/** Fully resolved internal config — not exported from the package. */
export type ResolvedConfig = {
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
  readonly trustMaterial: TrustMaterial | undefined;
  readonly verifier: BundleVerifier | undefined;
  readonly dispatcher: Dispatcher | undefined;
  /**
   * Retry delays (ms) used when a sidecar bundle URL returns 404 — it can
   * take a handful of seconds for a freshly-uploaded release asset to
   * propagate through the CDN. Empty array disables retry. First entry is
   * the delay after attempt 1, etc.
   */
  readonly bundleFetchRetryDelays: readonly number[];
};

/** Merge per-call {@link VerifyOptions} with module-level defaults. */
export function resolveConfig(options?: VerifyOptions): ResolvedConfig {
  return {
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: options?.signal,
    trustMaterial: options?.trustMaterial,
    verifier: options?.verifier,
    dispatcher: options?.dispatcher,
    bundleFetchRetryDelays: options?.bundleFetchRetryDelays ?? BUNDLE_FETCH_RETRY_DELAYS,
  };
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

  describe("resolveConfig", () => {
    it("uses built-in defaults when options are empty", ({ expect }) => {
      const c = resolveConfig();
      expect(c.bundleFetchRetryDelays).toBe(BUNDLE_FETCH_RETRY_DELAYS);
      expect(c.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    });

    it("overrides knobs from VerifyOptions", ({ expect }) => {
      const c = resolveConfig({ bundleFetchRetryDelays: [1, 2, 3] });
      expect(c.bundleFetchRetryDelays).toEqual([1, 2, 3]);
    });
  });
}
