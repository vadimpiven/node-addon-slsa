// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Fetch an addon URL via {@link HttpClient}, enforce a size cap, and
 * return the hex sha256 of the body. Centralises the error messages and
 * body-drain cleanup so attest and verify behave identically.
 */

import { createHash } from "node:crypto";

import { HttpError, jitteredDelay, withRetry, type HttpClient } from "../http.ts";

export type FetchAndHashAddonOptions = {
  readonly maxBinaryBytes: number;
  readonly maxBinaryMs: number;
  /** Human-readable label (e.g. `linux/x64`) used in error messages. */
  readonly label: string;
  /** Retries per URL — addon URLs 404 briefly after a release is cut. Default: 3. */
  readonly retryCount?: number | undefined;
  /** Retry on 404 for CDN-propagation flows. Default: false. */
  readonly retryOn404?: boolean | undefined;
};

const RETRY_BASE_MS = 500;

/**
 * Fetch `url` via the given client, enforce `maxBinaryBytes` at both the
 * `Content-Length` header and the streaming body level, and return the
 * hex sha256 of the bytes received. Throws on HTTP failure or cap
 * overflow. The response body is always drained before returning.
 */
export async function fetchAndHashAddon(
  http: HttpClient,
  url: string,
  opts: FetchAndHashAddonOptions,
): Promise<string> {
  return withRetry(
    async () => {
      const result = await http.request(url, {
        timeoutMs: opts.maxBinaryMs,
        stallTimeoutMs: opts.maxBinaryMs,
      });
      const declared = Number(result.headers["content-length"] ?? 0);
      if (declared > opts.maxBinaryBytes) {
        result.body.destroy();
        throw new Error(
          `${opts.label}: Content-Length ${declared} exceeds cap ${opts.maxBinaryBytes}`,
        );
      }
      const hash = createHash("sha256");
      let seen = 0;
      try {
        for await (const chunk of result.body) {
          seen += chunk.length;
          if (seen > opts.maxBinaryBytes) {
            throw new Error(`${opts.label}: body exceeds cap ${opts.maxBinaryBytes} bytes`);
          }
          hash.update(chunk);
        }
      } finally {
        result.body.destroy();
      }
      return hash.digest("hex");
    },
    // Retry transient network/5xx; retry 404 only when the caller opts
    // in (publish-side CDN propagation). 4xx otherwise is a caller error.
    (err, attempt) => {
      const maxAttempts = 1 + (opts.retryCount ?? 3);
      if (attempt >= maxAttempts) return { retry: false };
      if (err instanceof HttpError) {
        if (err.kind === "network") return backoff(attempt);
        if (err.kind === "status") {
          if (err.status !== undefined && err.status >= 500) return backoff(attempt);
          if (opts.retryOn404 && err.status === 404) return backoff(attempt);
        }
      }
      return { retry: false };
    },
  );
}

function backoff(attempt: number): { retry: true; delayMs: number } {
  return { retry: true, delayMs: jitteredDelay(attempt, RETRY_BASE_MS) };
}
