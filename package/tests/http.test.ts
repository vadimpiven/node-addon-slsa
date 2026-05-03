// SPDX-License-Identifier: Apache-2.0 OR MIT

import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, it, vi } from "vitest";

import { fetchWithRetry } from "../src/http.ts";
import { createHashPassthrough } from "../src/util/hash.ts";
import { mockFetch, mockFetchError } from "./helpers.ts";

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
    // Abort after first attempt starts
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
