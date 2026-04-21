// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Asserts the retry / abort / hash-passthrough contract of the low-level
 * HTTP helpers: `fetchWithRetry` backs off only on network errors and
 * 5xx responses (never 4xx), respects AbortSignal between attempts, and
 * `createHashPassthrough` preserves bytes while producing SHA-256.
 */

import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, it, vi } from "vitest";

import { fetchWithRetry } from "../src/http.ts";
import { createHashPassthrough } from "../src/util/hash.ts";
import { mockFetch, mockFetchError } from "./helpers/mock-fetch.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("createHashPassthrough", () => {
  it("produces correct SHA-256 and preserves data", async ({ expect }) => {
    const input = Buffer.from("hello world – provenance test data");
    const { stream, digest } = createHashPassthrough();

    const chunks: Buffer[] = [];
    await pipeline(
      Readable.from([input]),
      stream,
      new Writable({
        write(chunk, _enc, cb) {
          chunks.push(chunk);
          cb();
        },
      }),
    );

    const expected = createHash("sha256").update(input).digest("hex");
    expect(digest()).toBe(expected);
    expect(Buffer.concat(chunks)).toEqual(input);
  });
});

describe("fetchWithRetry (retry)", () => {
  it("retries on network error and succeeds on 2nd attempt", async ({ expect }) => {
    vi.useFakeTimers();
    let calls = 0;
    await using dispatcher = mockFetch(() => {
      calls++;
      if (calls === 1) throw new Error("network error");
      return { statusCode: 200, data: "" };
    });
    const promise = fetchWithRetry("https://example.com/retry", { dispatcher });
    await vi.advanceTimersByTimeAsync(1000);
    const res = await promise;
    expect(res.statusCode).toBe(200);
    expect(calls).toBe(2);
  });

  it("retries on 5xx and succeeds on 2nd attempt", async ({ expect }) => {
    vi.useFakeTimers();
    let calls = 0;
    await using dispatcher = mockFetch(() => {
      calls++;
      if (calls === 1) return { statusCode: 503, data: "" };
      return { statusCode: 200, data: "" };
    });
    const promise = fetchWithRetry("https://example.com/retry", { dispatcher });
    await vi.advanceTimersByTimeAsync(1000);
    const res = await promise;
    expect(res.statusCode).toBe(200);
    expect(calls).toBe(2);
  });

  it("does NOT retry on 4xx", async ({ expect }) => {
    let calls = 0;
    await using dispatcher = mockFetch(() => {
      calls++;
      return { statusCode: 404, data: "" };
    });
    const res = await fetchWithRetry("https://example.com/missing", { dispatcher });
    expect(res.statusCode).toBe(404);
    expect(calls).toBe(1);
  });

  it("throws after exhausting retries on persistent network error", async ({ expect }) => {
    await using dispatcher = mockFetchError(new Error("network error"));
    await expect(
      fetchWithRetry("https://example.com/fail", { retryBaseMs: 1, dispatcher }),
    ).rejects.toThrow("network error");
  });

  it("returns 5xx response on final attempt", async ({ expect }) => {
    let calls = 0;
    await using dispatcher = mockFetch(() => {
      calls++;
      return { statusCode: 502, data: "" };
    });
    const res = await fetchWithRetry("https://example.com/fail", { retryBaseMs: 1, dispatcher });
    expect(res.statusCode).toBe(502);
    expect(calls).toBe(3);
  });

  it("respects custom retryCount and retryBaseMs", async ({ expect }) => {
    await using dispatcher = mockFetchError(new Error("network error"));
    await expect(
      fetchWithRetry("https://example.com/fail", { retryCount: 0, dispatcher }),
    ).rejects.toThrow("network error");
  });

  it("rejects immediately with a pre-aborted signal", async ({ expect }) => {
    await using dispatcher = mockFetch(() => ({ statusCode: 200, data: "" }));
    const ac = new AbortController();
    ac.abort();
    await expect(
      fetchWithRetry("https://example.com/abort", {
        signal: ac.signal,
        retryCount: 2,
        dispatcher,
      }),
    ).rejects.toThrow();
  });

  it("does not retry when parent signal aborts between attempts", async ({ expect }) => {
    const ac = new AbortController();
    await using dispatcher = mockFetchError(new Error("transient"), 5);
    globalThis.setTimeout(() => ac.abort(), 50);
    await expect(
      fetchWithRetry("https://example.com/abort", {
        signal: ac.signal,
        retryCount: 2,
        retryBaseMs: 200,
        dispatcher,
      }),
    ).rejects.toThrow();
  });
});

describe("fetchWithRetry (redirects)", () => {
  // Reproduces the GitHub release-asset flow: the canonical URL responds
  // with 302 and empty body; the real bytes sit behind a CDN on a
  // different origin. Without redirect-following, `request()` returns
  // the 302 and `fetchAndHashAddon` hashes the empty body (SHA-256
  // e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855).
  it("follows 302 across origins and returns the final body", async ({ expect }) => {
    const payload = "actual addon bytes";
    let calls = 0;
    await using dispatcher = mockFetch(({ path }) => {
      calls++;
      if (path === "/asset") {
        return {
          statusCode: 302,
          data: "",
          responseOptions: { headers: { location: "https://cdn.example.com/real" } },
        };
      }
      return { statusCode: 200, data: payload };
    });
    const res = await fetchWithRetry("https://example.com/asset", { dispatcher });
    expect(res.statusCode).toBe(200);
    const chunks: Buffer[] = [];
    for await (const chunk of res.body) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe(payload);
    expect(calls).toBe(2);
  });

  it("drops Authorization when redirecting to a different origin", async ({ expect }) => {
    const seen: Array<{ host: string | undefined; auth: string | undefined }> = [];
    await using dispatcher = mockFetch(({ path, headers }) => {
      const h = normalizeHeaders(headers);
      seen.push({ host: h["host"], auth: h["authorization"] });
      if (path === "/asset") {
        return {
          statusCode: 302,
          data: "",
          responseOptions: { headers: { location: "https://cdn.example.com/real" } },
        };
      }
      return { statusCode: 200, data: "ok" };
    });
    const res = await fetchWithRetry("https://example.com/asset", {
      dispatcher,
      headers: { authorization: "Bearer secret" },
    });
    await res.body.dump();
    expect(seen).toHaveLength(2);
    expect(seen[0]?.auth).toBe("Bearer secret");
    expect(seen[1]?.auth).toBeUndefined();
  });

  it("keeps Authorization on same-origin redirects", async ({ expect }) => {
    const seen: string[] = [];
    await using dispatcher = mockFetch(({ path, headers }) => {
      const h = normalizeHeaders(headers);
      seen.push(h["authorization"] ?? "");
      if (path === "/asset") {
        return {
          statusCode: 302,
          data: "",
          responseOptions: { headers: { location: "/moved" } },
        };
      }
      return { statusCode: 200, data: "ok" };
    });
    const res = await fetchWithRetry("https://example.com/asset", {
      dispatcher,
      headers: { authorization: "Bearer secret" },
    });
    await res.body.dump();
    expect(seen).toEqual(["Bearer secret", "Bearer secret"]);
  });

  it("rewrites 303 non-GET to GET and drops the body", async ({ expect }) => {
    const seen: Array<{ method: string | undefined; body: string | undefined }> = [];
    await using dispatcher = mockFetch(({ path, method, body }) => {
      seen.push({
        method: typeof method === "string" ? method : undefined,
        body: typeof body === "string" ? body : undefined,
      });
      if (path === "/form") {
        return {
          statusCode: 303,
          data: "",
          responseOptions: { headers: { location: "/done" } },
        };
      }
      return { statusCode: 200, data: "ok" };
    });
    const res = await fetchWithRetry("https://example.com/form", {
      dispatcher,
      method: "POST",
      body: "payload=1",
    });
    await res.body.dump();
    expect(seen[0]).toEqual({ method: "POST", body: "payload=1" });
    expect(seen[1]).toEqual({ method: "GET", body: undefined });
  });

  it("preserves method and body on 307", async ({ expect }) => {
    const seen: Array<{ method: string | undefined; body: string | undefined }> = [];
    await using dispatcher = mockFetch(({ path, method, body }) => {
      seen.push({
        method: typeof method === "string" ? method : undefined,
        body: typeof body === "string" ? body : undefined,
      });
      if (path === "/api") {
        return {
          statusCode: 307,
          data: "",
          responseOptions: { headers: { location: "/api/v2" } },
        };
      }
      return { statusCode: 200, data: "ok" };
    });
    const res = await fetchWithRetry("https://example.com/api", {
      dispatcher,
      method: "POST",
      body: "payload=1",
    });
    await res.body.dump();
    expect(seen[0]).toEqual({ method: "POST", body: "payload=1" });
    expect(seen[1]).toEqual({ method: "POST", body: "payload=1" });
  });

  it("errors after MAX_REDIRECTIONS hops", async ({ expect }) => {
    let hop = 0;
    await using dispatcher = mockFetch(() => ({
      statusCode: 302,
      data: "",
      responseOptions: { headers: { location: `/hop${++hop}` } },
    }));
    await expect(
      fetchWithRetry("https://example.com/start", { dispatcher, retryCount: 0 }),
    ).rejects.toThrow(/too many redirects/);
  });

  it("refuses https→http protocol downgrade", async ({ expect }) => {
    await using dispatcher = mockFetch(() => ({
      statusCode: 302,
      data: "",
      responseOptions: { headers: { location: "http://attacker.example/asset" } },
    }));
    await expect(
      fetchWithRetry("https://example.com/asset", { dispatcher, retryCount: 0 }),
    ).rejects.toThrow(/downgrade redirect/);
  });

  it("errors on 3xx without Location header", async ({ expect }) => {
    await using dispatcher = mockFetch(() => ({ statusCode: 302, data: "" }));
    await expect(
      fetchWithRetry("https://example.com/bad", { dispatcher, retryCount: 0 }),
    ).rejects.toThrow(/without Location header/);
  });

  it("preserves the query string of a relative Location", async ({ expect }) => {
    const seen: string[] = [];
    await using dispatcher = mockFetch(({ path }) => {
      seen.push(path as string);
      if (path === "/start") {
        return {
          statusCode: 302,
          data: "",
          responseOptions: { headers: { location: "/final?token=abc" } },
        };
      }
      return { statusCode: 200, data: "ok" };
    });
    const res = await fetchWithRetry("https://example.com/start", { dispatcher });
    await res.body.dump();
    expect(seen).toEqual(["/start", "/final?token=abc"]);
  });
});

/**
 * MockInterceptor surfaces request headers as either a plain object or
 * a raw string-pair array depending on how undici framed the request.
 * Flatten to a lowercase-keyed map for assertions.
 */
function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      const key = headers[i];
      const val = headers[i + 1];
      if (typeof key === "string" && typeof val === "string") out[key.toLowerCase()] = val;
    }
    return out;
  }
  if (typeof headers === "object" && Symbol.iterator in (headers as object)) {
    for (const [k, v] of headers as Iterable<[string, string]>) {
      out[k.toLowerCase()] = v;
    }
    return out;
  }
  if (typeof headers === "object") {
    for (const [k, v] of Object.entries(headers as Record<string, string>)) {
      out[k.toLowerCase()] = v;
    }
  }
  return out;
}
