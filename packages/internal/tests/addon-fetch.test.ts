// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Integration-level coverage for `fetchAndHashAddon`: it must hash the
 * body served *after* any 3xx redirects, because GitHub release-asset
 * URLs return 302 → S3-backed storage. A prior regression let the empty
 * 302 body be hashed (SHA-256 e3b0c44...), silently breaking SLSA.
 */

import { createHash } from "node:crypto";
import { describe, it } from "vitest";

import { fetchAndHashAddon } from "../src/util/addon-fetch.ts";
import { mockFetch } from "./helpers/mock-fetch.ts";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("fetchAndHashAddon", () => {
  it("hashes the redirected body, not the empty 302 body", async ({ expect }) => {
    const payload = Buffer.from("addon bytes after redirect");
    const expected = createHash("sha256").update(payload).digest("hex");
    await using dispatcher = mockFetch(({ path }) => {
      if (path === "/release/asset") {
        return {
          statusCode: 302,
          data: "",
          responseOptions: { headers: { location: "https://cdn.example.com/real" } },
        };
      }
      return {
        statusCode: 200,
        data: payload,
        responseOptions: { headers: { "content-length": String(payload.length) } },
      };
    });

    const sha256 = await fetchAndHashAddon("https://github.example/release/asset", {
      maxBinaryBytes: 1 << 20,
      maxBinaryMs: 30_000,
      label: "linux/x64",
      dispatcher,
    });

    expect(sha256).toBe(expected);
    expect(sha256).not.toBe(EMPTY_SHA256);
  });

  it("rejects when the final redirected response is ≥ 400", async ({ expect }) => {
    await using dispatcher = mockFetch(({ path }) => {
      if (path === "/gone") {
        return {
          statusCode: 302,
          data: "",
          responseOptions: { headers: { location: "https://cdn.example.com/missing" } },
        };
      }
      return { statusCode: 404, data: "" };
    });

    await expect(
      fetchAndHashAddon("https://github.example/gone", {
        maxBinaryBytes: 1 << 20,
        maxBinaryMs: 30_000,
        label: "linux/x64",
        dispatcher,
      }),
    ).rejects.toThrow(/HTTP 404/);
  });
});
