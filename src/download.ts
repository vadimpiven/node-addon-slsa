// SPDX-License-Identifier: Apache-2.0 OR MIT

import { setTimeout as sleep } from "node:timers/promises";

import type { FetchOptions } from "./types.ts";
import { log } from "./util/log.ts";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_STALL_TIMEOUT_MS = 30_000;
export const DEFAULT_RETRY_COUNT = 2;
export const DEFAULT_RETRY_BASE_MS = 500;

/** Exponential backoff with ±20% jitter to avoid thundering-herd collisions. */
function jitteredDelay(attempt: number, baseMs: number): number {
  const base = baseMs * 2 ** (attempt - 1);
  return Math.round(base * (0.8 + 0.4 * Math.random()));
}

/**
 * Web TransformStream that errors if no data arrives within the stall timeout.
 */
function createStallGuard(stallTimeoutMs: number): TransformStream<Uint8Array, Uint8Array> {
  let timer: ReturnType<typeof globalThis.setTimeout>;
  const resetTimer = (controller: TransformStreamDefaultController<Uint8Array>) => {
    globalThis.clearTimeout(timer);
    timer = globalThis.setTimeout(() => {
      controller.error(new Error(`download stalled: no data received for ${stallTimeoutMs}ms`));
    }, stallTimeoutMs);
  };
  return new TransformStream({
    start(controller) {
      resetTimer(controller);
    },
    transform(chunk, controller) {
      resetTimer(controller);
      controller.enqueue(chunk);
    },
    flush() {
      globalThis.clearTimeout(timer);
    },
  });
}

/**
 * Fetch with timeout, retry with exponential backoff, and stall guard.
 * Retries on network errors (fetch throws) and HTTP 5xx responses.
 * Does NOT retry on HTTP 4xx (callers handle 401/403/404 specifically).
 *
 * When `options.signal` is set, it is combined with the per-attempt
 * timeout via `AbortSignal.any()`. If the parent signal aborts, the
 * request is cancelled immediately and no further retries are attempted.
 *
 * When the response has a body, it is piped through a stall guard that
 * errors if no data arrives within `stallTimeoutMs`.
 */
export async function fetchWithRetry(url: string, options?: FetchOptions): Promise<Response> {
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

    // Combine per-attempt timeout with parent signal
    const signal = AbortSignal.any([ac.signal, parentSignal].filter((s) => !!s));

    try {
      const response = await fetch(url, {
        ...(options?.headers && { headers: options.headers }),
        signal,
      });

      if (response.status >= 500 && attempt < maxAttempts) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }

      if (!response.body) return response;

      const guardedBody = response.body.pipeThrough(createStallGuard(stallTimeoutMs));
      return new Response(guardedBody, response);
    } catch (err) {
      // If the parent signal aborted, propagate immediately — no retries
      if (parentSignal?.aborted) throw err;
      lastError = err;

      if (attempt < maxAttempts) {
        const delay = jitteredDelay(attempt, retryBaseMs);
        log(`retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`);
        await sleep(delay, undefined, { signal: parentSignal });
        continue;
      }
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  throw lastError;
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

  describe("createStallGuard", () => {
    it("errors when no data arrives within stall timeout", async ({ expect }) => {
      const guard = createStallGuard(50);
      const input = new ReadableStream({ start() {} }); // never pushes data
      const guarded = input.pipeThrough(guard);
      const reader = guarded.getReader();
      await expect(reader.read()).rejects.toThrow(/download stalled/);
    });
  });
}
