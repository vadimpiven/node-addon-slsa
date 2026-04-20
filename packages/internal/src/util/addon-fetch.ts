// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Shared helper for the publish-side GitHub Actions (`attest-addons`,
 * `verify-addons`): fetch an addon URL under a size cap, stream-hash it,
 * and return the hex sha256. Centralises the error messages and the
 * body-drain cleanup so both actions behave identically under the same
 * failure modes.
 */

import { createHash } from "node:crypto";

import type { Dispatcher } from "undici";

import { fetchWithRetry } from "../http.ts";

export type FetchAndHashAddonOptions = {
  readonly maxBinaryBytes: number;
  readonly maxBinaryMs: number;
  /** Human-readable label (e.g. `linux/x64`) used in error messages. */
  readonly label: string;
  /** Passed through to {@link fetchWithRetry}. */
  readonly retryCount?: number | undefined;
  /** Retry on 404 — useful right after upload while CDNs propagate. */
  readonly retryOn404?: boolean | undefined;
  /** Optional dispatcher (tests inject a MockAgent; operators inject a proxy). */
  readonly dispatcher?: Dispatcher | undefined;
};

/**
 * Fetch `url`, enforce `maxBinaryBytes` at both the `Content-Length`
 * header and the streaming body level, and return the hex sha256 of
 * the bytes received. Throws on HTTP ≥ 400 or any cap overflow.
 * The response body is always drained before returning — callers don't
 * need their own cleanup.
 */
export async function fetchAndHashAddon(
  url: string,
  opts: FetchAndHashAddonOptions,
): Promise<string> {
  const { statusCode, headers, body } = await fetchWithRetry(url, {
    timeoutMs: opts.maxBinaryMs,
    stallTimeoutMs: opts.maxBinaryMs,
    retryCount: opts.retryCount,
    retryOn404: opts.retryOn404,
    dispatcher: opts.dispatcher,
  });
  try {
    if (statusCode >= 400) {
      throw new Error(`${opts.label}: ${url} → HTTP ${statusCode}`);
    }
    const declared = Number(headers["content-length"] ?? 0);
    if (declared > opts.maxBinaryBytes) {
      throw new Error(
        `${opts.label}: Content-Length ${declared} exceeds cap ${opts.maxBinaryBytes}`,
      );
    }
    const hash = createHash("sha256");
    let seen = 0;
    for await (const chunk of body) {
      seen += chunk.length;
      if (seen > opts.maxBinaryBytes) {
        throw new Error(`${opts.label}: body exceeds cap ${opts.maxBinaryBytes} bytes`);
      }
      hash.update(chunk);
    }
    return hash.digest("hex");
  } finally {
    // Drain any unread bytes — the loop above normally consumes everything,
    // but throws leave the stream partially buffered. Swallow errors here:
    // the stream may already be torn down, which is not actionable.
    body.dump().catch(() => {});
  }
}
