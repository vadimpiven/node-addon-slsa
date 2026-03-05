// SPDX-License-Identifier: Apache-2.0 OR MIT

import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, it, vi } from "vitest";

import {
  createHashPassthrough,
  fetchStream,
  fetchWithTimeout,
  readJsonBounded,
} from "../src/download.ts";
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

describe("fetchWithTimeout (retry)", () => {
  it("retries on network error and succeeds on 2nd attempt", async ({ expect }) => {
    vi.useFakeTimers();
    let calls = 0;
    using _fetch = stubFetch(async () => {
      calls++;
      if (calls === 1) throw new Error("network error");
      return new Response(null, { status: 200 });
    });
    const promise = fetchWithTimeout("https://example.com/retry");
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
    const promise = fetchWithTimeout("https://example.com/retry");
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
    const res = await fetchWithTimeout("https://example.com/missing");
    expect(res.status).toBe(404);
    expect(calls).toBe(1);
  });

  it("throws after exhausting retries on persistent network error", async ({ expect }) => {
    let calls = 0;
    using _fetch = stubFetch(async () => {
      calls++;
      throw new Error("network error");
    });
    await expect(fetchWithTimeout("https://example.com/fail")).rejects.toThrow("network error");
    expect(calls).toBe(3);
  });

  it("returns 5xx response on final attempt", async ({ expect }) => {
    let calls = 0;
    using _fetch = stubFetch(async () => {
      calls++;
      return new Response(null, { status: 502 });
    });
    const res = await fetchWithTimeout("https://example.com/fail");
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
      fetchWithTimeout("https://example.com/fail", undefined, {
        retryCount: 0,
      }),
    ).rejects.toThrow("network error");
    expect(calls).toBe(1);
  });
});

describe("fetchStream", () => {
  it("delivers response body as a Readable stream", async ({ expect }) => {
    const data = Buffer.from("response body bytes");
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
    using _fetch = stubFetch(async () => new Response(body, { status: 200 }));
    const readable = await fetchStream("https://example.com/file");
    const chunks: Buffer[] = [];
    for await (const chunk of readable) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(data);
  });

  it("rejects non-ok HTTP responses with status details", async ({ expect }) => {
    using _fetch = stubFetch(
      async () => new Response(null, { status: 404, statusText: "Not Found" }),
    );
    await expect(fetchStream("https://example.com/missing")).rejects.toThrow(/404.*Not Found/);
  });

  it("rejects response with missing body", async ({ expect }) => {
    using _fetch = stubFetch(
      async () => ({ ok: true, body: null, status: 200, statusText: "OK" }) as Response,
    );
    await expect(fetchStream("https://example.com/empty")).rejects.toThrow("body is empty");
  });
});

describe("readJsonBounded", () => {
  it("parses valid JSON within bounds", async ({ expect }) => {
    const json = JSON.stringify({ key: "value" });
    const response = new Response(json);
    const result = await readJsonBounded(response, 1024);
    expect(result).toEqual({ key: "value" });
  });

  it("throws when response exceeds maxBytes", async ({ expect }) => {
    const json = JSON.stringify({ data: "x".repeat(100) });
    const response = new Response(json);
    await expect(readJsonBounded(response, 10)).rejects.toThrow(/too large.*exceeded.*10 byte/);
  });

  it("falls back to response.text() when body is null", async ({ expect }) => {
    const response = {
      body: null,
      text: async () => '{"ok":true}',
    } as unknown as Response;
    const result = await readJsonBounded(response, 1024);
    expect(result).toEqual({ ok: true });
  });
});
