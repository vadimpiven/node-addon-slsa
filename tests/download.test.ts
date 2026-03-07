// SPDX-License-Identifier: Apache-2.0 OR MIT

import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, it, vi } from "vitest";

import { fetchWithRetry } from "../src/download.ts";
import { createHashPassthrough } from "../src/util/hash.ts";
import { stubFetch } from "./helpers.ts";

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
    using _fetch = stubFetch(async () => {
      calls++;
      if (calls === 1) throw new Error("network error");
      return new Response(null, { status: 200 });
    });
    const promise = fetchWithRetry("https://example.com/retry");
    await vi.advanceTimersByTimeAsync(1000);
    const res = await promise;
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("retries on 5xx and succeeds on 2nd attempt", async ({ expect }) => {
    vi.useFakeTimers();
    let calls = 0;
    using _fetch = stubFetch(async () => {
      calls++;
      if (calls === 1) return new Response(null, { status: 503 });
      return new Response(null, { status: 200 });
    });
    const promise = fetchWithRetry("https://example.com/retry");
    await vi.advanceTimersByTimeAsync(1000);
    const res = await promise;
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("does NOT retry on 4xx", async ({ expect }) => {
    let calls = 0;
    using _fetch = stubFetch(async () => {
      calls++;
      return new Response(null, { status: 404, statusText: "Not Found" });
    });
    const res = await fetchWithRetry("https://example.com/missing");
    expect(res.status).toBe(404);
    expect(calls).toBe(1);
  });

  it("throws after exhausting retries on persistent network error", async ({ expect }) => {
    let calls = 0;
    using _fetch = stubFetch(async () => {
      calls++;
      throw new Error("network error");
    });
    await expect(fetchWithRetry("https://example.com/fail")).rejects.toThrow("network error");
    expect(calls).toBe(3);
  });

  it("returns 5xx response on final attempt", async ({ expect }) => {
    let calls = 0;
    using _fetch = stubFetch(async () => {
      calls++;
      return new Response(null, { status: 502 });
    });
    const res = await fetchWithRetry("https://example.com/fail");
    expect(res.status).toBe(502);
    expect(calls).toBe(3);
  });

  it("respects custom retryCount and retryBaseMs", async ({ expect }) => {
    let calls = 0;
    using _fetch = stubFetch(async () => {
      calls++;
      throw new Error("network error");
    });
    await expect(
      fetchWithRetry("https://example.com/fail", {
        retryCount: 0,
      }),
    ).rejects.toThrow("network error");
    expect(calls).toBe(1);
  });

  it("rejects immediately with a pre-aborted signal", async ({ expect }) => {
    let calls = 0;
    using _fetch = stubFetch(async () => {
      calls++;
      return new Response(null, { status: 200 });
    });
    const ac = new AbortController();
    ac.abort();
    await expect(
      fetchWithRetry("https://example.com/abort", {
        signal: ac.signal,
        retryCount: 2,
      }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("does not retry when parent signal aborts during fetch", async ({ expect }) => {
    vi.useFakeTimers();
    const ac = new AbortController();
    let calls = 0;
    using _fetch = stubFetch(async (_url, init?: RequestInit) => {
      calls++;
      ac.abort();
      init?.signal?.throwIfAborted();
      return new Response(null, { status: 200 });
    });
    await expect(
      fetchWithRetry("https://example.com/abort", {
        signal: ac.signal,
        retryCount: 2,
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});


