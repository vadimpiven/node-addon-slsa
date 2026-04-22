// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Live coverage for {@link createHttpClient}: an in-process
 * `http.createServer` stands in for real endpoints so undici's built-in
 * `maxRedirections`, abort, and status-code paths all run as they do in
 * production. MockAgent bypasses the RedirectHandler; a real server does
 * not, so this is the only place 302-following is asserted.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { Agent } from "undici";
import { describe, it } from "vitest";

import { createHttpClient, HttpError } from "../src/http.ts";

type Handler = (req: IncomingMessage, res: ServerResponse, base: string) => void;

async function withServer<T>(handler: Handler, fn: (base: string) => Promise<T>): Promise<T> {
  const server: Server = createServer((req, res) => handler(req, res, baseURL()));
  function baseURL(): string {
    const addr = server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(baseURL());
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

async function drain(body: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

describe("createHttpClient", () => {
  it("returns status + headers + body on 2xx", async ({ expect }) => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("hello");
      },
      async (base) => {
        const http = createHttpClient();
        const result = await http.request(`${base}/ok`);
        expect(result.status).toBe(200);
        expect(result.headers["content-type"]).toBe("text/plain");
        expect(await drain(result.body)).toBe("hello");
      },
    );
  });

  it("follows a cross-origin 302 to the final response body", async ({ expect }) => {
    // Two servers — GitHub (302) → CDN (200) — mirrors the real addon-
    // fetch flow. undici's maxRedirections handles the hop; the
    // RedirectHandler re-dispatches via the same Agent.
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end("final-bytes");
      },
      async (cdnBase) => {
        await withServer(
          (_req, res) => {
            res.writeHead(302, { location: `${cdnBase}/real` });
            res.end();
          },
          async (ghBase) => {
            const http = createHttpClient();
            const result = await http.request(`${ghBase}/asset`);
            expect(result.status).toBe(200);
            expect(await drain(result.body)).toBe("final-bytes");
          },
        );
      },
    );
  });

  it("follows 302 even when the caller supplies a bare dispatcher", async ({ expect }) => {
    // Regression: the action entrypoints pass `getGlobalDispatcher()` into
    // `createHttpClient`. The global dispatcher has no redirect interceptor
    // composed, so redirects silently dropped out, the empty 302 body
    // hashed to `e3b0c44...` (SHA-256 of the empty string), and Rekor lookup
    // matched on an unrelated artifact's log entry. Redirect-following must
    // be applied regardless of which dispatcher the caller hands in.
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end("final-bytes");
      },
      async (cdnBase) => {
        await withServer(
          (_req, res) => {
            res.writeHead(302, { location: `${cdnBase}/real` });
            res.end();
          },
          async (ghBase) => {
            const bare = new Agent({
              allowH2: false,
              keepAliveTimeout: 1,
              keepAliveMaxTimeout: 1,
            });
            try {
              const http = createHttpClient({ dispatcher: bare });
              const result = await http.request(`${ghBase}/asset`);
              expect(result.status).toBe(200);
              expect(await drain(result.body)).toBe("final-bytes");
            } finally {
              await bare.close();
            }
          },
        );
      },
    );
  });

  it("throws HttpError (kind: status) on 4xx", async ({ expect }) => {
    await withServer(
      (_req, res) => {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("missing");
      },
      async (base) => {
        const http = createHttpClient();
        const err = await http.request(`${base}/missing`).catch((e) => e as unknown);
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).kind).toBe("status");
        expect((err as HttpError).status).toBe(404);
      },
    );
  });

  it("throws HttpError (kind: status) on 5xx", async ({ expect }) => {
    await withServer(
      (_req, res) => {
        res.writeHead(503);
        res.end();
      },
      async (base) => {
        const http = createHttpClient();
        const err = await http.request(`${base}/broken`).catch((e) => e as unknown);
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).kind).toBe("status");
        expect((err as HttpError).status).toBe(503);
      },
    );
  });

  it("throws HttpError (kind: network) when the peer closes mid-handshake", async ({ expect }) => {
    // Connect-refused: dial a port we didn't bind. Node's errno wraps
    // through undici into our mapper.
    const http = createHttpClient();
    const err = await http.request("http://127.0.0.1:1").catch((e) => e as unknown);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).kind).toBe("network");
  });
});
