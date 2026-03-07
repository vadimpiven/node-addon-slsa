// SPDX-License-Identifier: Apache-2.0 OR MIT

import {
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_RETRY_COUNT,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
} from "../download.ts";
import type { BundleVerifier, VerifyOptions } from "../types.ts";
import { MAX_BUNDLE_BYTES, MAX_JSON_RESPONSE_BYTES, RESOLVE_CONCURRENCY } from "./constants.ts";

/** Fully resolved internal config — not exported from the package. */
export interface ResolvedConfig {
  readonly maxBundleBytes: number;
  readonly maxJsonResponseBytes: number;
  readonly resolveConcurrency: number;
  readonly timeoutMs: number;
  readonly stallTimeoutMs: number;
  readonly retryCount: number;
  readonly retryBaseMs: number;
  readonly signal: AbortSignal | undefined;
  readonly verifier: BundleVerifier | undefined;
}

/** Merge per-call VerifyOptions with module-level defaults. */
export function resolveConfig(options?: VerifyOptions): ResolvedConfig {
  return {
    maxBundleBytes: options?.maxBundleBytes ?? MAX_BUNDLE_BYTES,
    maxJsonResponseBytes: options?.maxJsonResponseBytes ?? MAX_JSON_RESPONSE_BYTES,
    resolveConcurrency: options?.resolveConcurrency ?? RESOLVE_CONCURRENCY,
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    stallTimeoutMs: options?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
    retryCount: options?.retryCount ?? DEFAULT_RETRY_COUNT,
    retryBaseMs: options?.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
    signal: options?.signal,
    verifier: options?.verifier,
  };
}
