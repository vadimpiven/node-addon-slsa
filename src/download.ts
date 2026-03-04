// SPDX-License-Identifier: Apache-2.0 OR MIT

import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";

export const FETCH_TIMEOUT_MS = 30_000;

/**
 * Fetch with a timeout that aborts the request after FETCH_TIMEOUT_MS.
 */
export async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/**
 * Fetch a URL and return the response body as a Node.js Readable stream.
 */
export async function fetchStream(url: string): Promise<Readable> {
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`download failed: ${url}: ${response.status} ${response.statusText}`);
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
export function createHashPassthrough(): { stream: Transform; digest: () => string } {
  const hash = createHash("sha256");
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return { stream, digest: () => hash.digest("hex") };
}

if (import.meta.vitest) {
  const { describe, it, vi } = import.meta.vitest;

  describe("createHashPassthrough", () => {
    it("produces correct SHA-256 and preserves data", async ({ expect }) => {
      const { createHash: createHash2 } = await import("node:crypto");
      const { Writable } = await import("node:stream");
      const { pipeline } = await import("node:stream/promises");

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

      const expected = createHash2("sha256").update(input).digest("hex");
      expect(digest()).toBe(expected);
      expect(Buffer.concat(chunks)).toEqual(input);
    });
  });

  function stubFetch(impl: typeof fetch): Disposable {
    vi.stubGlobal("fetch", impl);
    return { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  }

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
}
