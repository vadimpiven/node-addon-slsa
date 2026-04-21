// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Single boundary for Rekor HTTP + schema concerns. Maps `HttpError`s
 * onto a closed `RekorError` union so upstream callers never re-derive
 * failure classification — an attacker-flooding vs ingestion-lag vs
 * server-down decision reads off `err.kind` in one place.
 */

import dedent from "dedent";

import { HttpError, type HttpClient } from "../http.ts";
import type { Sha256Hex } from "../types.ts";
import { readJsonBounded } from "../util/json.ts";
import { evalTemplate } from "../util/template.ts";
import { MAX_JSON_RESPONSE_BYTES, REKOR_NETWORK_ADVICE } from "./constants.ts";
import { RekorLogEntrySchema, RekorSearchResponseSchema, type RekorLogEntry } from "./schemas.ts";

export type RekorErrorKind =
  /** Per-entry endpoint 404'd — ingestion index committed but replication still in flight. */
  | "lag"
  /** 5xx / network / timeout. Server or path is unhealthy right now. */
  | "unavailable"
  /** Zod schema failure from Rekor's response — server bug or API drift. */
  | "malformed"
  /**
   * Response keyed by a UUID the caller didn't ask for. Treat as an active
   * tamper signal: a cooperative proxy, MITM, or future Rekor schema change
   * that returned multiple keys would otherwise let an attacker pin a
   * different entry under our UUID.
   */
  | "tamper";

/** Closed-union failure from a {@link RekorClient} call. */
export class RekorError extends Error {
  readonly kind: RekorErrorKind;
  readonly uuid?: string;

  constructor(opts: { kind: RekorErrorKind; message: string; uuid?: string; cause?: unknown }) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.kind = opts.kind;
    if (opts.uuid !== undefined) this.uuid = opts.uuid;
  }
}

export interface RekorClient {
  /** Look up candidate log UUIDs for an artifact hash. */
  search(sha256: Sha256Hex): Promise<readonly string[]>;
  /** Fetch a single log entry by UUID. */
  fetchEntry(uuid: string): Promise<RekorLogEntry>;
}

export type RekorClientOptions = {
  readonly http: HttpClient;
  readonly searchUrl: string;
  readonly entryUrl: string;
  readonly timeoutMs?: number;
};

function mapHttpError(err: unknown, uuid?: string): RekorError {
  if (err instanceof HttpError) {
    // 404 is only "lag" on the per-entry endpoint (replication catches
    // up after ingestion). A 404 on search is a misconfigured URL or API
    // drift — surface as unavailable so the label matches reality.
    if (err.kind === "status" && err.status === 404 && uuid !== undefined) {
      return new RekorError({
        kind: "lag",
        uuid,
        message: `Rekor entry ${uuid} not yet replicated (HTTP 404). ${REKOR_NETWORK_ADVICE}`,
        cause: err,
      });
    }
    return new RekorError({
      kind: "unavailable",
      ...(uuid !== undefined && { uuid }),
      message: `Rekor ${uuid ? `entry ${uuid}` : "search"} unavailable: ${err.message}. ${REKOR_NETWORK_ADVICE}`,
      cause: err,
    });
  }
  return new RekorError({
    kind: "malformed",
    ...(uuid !== undefined && { uuid }),
    message: dedent`
      Rekor response could not be parsed: ${err instanceof Error ? err.message : String(err)}.
      ${REKOR_NETWORK_ADVICE}
    `,
    cause: err,
  });
}

export function createRekorClient(opts: RekorClientOptions): RekorClient {
  const requestOpts = opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {};
  return {
    async search(sha256) {
      try {
        const result = await opts.http.request(opts.searchUrl, {
          ...requestOpts,
          method: "POST",
          body: JSON.stringify({ hash: `sha256:${sha256}` }),
          contentType: "application/json",
        });
        return RekorSearchResponseSchema.parse(
          await readJsonBounded(result.body, MAX_JSON_RESPONSE_BYTES),
        );
      } catch (err) {
        throw err instanceof RekorError ? err : mapHttpError(err);
      }
    },

    async fetchEntry(uuid) {
      const url = evalTemplate(opts.entryUrl, { uuid });
      try {
        const result = await opts.http.request(url, requestOpts);
        const data = RekorLogEntrySchema.parse(
          await readJsonBounded(result.body, MAX_JSON_RESPONSE_BYTES),
        );
        const entry = data[uuid];
        if (!entry) {
          // MITM / schema-change / cooperative-proxy signal — not a bug.
          // Alert distinctly from schema failures.
          throw new RekorError({
            kind: "tamper",
            uuid,
            message: `Rekor response for ${uuid} did not contain the requested UUID; keys: ${
              Object.keys(data).join(", ") || "(none)"
            }. ${REKOR_NETWORK_ADVICE}`,
          });
        }
        return entry;
      } catch (err) {
        throw err instanceof RekorError ? err : mapHttpError(err, uuid);
      }
    },
  };
}

if (import.meta.vitest) {
  const { describe, it } = await import("vitest");
  const { Readable } = await import("node:stream");
  const { sha256Hex } = await import("../types.ts");

  const searchUrl = "https://rekor.example/search";
  const entryUrl = "https://rekor.example/entries/{uuid}";

  function fakeHttp(
    handler: (url: string) => {
      status?: number;
      body?: string;
      error?: HttpError;
    },
  ): HttpClient {
    return {
      async request(url) {
        const r = handler(url);
        if (r.error) throw r.error;
        return {
          status: r.status ?? 200,
          headers: { "content-length": String((r.body ?? "").length) },
          body: Readable.from([Buffer.from(r.body ?? "")]) as never,
        };
      },
    };
  }

  describe("createRekorClient.search", () => {
    it("parses a valid search response", async ({ expect }) => {
      const client = createRekorClient({
        http: fakeHttp(() => ({ body: JSON.stringify(["a".repeat(80), "b".repeat(80)]) })),
        searchUrl,
        entryUrl,
      });
      const uuids = await client.search(sha256Hex("a".repeat(64)));
      expect(uuids).toEqual(["a".repeat(80), "b".repeat(80)]);
    });

    it("maps a 5xx HttpError to RekorError.kind=unavailable", async ({ expect }) => {
      const client = createRekorClient({
        http: fakeHttp(() => ({
          error: new HttpError({ kind: "status", url: searchUrl, status: 500, message: "boom" }),
        })),
        searchUrl,
        entryUrl,
      });
      const err = await client.search(sha256Hex("a".repeat(64))).catch((e) => e as unknown);
      expect(err).toBeInstanceOf(RekorError);
      expect((err as RekorError).kind).toBe("unavailable");
    });

    it("maps a 404 to `unavailable` (lag applies to entries, not search)", async ({ expect }) => {
      const client = createRekorClient({
        http: fakeHttp(() => ({
          error: new HttpError({ kind: "status", url: searchUrl, status: 404, message: "not found" }),
        })),
        searchUrl,
        entryUrl,
      });
      const err = await client.search(sha256Hex("a".repeat(64))).catch((e) => e as unknown);
      expect(err).toBeInstanceOf(RekorError);
      expect((err as RekorError).kind).toBe("unavailable");
    });

    it("maps a malformed body to RekorError.kind=malformed", async ({ expect }) => {
      const client = createRekorClient({
        http: fakeHttp(() => ({ body: "not json" })),
        searchUrl,
        entryUrl,
      });
      const err = await client.search(sha256Hex("a".repeat(64))).catch((e) => e as unknown);
      expect(err).toBeInstanceOf(RekorError);
      expect((err as RekorError).kind).toBe("malformed");
    });
  });

  describe("createRekorClient.fetchEntry", () => {
    const UUID = "a".repeat(80);
    // Accept-any RekorLogEntry shape — only the map-keyed lookup is exercised.
    const minimalEntry = {
      body: Buffer.from("{}").toString("base64"),
      integratedTime: 0,
      logID: "00".repeat(32),
      logIndex: 0,
      attestation: { data: Buffer.from("{}").toString("base64") },
      verification: {
        inclusionProof: {
          checkpoint: "x",
          hashes: ["00".repeat(32)],
          logIndex: 1,
          rootHash: "00".repeat(32),
          treeSize: 2,
        },
        signedEntryTimestamp: "AA==",
      },
    };

    it("returns the entry when the response keys it by the requested UUID", async ({ expect }) => {
      const client = createRekorClient({
        http: fakeHttp(() => ({ body: JSON.stringify({ [UUID]: minimalEntry }) })),
        searchUrl,
        entryUrl,
      });
      const entry = await client.fetchEntry(UUID);
      expect(entry).toMatchObject({ logIndex: 0 });
    });

    it("maps a 404 HttpError to RekorError.kind=lag", async ({ expect }) => {
      const client = createRekorClient({
        http: fakeHttp(() => ({
          error: new HttpError({
            kind: "status",
            url: "x",
            status: 404,
            message: "HTTP 404",
          }),
        })),
        searchUrl,
        entryUrl,
      });
      const err = await client.fetchEntry(UUID).catch((e) => e as unknown);
      expect(err).toBeInstanceOf(RekorError);
      expect((err as RekorError).kind).toBe("lag");
      expect((err as RekorError).uuid).toBe(UUID);
    });

    it("maps a network HttpError to RekorError.kind=unavailable", async ({ expect }) => {
      const client = createRekorClient({
        http: fakeHttp(() => ({
          error: new HttpError({ kind: "network", url: "x", message: "ECONNRESET" }),
        })),
        searchUrl,
        entryUrl,
      });
      const err = await client.fetchEntry(UUID).catch((e) => e as unknown);
      expect(err).toBeInstanceOf(RekorError);
      expect((err as RekorError).kind).toBe("unavailable");
    });

    it("signals `tamper` on a response keyed by the wrong UUID", async ({ expect }) => {
      const client = createRekorClient({
        http: fakeHttp(() => ({ body: JSON.stringify({ "different-uuid": minimalEntry }) })),
        searchUrl,
        entryUrl,
      });
      const err = await client.fetchEntry(UUID).catch((e) => e as unknown);
      expect(err).toBeInstanceOf(RekorError);
      expect((err as RekorError).kind).toBe("tamper");
    });
  });
}
