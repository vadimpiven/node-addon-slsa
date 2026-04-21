// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * `HttpClient` is the only IO boundary in this package. Callers see one
 * result type and one error type; classification (status vs network) is
 * attached to the error so downstream retry policies and domain adapters
 * can dispatch on `err.kind` / `err.status` without parsing messages or
 * reading `cause`.
 *
 * The default implementation wraps undici `request()` with
 * `maxRedirections: 5`. Redirects are NOT authorization-aware — callers
 * must not pass credentialed headers to URLs whose redirect targets they
 * don't control. All of this package's production callers hit public
 * endpoints (GitHub release assets → public CDN, public Rekor, npmjs.org
 * via `@actions/attest`), so the limitation is contractual only.
 */

import type { IncomingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

import { Agent, interceptors, request, type Dispatcher } from "undici";

import { errorMessage } from "./util/error.ts";

/** Per-request timeout used when {@link HttpRequestOptions.timeoutMs} is not supplied. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Stall / body / headers timeout used when {@link HttpRequestOptions.stallTimeoutMs} is not supplied. */
export const DEFAULT_STALL_TIMEOUT_MS = 30_000;

/** Shape of a successful HTTP response (status < 400). */
export type HttpResult = {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Readable;
};

/** Options every {@link HttpClient.request} accepts. */
export type HttpRequestOptions = {
  readonly method?: "GET" | "POST";
  /** Stringified body. Paired with {@link contentType}. */
  readonly body?: string;
  /** Sole request header we expose — enough for Rekor's JSON POST. */
  readonly contentType?: string;
  readonly signal?: AbortSignal;
  /** Overall request budget including redirects. */
  readonly timeoutMs?: number;
  /** Per-hop headers + body stall ceiling. */
  readonly stallTimeoutMs?: number;
};

export type HttpErrorKind = "status" | "network";

/**
 * Failure from {@link HttpClient.request}. `kind === "status"` means an
 * HTTP response came back with `status >= 400`; `kind === "network"`
 * covers timeouts, DNS, TLS, dispatcher errors, and aborts.
 */
export class HttpError extends Error {
  readonly kind: HttpErrorKind;
  readonly status?: number;
  readonly url: string;

  constructor(opts: {
    kind: HttpErrorKind;
    message: string;
    url: string;
    status?: number;
    cause?: unknown;
  }) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.kind = opts.kind;
    this.url = opts.url;
    if (opts.status !== undefined) this.status = opts.status;
  }
}

export interface HttpClient {
  request(url: string, options?: HttpRequestOptions): Promise<HttpResult>;
}

/**
 * HTTP/1.1 agent composed with the redirect interceptor (undici 8+
 * removed `maxRedirections` from `request()` in favour of this seam).
 * No keep-alive because the package issues a handful of sequential
 * requests to different hosts — pooling provides no benefit and
 * dangling sockets complicate test teardown.
 */
function createDefaultDispatcher(): Dispatcher {
  return new Agent({
    allowH2: false,
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
  }).compose(interceptors.redirect({ maxRedirections: 5 }));
}

/**
 * Build an {@link HttpClient}. Pass `dispatcher` to substitute a proxy
 * agent, mTLS agent, or test MockAgent; tests that assert redirect
 * behavior instead use an in-process `http.createServer` fixture so the
 * production `maxRedirections` path runs unmodified.
 */
export function createHttpClient(opts?: {
  readonly dispatcher?: Dispatcher | undefined;
}): HttpClient {
  const dispatcher = opts?.dispatcher ?? createDefaultDispatcher();
  return {
    async request(url, options = {}): Promise<HttpResult> {
      const method = options.method ?? "GET";
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;

      const ac = new AbortController();
      const timer = globalThis.setTimeout(() => ac.abort(), timeoutMs);
      const signal = options.signal ? AbortSignal.any([ac.signal, options.signal]) : ac.signal;

      try {
        const response = await request(url, {
          method,
          ...(options.body !== undefined && { body: options.body }),
          ...(options.contentType !== undefined && {
            headers: { "content-type": options.contentType },
          }),
          signal,
          dispatcher,
          headersTimeout: stallTimeoutMs,
          bodyTimeout: stallTimeoutMs,
        });
        if (response.statusCode >= 400) {
          await response.body.dump();
          throw new HttpError({
            kind: "status",
            url,
            status: response.statusCode,
            message: `${method} ${url} → HTTP ${response.statusCode}`,
          });
        }
        return {
          status: response.statusCode,
          headers: response.headers,
          body: response.body,
        };
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError({
          kind: "network",
          url,
          message: `${method} ${url} → ${errorMessage(err)}`,
          cause: err,
        });
      } finally {
        globalThis.clearTimeout(timer);
      }
    },
  };
}

/**
 * Higher-order retry. The classifier inspects the thrown error once and
 * returns either `{ retry: true, delayMs }` or `{ retry: false }`. This
 * single primitive replaces the package's previous in-band retry (inside
 * the old `fetchWithRetry`) and outer Rekor ingestion retry — both were
 * fragile specializations that re-derived the same decision from
 * different substrates.
 */
export type RetryDecision =
  | { readonly retry: true; readonly delayMs: number }
  | { readonly retry: false };

export async function withRetry<T>(
  fn: () => Promise<T>,
  classify: (err: unknown, attempt: number) => RetryDecision,
  options?: { readonly signal?: AbortSignal },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    options?.signal?.throwIfAborted();
    try {
      return await fn();
    } catch (err) {
      const decision = classify(err, attempt);
      if (!decision.retry) throw err;
      await sleep(
        decision.delayMs,
        undefined,
        options?.signal ? { signal: options.signal } : undefined,
      );
    }
  }
}

/** Exponential backoff with ±20% jitter. */
export function jitteredDelay(attempt: number, baseMs: number): number {
  const base = baseMs * 2 ** (attempt - 1);
  return Math.round(base * (0.8 + 0.4 * Math.random()));
}
