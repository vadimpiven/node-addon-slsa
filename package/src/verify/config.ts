// SPDX-License-Identifier: Apache-2.0 OR MIT

/** Resolve user-provided {@link VerifyOptions} into fully-populated internal config. */

import {
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_RETRY_COUNT,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
} from "../http.ts";
import type { Dispatcher } from "undici";

import type { BundleVerifier, TrustMaterial, VerifyOptions } from "../types.ts";
import { MAX_JSON_RESPONSE_BYTES, MAX_REKOR_ENTRIES } from "./constants.ts";

/** Fully resolved internal config — not exported from the package. */
export type ResolvedConfig = {
  readonly maxJsonResponseBytes: number;
  readonly maxRekorEntries: number;
  readonly timeoutMs: number;
  readonly stallTimeoutMs: number;
  readonly retryCount: number;
  readonly retryBaseMs: number;
  readonly signal: AbortSignal | undefined;
  readonly verifier: BundleVerifier | undefined;
  readonly trustMaterial: TrustMaterial | undefined;
  readonly dispatcher: Dispatcher | undefined;
};

/** Merge per-call VerifyOptions with module-level defaults. */
export function resolveConfig(options?: VerifyOptions): ResolvedConfig {
  return {
    maxJsonResponseBytes: options?.maxJsonResponseBytes ?? MAX_JSON_RESPONSE_BYTES,
    maxRekorEntries: options?.maxRekorEntries ?? MAX_REKOR_ENTRIES,
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    stallTimeoutMs: options?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
    retryCount: options?.retryCount ?? DEFAULT_RETRY_COUNT,
    retryBaseMs: options?.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
    signal: options?.signal,
    verifier: options?.verifier,
    trustMaterial: options?.trustMaterial,
    dispatcher: options?.dispatcher,
  };
}
