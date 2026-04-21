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
/**
 * Maximum 3xx hops `request()` will follow. GitHub release-asset URLs do
 * one redirect to an S3-backed CDN; 5 leaves headroom without inviting
 * open-redirect loops.
 */
const MAX_REDIRECTIONS = 5;

/**
 * Request headers that must be dropped when a redirect crosses origins.
 * RFC 9110 §15.4 plus the same list every browser and well-behaved HTTP
 * library strips (Authorization, Cookie, Proxy-Authorization) extended
 * with common custom auth headers some callers pass through. Callers are
 * expected to use these standard names for credentials — non-standard
 * custom tokens won't be stripped and must not be sent cross-origin.
 */
const CROSS_ORIGIN_STRIP = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
]);

/** Status codes that RFC 9110 §15.4 says rewrite the follow-up to GET. */
const RESET_TO_GET = new Set([301, 302, 303]);

/** Exponential backoff with ±20% jitter to avoid thundering-herd collisions. */
function jitteredDelay(attempt: number, baseMs: number): number {
  const base = baseMs * 2 ** (attempt - 1);
  return Math.round(base * (0.8 + 0.4 * Math.random()));
}

/**
 * Apply RFC 9110 redirect semantics to the follow-up request's
 * method/body/headers. Returns `null` if the follow-up would be invalid
 * (cross-origin rewrite of a body-carrying method that must stay that
 * method per 307/308 — we don't forward bodies across origins).
 */
function rewriteForRedirect(
  statusCode: number,
  method: string | undefined,
  body: string | undefined,
  headers: Record<string, string> | undefined,
  sameOrigin: boolean,
): {
  method: string | undefined;
  body: string | undefined;
  headers: Record<string, string> | undefined;
} {
  // 301/302/303: rewrite non-GET/HEAD to GET and drop the body.
  // 307/308: preserve method and body.
  const resetToGet =
    RESET_TO_GET.has(statusCode) && method !== undefined && method !== "GET" && method !== "HEAD";
  const nextMethod = resetToGet ? "GET" : method;
  const nextBody = resetToGet ? undefined : body;

  if (!headers) return { method: nextMethod, body: nextBody, headers: undefined };
  if (sameOrigin) return { method: nextMethod, body: nextBody, headers };

  const stripped: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!CROSS_ORIGIN_STRIP.has(k.toLowerCase())) stripped[k] = v;
  }
  return { method: nextMethod, body: nextBody, headers: stripped };
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
      // Manually follow 3xx redirects. GitHub release-asset URLs respond
      // 302 → S3-backed CDN; undici's built-in `maxRedirections` would
      // normally handle this, but it bypasses MockAgent (the redirect
      // handler re-dispatches via the global dispatcher), leaving our
      // tests unable to assert the behavior. Implementing redirects here
      // keeps both runtime and test coverage on the same code path.
      // RFC 9110 §15.4: strip `Authorization`/`Cookie` cross-origin and
      // rewrite 301/302/303 non-GET to GET.
      const dispatcher = options?.dispatcher ?? defaultDispatcher;
      const originalUrl = new URL(url);
      let currentUrl = url;
      let currentOrigin = originalUrl.origin;
      let currentMethod = options?.method;
      let currentBody = options?.body;
      let currentHeaders = options?.headers;
      let response: Awaited<ReturnType<typeof request>> | undefined;
      for (let redirects = 0; redirects <= MAX_REDIRECTIONS; redirects++) {
        response = await request(currentUrl, {
          ...(currentMethod !== undefined && { method: currentMethod }),
          ...(currentHeaders !== undefined && { headers: currentHeaders }),
          ...(currentBody !== undefined && { body: currentBody }),
          signal,
          dispatcher,
          // Per-hop header + body stall timers. A malicious server that
          // drips 302s could otherwise hold the connection forever within
          // the outer `timeoutMs` budget. `headersTimeout` caps each hop
          // before bytes start; `bodyTimeout` caps stalls during the body.
          headersTimeout: stallTimeoutMs,
          bodyTimeout: stallTimeoutMs,
        });
        // Anything outside 3xx is terminal. 304 Not Modified is also not
        // a redirect — it carries no Location — so exit before the
        // Location lookup below would wrongly throw.
        if (
          response.statusCode < 300 ||
          response.statusCode === 304 ||
          response.statusCode >= 400
        ) {
          break;
        }
        const location = response.headers["location"];
        const next = Array.isArray(location) ? location[0] : location;
        // A 3xx without Location is malformed (RFC 9110 §15.4) and would
        // leave our fetch-and-hash pipeline silently returning the empty
        // 3xx body — refuse it rather than paper over the server bug.
        if (!next) {
          await response.body.dump();
          throw new Error(`HTTP ${response.statusCode} without Location header at ${currentUrl}`);
        }
        if (redirects === MAX_REDIRECTIONS) {
          await response.body.dump();
          throw new Error(`too many redirects following ${url}`);
        }
        // Fully consume the 3xx body before re-requesting — leaving it
        // hanging would leak sockets on the test MockAgent and real Agents.
        await response.body.dump();
        const nextUrl = new URL(next, currentUrl);
        // Refuse protocol downgrades. A MITM on the 302 response would
        // otherwise steer this trust-critical fetch onto plaintext HTTP
        // where the response body is attacker-controlled end-to-end.
        if (originalUrl.protocol === "https:" && nextUrl.protocol !== "https:") {
          throw new Error(
            `refusing ${originalUrl.protocol}→${nextUrl.protocol} downgrade redirect at ${currentUrl}`,
          );
        }
        const sameOrigin = nextUrl.origin === currentOrigin;
        const rewritten = rewriteForRedirect(
          response.statusCode,
          currentMethod,
          currentBody,
          currentHeaders,
          sameOrigin,
        );
        currentUrl = nextUrl.toString();
        currentOrigin = nextUrl.origin;
        currentMethod = rewritten.method;
        currentBody = rewritten.body;
        currentHeaders = rewritten.headers;
      }
      // The loop body only breaks after assigning `response`; any other
      // exit path (throw) never reaches this line.
      if (!response) throw new Error("internal: redirect loop exited without a response");
      const finalResponse = response;

      const retryableStatus =
        finalResponse.statusCode >= 500 || (retryOn404 && finalResponse.statusCode === 404);
      if (retryableStatus && attempt < maxAttempts) {
        await finalResponse.body.dump();
        // Carry the status code + headers on the cause so retries+callers
        // can inspect them. `Error.cause` convention prefers an Error, so
        // we wrap them on a dedicated Error subtype rather than bare data.
        const cause = new Error(`HTTP ${finalResponse.statusCode}`);
        Object.assign(cause, {
          statusCode: finalResponse.statusCode,
          headers: finalResponse.headers,
        });
        throw new Error(`HTTP ${finalResponse.statusCode}`, { cause });
      }

      return finalResponse;
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
