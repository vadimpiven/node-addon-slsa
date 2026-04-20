// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Shared HTTP client for Rekor, CDN, and GitHub API calls: timeout, retry with
 * backoff, and stall detection. Uses undici `request()` (not WHATWG fetch).
 * Every network-touching module in this package routes through {@link fetchWithRetry}.
 */

import { setTimeout as sleep } from "node:timers/promises";

import { Agent, request, type Dispatcher } from "undici";

import type { FetchOptions } from "./types.ts";
import { errorMessage } from "./util/error.ts";
import { log } from "./util/log.ts";

/** Per-request timeout used when {@link FetchOptions.timeoutMs} is not supplied. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Stall timeout (no bytes received) used when {@link FetchOptions.stallTimeoutMs} is not supplied. */
export const DEFAULT_STALL_TIMEOUT_MS = 30_000;
/** Retry count used when {@link FetchOptions.retryCount} is not supplied. */
export const DEFAULT_RETRY_COUNT = 2;
/** Base delay for exponential backoff used when {@link FetchOptions.retryBaseMs} is not supplied. */
export const DEFAULT_RETRY_BASE_MS = 500;

/** Exponential backoff with ±20% jitter to avoid thundering-herd collisions. */
function jitteredDelay(attempt: number, baseMs: number): number {
  const base = baseMs * 2 ** (attempt - 1);
  return Math.round(base * (0.8 + 0.4 * Math.random()));
}

// HTTP/1.1-only agent with no keep-alive. This tool makes a handful
// of sequential requests to different hosts — H2 multiplexing and
// connection reuse provide no benefit. Disabling keep-alive ensures
// connections close immediately after each response is consumed,
// avoiding dangling H2 session promises.
const defaultDispatcher: Dispatcher = new Agent({
  allowH2: false,
  keepAliveTimeout: 1,
  keepAliveMaxTimeout: 1,
});

/** Response from {@link fetchWithRetry}. */
export type FetchResponse = {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  /** Node.js Readable body with .text(), .json(), .dump() mixins. */
  readonly body: Dispatcher.ResponseData["body"];
};

/**
 * Fetch with timeout, retry with exponential backoff, and stall detection.
 * Retries on network errors and HTTP 5xx. Does NOT retry on 4xx.
 *
 * @throws on network failure after all retries are exhausted.
 */
export async function fetchWithRetry(url: string, options?: FetchOptions): Promise<FetchResponse> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryCount = options?.retryCount ?? DEFAULT_RETRY_COUNT;
  const retryBaseMs = options?.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const retryOn404 = options?.retryOn404 ?? false;
  const stallTimeoutMs = options?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const parentSignal = options?.signal;

  const maxAttempts = 1 + retryCount;
  let lastError: unknown;

  log(`fetching: ${url}`);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Bail immediately if the parent signal is already aborted
    parentSignal?.throwIfAborted();

    const ac = new AbortController();
    const timer = globalThis.setTimeout(() => ac.abort(), timeoutMs);

    const signal = AbortSignal.any([ac.signal, parentSignal].filter((s) => !!s));

    try {
      const response = await request(url, {
        ...(options?.method && { method: options.method }),
        ...(options?.headers && { headers: options.headers }),
        ...(options?.body && { body: options.body }),
        signal,
        dispatcher: options?.dispatcher ?? defaultDispatcher,
        bodyTimeout: stallTimeoutMs,
      });

      const retryableStatus =
        response.statusCode >= 500 || (retryOn404 && response.statusCode === 404);
      if (retryableStatus && attempt < maxAttempts) {
        await response.body.dump();
        // Carry the status code + headers on the cause so retries+callers
        // can inspect them. `Error.cause` convention prefers an Error, so
        // we wrap them on a dedicated Error subtype rather than bare data.
        const cause = new Error(`HTTP ${response.statusCode}`);
        Object.assign(cause, {
          statusCode: response.statusCode,
          headers: response.headers,
        });
        throw new Error(`HTTP ${response.statusCode}`, { cause });
      }

      return response;
    } catch (err) {
      // If the parent signal aborted, propagate immediately — no retries
      if (parentSignal?.aborted) throw err;
      lastError = err;

      if (attempt < maxAttempts) {
        const delay = jitteredDelay(attempt, retryBaseMs);
        log(
          `retrying ${url} in ${delay}ms (attempt ${attempt}/${maxAttempts}): ${errorMessage(err)}`,
        );
        await sleep(delay, undefined, parentSignal ? { signal: parentSignal } : undefined);
        continue;
      }
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  throw lastError;
}
