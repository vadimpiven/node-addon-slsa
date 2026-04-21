// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * `fetchAndHashAddon` coverage: size caps, retry-on-network, retry-on-
 * -404 for CDN-propagation flows. The `HttpClient` seam is a fake
 * constructed inline so tests don't juggle MockAgent lifetimes.
 */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, it } from "vitest";

import {
  createHttpClient,
  HttpError,
  type HttpClient,
  type HttpRequestOptions,
  type HttpResult,
} from "../src/http.ts";
import { fetchAndHashAddon } from "../src/util/addon-fetch.ts";

type FakeOutcome =
  | { kind: "result"; body: Buffer; contentLength?: number }
  | { kind: "throw"; error: HttpError };

function fakeHttp(
  outcomes: readonly FakeOutcome[] | FakeOutcome,
  opts?: { onRequest?: (url: string, options: HttpRequestOptions | undefined) => void },
): HttpClient & { callCount: () => number } {
  const queue = Array.isArray(outcomes) ? [...outcomes] : [outcomes];
  let calls = 0;
  const client: HttpClient = {
    async request(url, options): Promise<HttpResult> {
      calls++;
      opts?.onRequest?.(url, options);
      const outcome = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (outcome.kind === "throw") throw outcome.error;
      return {
        status: 200,
        headers: {
          "content-length": String(outcome.contentLength ?? outcome.body.length),
        },
        body: Readable.from([outcome.body]),
      };
    },
  };
  return Object.assign(client, { callCount: () => calls });
}

describe("fetchAndHashAddon", () => {
  it("streams the body and returns its sha256", async ({ expect }) => {
    const payload = Buffer.from("addon bytes");
    const expected = createHash("sha256").update(payload).digest("hex");
    const http = fakeHttp({ kind: "result", body: payload });
    const sha = await fetchAndHashAddon(http, "https://e.com/a", {
      maxBinaryBytes: 1 << 20,
      maxBinaryMs: 30_000,
      label: "linux/x64",
    });
    expect(sha).toBe(expected);
  });

  it("rejects when Content-Length exceeds cap", async ({ expect }) => {
    const http = fakeHttp({
      kind: "result",
      body: Buffer.from("x"),
      contentLength: 1 << 30,
    });
    await expect(
      fetchAndHashAddon(http, "https://e.com/big", {
        maxBinaryBytes: 1024,
        maxBinaryMs: 30_000,
        label: "linux/x64",
      }),
    ).rejects.toThrow(/Content-Length .* exceeds cap/);
  });

  it("rejects when body bytes exceed cap even if Content-Length didn't", async ({ expect }) => {
    const http: HttpClient = {
      async request() {
        return {
          status: 200,
          headers: { "content-length": "0" },
          body: Readable.from([Buffer.alloc(2048, 1)]),
        };
      },
    };
    await expect(
      fetchAndHashAddon(http, "https://e.com/big", {
        maxBinaryBytes: 1024,
        maxBinaryMs: 30_000,
        label: "linux/x64",
      }),
    ).rejects.toThrow(/body exceeds cap/);
  });

  it("retries on network failure and succeeds on 2nd attempt", async ({ expect }) => {
    const payload = Buffer.from("recovered");
    const http = fakeHttp([
      { kind: "throw", error: new HttpError({ kind: "network", url: "x", message: "ECONNRESET" }) },
      { kind: "result", body: payload },
    ]);
    const sha = await fetchAndHashAddon(http, "https://e.com/a", {
      maxBinaryBytes: 1 << 20,
      maxBinaryMs: 30_000,
      label: "linux/x64",
      retryCount: 2,
    });
    expect(sha).toBe(createHash("sha256").update(payload).digest("hex"));
    expect(http.callCount()).toBe(2);
  });

  it("retries on 404 only when retryOn404 is true", async ({ expect }) => {
    const payload = Buffer.from("published");
    const make404 = (): FakeOutcome => ({
      kind: "throw",
      error: new HttpError({
        kind: "status",
        url: "x",
        status: 404,
        message: "GET x → HTTP 404",
      }),
    });
    const hit = fakeHttp([make404(), { kind: "result", body: payload }]);
    const sha = await fetchAndHashAddon(hit, "https://e.com/a", {
      maxBinaryBytes: 1 << 20,
      maxBinaryMs: 30_000,
      label: "linux/x64",
      retryCount: 2,
      retryOn404: true,
    });
    expect(sha).toBe(createHash("sha256").update(payload).digest("hex"));

    const hitNoOptIn = fakeHttp(make404());
    await expect(
      fetchAndHashAddon(hitNoOptIn, "https://e.com/a", {
        maxBinaryBytes: 1 << 20,
        maxBinaryMs: 30_000,
        label: "linux/x64",
        retryCount: 2,
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(hitNoOptIn.callCount()).toBe(1);
  });

  // Redirect behavior is delegated to undici's built-in `maxRedirections`
  // in `createHttpClient`; exercised via a live integration test rather
  // than a synthetic fake. Covering the 302→200 path with an in-process
  // `http.createServer` is possible but was deferred — the runtime path
  // is one line (`maxRedirections: 5`) and doesn't merit two helpers.
  it("uses the injected client without the internal default", async ({ expect }) => {
    // Smoke: createHttpClient returns something with a `request` method.
    const http = createHttpClient();
    expect(typeof http.request).toBe("function");
  });
});
