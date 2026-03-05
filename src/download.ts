// SPDX-License-Identifier: Apache-2.0 OR MIT

import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";

import dedent from "dedent";

import { setTimeout as sleep } from "node:timers/promises";

import { sha256Hex } from "./types.ts";
import type { Sha256Hex, VerifyOptions } from "./types.ts";
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
 * Fetch with a timeout and retry with exponential backoff.
 * Retries on network errors (fetch throws) and HTTP 5xx responses.
 * Does NOT retry on HTTP 4xx (callers handle 401/403/404 specifically).
 *
 * When `options.signal` is set, it is combined with the per-attempt
 * timeout via `AbortSignal.any()`. If the parent signal aborts, the
 * request is cancelled immediately and no further retries are attempted.
 */
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  options?: VerifyOptions,
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryCount = options?.retryCount ?? DEFAULT_RETRY_COUNT;
  const retryBaseMs = options?.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const parentSignal = options?.signal;
  const maxAttempts = 1 + retryCount;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Bail immediately if the parent signal is already aborted
    parentSignal?.throwIfAborted();
    const ac = new AbortController();
    const timer = globalThis.setTimeout(() => ac.abort(), timeoutMs);
    // Combine per-attempt timeout with parent signal (if provided)
    const signal = parentSignal ? AbortSignal.any([ac.signal, parentSignal]) : ac.signal;
    try {
      const response = await fetch(url, {
        ...init,
        signal,
      });
      if (response.status >= 500 && attempt < maxAttempts) {
        await response.body?.cancel();
        const delay = jitteredDelay(attempt, retryBaseMs);
        log(`HTTP ${response.status}, retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`);
        await sleep(delay);
        continue;
      }
      return response;
    } catch (err) {
      // If the parent signal aborted, propagate immediately — no retries
      if (parentSignal?.aborted) throw err;
      lastError = err;
      if (attempt < maxAttempts) {
        const delay = jitteredDelay(attempt, retryBaseMs);
        log(`fetch error, retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`);
        await sleep(delay);
        continue;
      }
    } finally {
      globalThis.clearTimeout(timer);
    }
  }
  throw lastError;
}

/**
 * Fetch a URL and return the response body as a Node.js Readable stream.
 */
export async function fetchStream(url: string, options?: VerifyOptions): Promise<Readable> {
  log(`fetch: ${url}`);
  const response = await fetchWithTimeout(url, undefined, options);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(dedent`
      download failed: ${url}: ${response.status} ${response.statusText}.
      Verify that the addon.url template in package.json resolves to a valid release asset.
    `);
  }
  if (!response.body) {
    throw new Error(`download failed: ${url}: response body is empty`);
  }
  return Readable.fromWeb(response.body);
}

/**
 * Create a pass-through Transform that computes a SHA-256 hash
 * of all data flowing through it. Call `digest()` after the
 * stream ends to get the hex hash.
 */
export function createHashPassthrough(): { stream: Transform; digest: () => Sha256Hex } {
  const hash = createHash("sha256");
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return { stream, digest: () => sha256Hex(hash.digest("hex")) };
}

/**
 * Transform that destroys itself if no data arrives within the stall timeout.
 * Insert into a pipeline() to abort stalled downloads.
 */
export function createStallGuard(options?: VerifyOptions): Transform {
  const stallTimeoutMs = options?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  let timer: ReturnType<typeof globalThis.setTimeout>;
  const arm = () => {
    globalThis.clearTimeout(timer);
    timer = globalThis.setTimeout(() => {
      guard.destroy(new Error(`download stalled: no data received for ${stallTimeoutMs}ms`));
    }, stallTimeoutMs);
  };
  const guard = new Transform({
    transform(chunk, _encoding, callback) {
      arm();
      callback(null, chunk);
    },
    flush(callback) {
      globalThis.clearTimeout(timer);
      callback();
    },
    destroy(_err, callback) {
      globalThis.clearTimeout(timer);
      callback(_err);
    },
  });
  arm(); // start timer for first chunk
  return guard;
}

/**
 * Read a Response body as JSON with an upper bound on total bytes.
 * Aborts mid-stream if the limit is exceeded to prevent memory exhaustion.
 * Returns `unknown` — callers should validate with Zod.
 */
export async function readJsonBounded(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) {
    return JSON.parse(await response.text());
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(`JSON response too large: exceeded ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = new TextDecoder().decode(
    chunks.length === 1 ? chunks[0] : concatUint8Arrays(chunks, totalBytes),
  );
  return JSON.parse(text);
}

function concatUint8Arrays(arrays: Uint8Array[], totalLength: number): Uint8Array {
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.byteLength;
  }
  return result;
}
