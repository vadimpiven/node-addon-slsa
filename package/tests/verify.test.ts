// SPDX-License-Identifier: Apache-2.0 OR MIT

import { describe, it, vi } from "vitest";

import { sha256Hex } from "../src/types.ts";
import { ProvenanceError } from "../src/util/provenance-error.ts";
import { resolveConfig } from "../src/verify/config.ts";
import { fetchGitHubAttestations, fetchNpmAttestations } from "../src/verify/attestations.ts";
import { stubFetch } from "./helpers.ts";

const defaultConfig = resolveConfig({ retryCount: 0 });
const tinyBundleConfig = resolveConfig({ maxBundleBytes: 10, retryCount: 0 });

vi.setConfig({ testTimeout: 30_000 });

function stubEnvVar(key: string, value: string): Disposable {
  const original = process.env[key];
  vi.stubEnv(key, value);
  return {
    [Symbol.dispose]: () => {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    },
  };
}

describe("fetchNpmAttestations", () => {
  it("returns ProvenanceError on 404", async ({ expect }) => {
    using _fetch = stubFetch(
      async () => new Response(null, { status: 404, statusText: "Not Found" }),
    );
    await expect(
      fetchNpmAttestations({ packageName: "pkg", version: "1.0.0" }, defaultConfig),
    ).rejects.toThrow(ProvenanceError);
    await expect(
      fetchNpmAttestations({ packageName: "pkg", version: "1.0.0" }, defaultConfig),
    ).rejects.toThrow(/No provenance attestation found/);
  });

  it("propagates server error as regular Error (not ProvenanceError)", async ({ expect }) => {
    using _fetch = stubFetch(
      async () => new Response(null, { status: 500, statusText: "Server Error" }),
    );
    await expect(
      fetchNpmAttestations({ packageName: "pkg", version: "1.0.0" }, defaultConfig),
    ).rejects.toThrow(Error);
    await expect(
      fetchNpmAttestations({ packageName: "pkg", version: "1.0.0" }, defaultConfig),
    ).rejects.not.toThrow(ProvenanceError);
  });
});

describe("fetchGitHubAttestations", () => {
  const FAKE_HASH = sha256Hex("a".repeat(64));

  it("includes Authorization header when GITHUB_TOKEN is set", async ({ expect }) => {
    let capturedHeaders: Record<string, string> | undefined;
    using _fetch = stubFetch(async (_url, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string> | undefined;
      return new Response(JSON.stringify({ attestations: [] }), { status: 200 });
    });
    using _env = stubEnvVar("GITHUB_TOKEN", "ghp_test123");
    await fetchGitHubAttestations({ repo: "owner/repo", sha256: FAKE_HASH }, defaultConfig).catch(
      () => {},
    );
    expect(capturedHeaders).toHaveProperty("Authorization", "Bearer ghp_test123");
  });

  it("omits Authorization header when GITHUB_TOKEN is not set", async ({ expect }) => {
    let capturedHeaders: Record<string, string> | undefined;
    using _fetch = stubFetch(async (_url, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string> | undefined;
      return new Response(JSON.stringify({ attestations: [] }), { status: 200 });
    });
    using _env = stubEnvVar("GITHUB_TOKEN", "");
    await fetchGitHubAttestations({ repo: "owner/repo", sha256: FAKE_HASH }, defaultConfig).catch(
      () => {},
    );
    expect(capturedHeaders).not.toHaveProperty("Authorization");
  });

  it("returns ProvenanceError on 404", async ({ expect }) => {
    using _fetch = stubFetch(
      async () => new Response(null, { status: 404, statusText: "Not Found" }),
    );
    await expect(
      fetchGitHubAttestations({ repo: "owner/repo", sha256: FAKE_HASH }, defaultConfig),
    ).rejects.toThrow(ProvenanceError);
    await expect(
      fetchGitHubAttestations({ repo: "owner/repo", sha256: FAKE_HASH }, defaultConfig),
    ).rejects.toThrow(/No provenance attestation found/);
  });

  it("propagates server error as regular Error", async ({ expect }) => {
    using _fetch = stubFetch(
      async () => new Response(null, { status: 500, statusText: "Server Error" }),
    );
    await expect(
      fetchGitHubAttestations({ repo: "owner/repo", sha256: FAKE_HASH }, defaultConfig),
    ).rejects.toThrow(Error);
    await expect(
      fetchGitHubAttestations({ repo: "owner/repo", sha256: FAKE_HASH }, defaultConfig),
    ).rejects.not.toThrow(ProvenanceError);
  });

  it("throws auth error on 401 mentioning GITHUB_TOKEN", async ({ expect }) => {
    using _fetch = stubFetch(
      async () => new Response(null, { status: 401, statusText: "Unauthorized" }),
    );
    await expect(
      fetchGitHubAttestations({ repo: "owner/repo", sha256: FAKE_HASH }, defaultConfig),
    ).rejects.toThrow(/authentication failed.*GITHUB_TOKEN/);
  });

  it("throws rate-limit error on 403 with X-RateLimit-Remaining: 0", async ({ expect }) => {
    using _fetch = stubFetch(
      async () =>
        new Response(null, {
          status: 403,
          headers: { "X-RateLimit-Remaining": "0" },
        }),
    );
    using _env = stubEnvVar("GITHUB_TOKEN", "ghp_test");
    await expect(
      fetchGitHubAttestations({ repo: "owner/repo", sha256: FAKE_HASH }, defaultConfig),
    ).rejects.toThrow(/rate limit exceeded.*exhausted/);
    await expect(
      fetchGitHubAttestations({ repo: "owner/repo", sha256: FAKE_HASH }, defaultConfig),
    ).rejects.not.toThrow(ProvenanceError);
  });

  it("throws rate-limit error on 429", async ({ expect }) => {
    using _fetch = stubFetch(async () => new Response(null, { status: 429 }));
    using _env = stubEnvVar("GITHUB_TOKEN", "");
    await expect(
      fetchGitHubAttestations({ repo: "owner/repo", sha256: FAKE_HASH }, defaultConfig),
    ).rejects.toThrow(/rate limit exceeded.*GITHUB_TOKEN/);
  });

  it("falls through to generic error on 403 without rate-limit header", async ({ expect }) => {
    using _fetch = stubFetch(
      async () => new Response(null, { status: 403, statusText: "Forbidden" }),
    );
    await expect(
      fetchGitHubAttestations({ repo: "owner/repo", sha256: FAKE_HASH }, defaultConfig),
    ).rejects.toThrow(/403/);
    await expect(
      fetchGitHubAttestations({ repo: "owner/repo", sha256: FAKE_HASH }, defaultConfig),
    ).rejects.not.toThrow(/rate limit/);
  });

  it("returns ProvenanceError on empty attestation list", async ({ expect }) => {
    using _fetch = stubFetch(
      async () =>
        new Response(JSON.stringify({ attestations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(
      fetchGitHubAttestations({ repo: "owner/repo", sha256: FAKE_HASH }, defaultConfig),
    ).rejects.toThrow(ProvenanceError);
    await expect(
      fetchGitHubAttestations({ repo: "owner/repo", sha256: FAKE_HASH }, defaultConfig),
    ).rejects.toThrow(/No provenance attestation found/);
  });

  it("returns ProvenanceError when all bundle_url fetches fail", async ({ expect }) => {
    using _fetch = stubFetch(async (url: string | URL | Request) => {
      const urlString = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (new URL(urlString).hostname === "api.github.com") {
        return new Response(
          JSON.stringify({
            attestations: [{ bundle: null, bundle_url: "https://blob.example.com/b" }],
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 500, statusText: "Server Error" });
    });
    await expect(
      fetchGitHubAttestations({ repo: "owner/repo", sha256: FAKE_HASH }, defaultConfig),
    ).rejects.toThrow(ProvenanceError);
    await expect(
      fetchGitHubAttestations({ repo: "owner/repo", sha256: FAKE_HASH }, defaultConfig),
    ).rejects.toThrow(/No provenance attestation found/);
  });

  it("throws when Content-Length exceeds maxBundleBytes", async ({ expect }) => {
    using _fetch = stubFetch(async (url: string | URL | Request) => {
      const urlString = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (new URL(urlString).hostname === "api.github.com") {
        return new Response(
          JSON.stringify({
            attestations: [{ bundle: null, bundle_url: "https://blob.example.com/big" }],
          }),
          { status: 200 },
        );
      }
      return new Response("x", {
        status: 200,
        headers: { "Content-Length": "999999" },
      });
    });
    await expect(
      fetchGitHubAttestations({ repo: "owner/repo", sha256: FAKE_HASH }, tinyBundleConfig),
    ).rejects.toThrow(ProvenanceError);
  });

  it("throws when actual response body exceeds maxBundleBytes", async ({ expect }) => {
    using _fetch = stubFetch(async (url: string | URL | Request) => {
      const urlString = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (new URL(urlString).hostname === "api.github.com") {
        return new Response(
          JSON.stringify({
            attestations: [{ bundle: null, bundle_url: "https://blob.example.com/big" }],
          }),
          { status: 200 },
        );
      }
      // No Content-Length header, but body exceeds maxBundleBytes (10)
      return new Response("x".repeat(100), { status: 200 });
    });
    await expect(
      fetchGitHubAttestations({ repo: "owner/repo", sha256: FAKE_HASH }, tinyBundleConfig),
    ).rejects.toThrow(ProvenanceError);
  });
});
