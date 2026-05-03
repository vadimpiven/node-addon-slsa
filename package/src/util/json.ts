// SPDX-License-Identifier: Apache-2.0 OR MIT

/** Size-bounded JSON body reader for HTTP responses. */

import type { Readable } from "node:stream";

/**
 * Read a Node.js Readable body as JSON with an upper bound on total bytes.
 * Aborts mid-stream if the limit is exceeded to prevent memory exhaustion.
 * Returns `unknown` — callers should validate with Zod.
 */
export async function readJsonBounded(body: Readable, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.byteLength;
    if (totalBytes > maxBytes) {
      body.destroy();
      throw new Error(`JSON response too large: exceeded ${maxBytes} byte limit`);
    }
    chunks.push(buf);
  }

  return JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8"));
}

if (import.meta.vitest) {
  const { Readable } = await import("node:stream");
  const { describe, it } = import.meta.vitest;

  describe("readJsonBounded", () => {
    it("parses valid JSON within bounds", async ({ expect }) => {
      const json = JSON.stringify({ key: "value" });
      const body = Readable.from([Buffer.from(json)]);
      const result = await readJsonBounded(body, 1024);
      expect(result).toEqual({ key: "value" });
    });

    it("throws when body exceeds maxBytes", async ({ expect }) => {
      const json = JSON.stringify({ data: "x".repeat(100) });
      const body = Readable.from([Buffer.from(json)]);
      await expect(readJsonBounded(body, 10)).rejects.toThrow(/too large.*exceeded.*10 byte/);
    });

    it("handles non-Buffer chunks", async ({ expect }) => {
      // Readable.from with string chunks (not Buffers)
      const body = Readable.from(['{"ok":true}']);
      const result = await readJsonBounded(body, 1024);
      expect(result).toEqual({ ok: true });
    });
  });
}
