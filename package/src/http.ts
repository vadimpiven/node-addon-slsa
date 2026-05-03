// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * HTTP fetch with timeout, retry, and stall detection.
 * Uses undici's request() API — no WHATWG ReadableStream.
 * Configurable via {@link FetchOptions} (dispatcher, timeouts, retries).
 */

import { setTimeout as sleep } from "node:timers/promises";

import { Agent, request, type Dispatcher } from "undici";

import type { FetchOptions } from "./types.ts";
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

      if (response.statusCode >= 500 && attempt < maxAttempts) {
        await response.body.dump();
        throw new Error(`HTTP ${response.statusCode}`, {
          cause: { statusCode: response.statusCode, headers: response.headers },
        });
      }

      return response;
    } catch (err) {
      // If the parent signal aborted, propagate immediately — no retries
      if (parentSignal?.aborted) throw err;
      lastError = err;

      if (attempt < maxAttempts) {
        const delay = jitteredDelay(attempt, retryBaseMs);
        const reason = err instanceof Error ? err.message : String(err);
        log(`retrying ${url} in ${delay}ms (attempt ${attempt}/${maxAttempts}): ${reason}`);
        await sleep(delay, undefined, { signal: parentSignal });
        continue;
      }
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  throw lastError;
}
