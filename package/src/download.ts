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
 * Wraps a ReadableStream with a stall guard that errors if no data
 * arrives within the stall timeout. The timer only runs while data is
 * being pulled, so unconsumed streams do not leak timers.
 */
function applyStallGuard(
  source: ReadableStream<Uint8Array>,
  stallTimeoutMs: number,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  // Guards against the timer or cancel() racing with an in-flight pull().
  let interrupted = false;

  return new ReadableStream({
    async pull(controller) {
      timer = globalThis.setTimeout(() => {
        interrupted = true;
        controller.error(new Error(`download stalled: no data received for ${stallTimeoutMs}ms`));
        reader.cancel().catch(() => {});
      }, stallTimeoutMs);

      try {
        const { done, value } = await reader.read();
        if (interrupted) return;
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        if (interrupted) return;
        controller.error(err);
      } finally {
        globalThis.clearTimeout(timer);
      }
    },
    cancel(reason) {
      interrupted = true;
      globalThis.clearTimeout(timer);
      return reader.cancel(reason);
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
 * When the response has a body, it is wrapped with a stall guard that
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

      const guardedBody = applyStallGuard(response.body, stallTimeoutMs);
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

  describe("applyStallGuard", () => {
    it("errors when no data arrives within stall timeout", async ({ expect }) => {
      const input = new ReadableStream<Uint8Array>({ start() {} });
      const guarded = applyStallGuard(input, 50);
      const reader = guarded.getReader();
      await expect(reader.read()).rejects.toThrow(/download stalled/);
    });

    it("propagates upstream errors", async ({ expect }) => {
      const input = new ReadableStream<Uint8Array>({
        pull() {
          throw new Error("upstream failure");
        },
      });
      const guarded = applyStallGuard(input, 30_000);
      const reader = guarded.getReader();
      await expect(reader.read()).rejects.toThrow(/upstream failure/);
    });
  });
}
