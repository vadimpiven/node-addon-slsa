// SPDX-License-Identifier: Apache-2.0 OR MIT

/** Resolve {@link VerifyOptions} into fully-populated internal config. */

import type { Dispatcher } from "undici";

import {
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  type HttpClient,
} from "../http.ts";
import type { BundleVerifier, TrustMaterial, VerifyOptions } from "../types.ts";
import {
  MAX_JSON_RESPONSE_BYTES,
  MAX_REKOR_ENTRIES,
  REKOR_ENTRY_URL,
  REKOR_INGESTION_RETRY_DELAYS,
  REKOR_SEARCH_URL,
} from "./constants.ts";
import type { RekorClient } from "./rekor-client.ts";

/** Fully resolved internal config — not exported from the package. */
export type ResolvedConfig = {
  readonly maxJsonResponseBytes: number;
  readonly maxRekorEntries: number;
  readonly timeoutMs: number;
  readonly stallTimeoutMs: number;
  readonly signal: AbortSignal | undefined;
  readonly trustMaterial: TrustMaterial | undefined;
  readonly verifier: BundleVerifier | undefined;
  readonly dispatcher: Dispatcher | undefined;
  readonly httpClient: HttpClient | undefined;
  readonly rekorClient: RekorClient | undefined;
  readonly rekorSearchUrl: string;
  readonly rekorEntryUrl: string;
  readonly rekorIngestionRetryDelays: readonly number[];
};

/** Merge per-call {@link VerifyOptions} with module-level defaults. */
export function resolveConfig(options?: VerifyOptions): ResolvedConfig {
  // Endpoint overrides are paired: supplying one without the other is a
  // caller error (the old default can't safely mix with a fork's Rekor).
  const { rekorSearchUrl, rekorEntryUrl } = options ?? {};
  if ((rekorSearchUrl && !rekorEntryUrl) || (!rekorSearchUrl && rekorEntryUrl)) {
    throw new TypeError(
      "rekorSearchUrl and rekorEntryUrl must both be provided when overriding Rekor endpoints",
    );
  }
  return {
    maxJsonResponseBytes: options?.maxJsonResponseBytes ?? MAX_JSON_RESPONSE_BYTES,
    maxRekorEntries: options?.maxRekorEntries ?? MAX_REKOR_ENTRIES,
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    stallTimeoutMs: options?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
    signal: options?.signal,
    trustMaterial: options?.trustMaterial,
    verifier: options?.verifier,
    dispatcher: options?.dispatcher,
    httpClient: options?.httpClient,
    rekorClient: options?.rekorClient,
    rekorSearchUrl: rekorSearchUrl ?? REKOR_SEARCH_URL,
    rekorEntryUrl: rekorEntryUrl ?? REKOR_ENTRY_URL,
    rekorIngestionRetryDelays: options?.rekorIngestionRetryDelays ?? REKOR_INGESTION_RETRY_DELAYS,
  };
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

  describe("resolveConfig", () => {
    it("uses built-in defaults when options are empty", ({ expect }) => {
      const c = resolveConfig();
      expect(c.maxRekorEntries).toBe(MAX_REKOR_ENTRIES);
      expect(c.maxJsonResponseBytes).toBe(MAX_JSON_RESPONSE_BYTES);
      expect(c.rekorSearchUrl).toBe(REKOR_SEARCH_URL);
      expect(c.rekorEntryUrl).toBe(REKOR_ENTRY_URL);
      expect(c.rekorIngestionRetryDelays).toBe(REKOR_INGESTION_RETRY_DELAYS);
    });

    it("overrides knobs from VerifyOptions", ({ expect }) => {
      const c = resolveConfig({
        maxRekorEntries: 7,
        maxJsonResponseBytes: 1024,
        rekorSearchUrl: "https://rekor.example/search",
        rekorEntryUrl: "https://rekor.example/entries/{uuid}",
        rekorIngestionRetryDelays: [],
      });
      expect(c.maxRekorEntries).toBe(7);
      expect(c.maxJsonResponseBytes).toBe(1024);
      expect(c.rekorSearchUrl).toBe("https://rekor.example/search");
      expect(c.rekorEntryUrl).toBe("https://rekor.example/entries/{uuid}");
      expect(c.rekorIngestionRetryDelays).toEqual([]);
    });

    it("rejects half-configured Rekor endpoint override", ({ expect }) => {
      expect(() => resolveConfig({ rekorSearchUrl: "https://rekor.example/search" })).toThrow(
        TypeError,
      );
      expect(() =>
        resolveConfig({ rekorEntryUrl: "https://rekor.example/entries/{uuid}" }),
      ).toThrow(TypeError);
    });
  });
}
