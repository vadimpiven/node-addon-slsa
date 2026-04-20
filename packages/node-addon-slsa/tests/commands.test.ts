// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Asserts the behavior of the `wget` and `pack` commands: download +
 * decompress + sha256 match against the manifest, cleanup of partial
 * files on failure, size-cap enforcement (declared Content-Length and
 * streaming), zip-bomb protection via the decompression-ratio cap, and
 * path-traversal rejection in `addon.path`. `verifyPackageAt` is mocked
 * so the tests don't hit Rekor.
 */

import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { gunzip, gzipSync } from "node:zlib";

import { MockAgent } from "undici";
import { beforeEach, describe, it, vi } from "vitest";

import { SLSA_MANIFEST_V1_SCHEMA_URL, tempDir } from "@node-addon-slsa/internal";

import { pack, wget } from "../src/commands.ts";
import { FAKE_BINARY, FAKE_URL, writeTestManifest, writeTestPkg } from "./fixtures.ts";

const gunzipAsync = promisify(gunzip);

const { mockVerifyAddonBySha256 } = vi.hoisted(() => ({
  mockVerifyAddonBySha256: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@node-addon-slsa/internal", async (orig) => {
  const actual = await orig<typeof import("@node-addon-slsa/internal")>();
  return {
    ...actual,
    verifyPackageAt: vi.fn(async () => ({
      packageName: "node-reqwest",
      sourceRepo: "vadimpiven/node_reqwest",
      sourceCommit: "a".repeat(40),
      sourceRef: "refs/tags/v1.0.0",
      runInvocationURI: "https://github.com/vadimpiven/node_reqwest/actions/runs/1/attempts/1",
      verifyAddonBySha256: (sha: string) => mockVerifyAddonBySha256(sha),
      verifyAddonFromFile: (path: string) => mockVerifyAddonBySha256(path),
    })),
  };
});

beforeEach(() => {
  mockVerifyAddonBySha256.mockClear();
  delete process.env["SLSA_DEBUG"];
});

function mockDownload(status: number, body: Buffer | string): MockAgent & AsyncDisposable {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get("https://github.com")
    .intercept({
      path: /^\/vadimpiven\/node_reqwest\/releases\/download\//,
      method: "GET",
    })
    .reply(status, body);
  return Object.assign(agent, {
    async [Symbol.asyncDispose](): Promise<void> {
      await agent.close();
    },
  });
}

describe("wget", () => {
  it("skips verification for version 0.0.0 and warns", async ({ expect }) => {
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "0.0.0");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await wget(tmp.path);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("0.0.0"));
    spy.mockRestore();
  });

  it("throws when repository is not on GitHub", async ({ expect }) => {
    await using tmp = await tempDir();
    const pkg = {
      name: "test-pkg",
      version: "1.0.0",
      addon: { path: "./dist/test.node" },
      repository: "https://gitlab.com/owner/repo",
    };
    await writeFile(join(tmp.path, "package.json"), JSON.stringify(pkg));
    await expect(wget(tmp.path)).rejects.toThrow("could not determine expected repository");
  });

  it("downloads, decompresses, writes binary, and calls verifyAddon", async ({ expect }) => {
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "1.0.0");
    const gz = await writeTestManifest(tmp.path, "1.0.0");

    await using dispatcher = mockDownload(200, gz);
    await wget(tmp.path, { dispatcher });

    const written = await readFile(join(tmp.path, "dist", "node_reqwest.node"));
    expect(written).toEqual(FAKE_BINARY);
    expect(mockVerifyAddonBySha256).toHaveBeenCalledWith(expect.any(String));
  });

  it("cleans up temp file when verifyAddon rejects", async ({ expect }) => {
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "1.0.0");
    const gz = await writeTestManifest(tmp.path, "1.0.0");
    mockVerifyAddonBySha256.mockRejectedValueOnce(new Error("provenance failed"));

    await using dispatcher = mockDownload(200, gz);
    await expect(wget(tmp.path, { dispatcher })).rejects.toThrow("provenance failed");

    await expect(access(join(tmp.path, "dist", "node_reqwest.node"))).rejects.toThrow();
    const files = await readdir(join(tmp.path, "dist"));
    expect(files.filter((f) => f.startsWith(".tmp-"))).toHaveLength(0);
  });

  it("rejects on HTTP client-error download response", async ({ expect }) => {
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "1.0.0");
    await writeTestManifest(tmp.path, "1.0.0");

    // 400 is terminal in fetchWithRetry (only 5xx / opt-in 404 retry), so
    // the response surfaces to wget's statusCode guard.
    await using dispatcher = mockDownload(400, "bad request");
    await expect(wget(tmp.path, { dispatcher })).rejects.toThrow(/download failed.*400/);
  });

  it("rejects when Content-Length exceeds the size cap", async ({ expect }) => {
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "1.0.0");
    const gz = await writeTestManifest(tmp.path, "1.0.0");

    // Force Content-Length explicitly — MockAgent doesn't set it reliably,
    // and without it the in-stream cap would fire instead of the up-front one.
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get("https://github.com")
      .intercept({
        path: /^\/vadimpiven\/node_reqwest\/releases\/download\//,
        method: "GET",
      })
      .reply(200, gz, { headers: { "content-length": String(gz.length) } });
    await using dispatcher = Object.assign(agent, {
      async [Symbol.asyncDispose](): Promise<void> {
        await agent.close();
      },
    });
    await expect(wget(tmp.path, { dispatcher, maxBinaryBytes: 4 })).rejects.toThrow(
      /download exceeds size cap.*Content-Length/,
    );
  });

  it("rejects when wire bytes exceed the size cap (chunked, no Content-Length)", async ({
    expect,
  }) => {
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "1.0.0");
    const gz = await writeTestManifest(tmp.path, "1.0.0");

    // Strip Content-Length so the pre-stream check passes and the in-stream
    // cap fires instead. MockInterceptor lets us override headers per-reply.
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get("https://github.com")
      .intercept({
        path: /^\/vadimpiven\/node_reqwest\/releases\/download\//,
        method: "GET",
      })
      .reply(200, gz, { headers: { "content-length": "0", "transfer-encoding": "chunked" } });
    await using dispatcher = Object.assign(agent, {
      async [Symbol.asyncDispose](): Promise<void> {
        await agent.close();
      },
    });
    await expect(wget(tmp.path, { dispatcher, maxBinaryBytes: 4 })).rejects.toThrow(
      /download exceeds size cap.*seen=/,
    );
  });

  it("rejects zip-bomb: decompressed payload exceeds ratio cap", async ({ expect }) => {
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "1.0.0");

    // 9 KiB of zero bytes compresses to ~30 B; with maxBinaryBytes=100 and
    // DECOMPRESSION_RATIO_LIMIT=8 (800 B decompressed cap), this trips the
    // per-chunk decompressed cap before sha256 can fire.
    const bigBinary = Buffer.alloc(9 * 1024);
    const gz = gzipSync(bigBinary);
    const sha256 = createHash("sha256").update(gz).digest("hex");
    const manifest = {
      $schema: SLSA_MANIFEST_V1_SCHEMA_URL,
      packageName: "node-reqwest",
      runInvocationURI: "https://github.com/vadimpiven/node_reqwest/actions/runs/1/attempts/1",
      sourceRepo: "vadimpiven/node_reqwest",
      sourceCommit: "a".repeat(40),
      sourceRef: "refs/tags/v1.0.0",
      addons: { [process.platform]: { [process.arch]: { url: FAKE_URL, sha256 } } },
    };
    await writeFile(join(tmp.path, "slsa-manifest.json"), JSON.stringify(manifest));

    await using dispatcher = mockDownload(200, gz);
    await expect(wget(tmp.path, { dispatcher, maxBinaryBytes: 100 })).rejects.toThrow(
      /decompressed payload exceeds cap|possible zip-bomb/,
    );
  });

  it("rejects when download sha256 mismatches manifest", async ({ expect }) => {
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "1.0.0");
    const goodGz = gzipSync(FAKE_BINARY);
    const realSha = createHash("sha256").update(goodGz).digest("hex");
    const bogusSha = "0".repeat(64);
    const platform = process.platform;
    const arch = process.arch;
    const manifest = {
      $schema: SLSA_MANIFEST_V1_SCHEMA_URL,
      packageName: "node-reqwest",
      runInvocationURI: "https://github.com/vadimpiven/node_reqwest/actions/runs/1/attempts/1",
      sourceRepo: "vadimpiven/node_reqwest",
      sourceCommit: "a".repeat(40),
      sourceRef: "refs/tags/v1.0.0",
      addons: { [platform]: { [arch]: { url: FAKE_URL, sha256: bogusSha } } },
    };
    await writeFile(join(tmp.path, "slsa-manifest.json"), JSON.stringify(manifest));

    await using dispatcher = mockDownload(200, goodGz);
    await expect(wget(tmp.path, { dispatcher })).rejects.toThrow(/sha256 mismatch/);
    void realSha;
  });
});

describe("pack", () => {
  it("creates valid gzip output at addon.path.gz", async ({ expect }) => {
    await using tmp = await tempDir();
    const distDir = join(tmp.path, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "node_reqwest.node"), FAKE_BINARY);
    await writeTestPkg(tmp.path, "1.0.0");

    await pack(tmp.path);

    const compressed = await readFile(join(distDir, "node_reqwest.node.gz"));
    const decompressed = await gunzipAsync(compressed);
    expect(decompressed).toEqual(FAKE_BINARY);
  });

  it("cleans up partial output on pipeline failure", async ({ expect }) => {
    await using tmp = await tempDir();
    const distDir = join(tmp.path, "dist");
    await mkdir(distDir, { recursive: true });
    await writeTestPkg(tmp.path, "1.0.0");

    await expect(pack(tmp.path)).rejects.toThrow();
    const files = await readdir(distDir);
    expect(files.filter((f) => f.endsWith(".gz"))).toHaveLength(0);
  });

  it("rejects path traversal in addon.path", async ({ expect }) => {
    await using tmp = await tempDir();
    const pkg = {
      name: "test-pkg",
      version: "1.0.0",
      addon: { path: "../etc/evil.node" },
      repository: { url: "git+https://github.com/owner/repo.git" },
    };
    await writeFile(join(tmp.path, "package.json"), JSON.stringify(pkg));
    await expect(pack(tmp.path)).rejects.toThrow(/addon\.path must be a relative/);
  });

  it("writes to a templated output path", async ({ expect }) => {
    await using tmp = await tempDir();
    const distDir = join(tmp.path, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "node_reqwest.node"), FAKE_BINARY);
    await writeTestPkg(tmp.path, "1.2.3");

    await pack(tmp.path, { output: "dist/node_reqwest-v{version}-{platform}-{arch}.node.gz" });

    const expected = `node_reqwest-v1.2.3-${process.platform}-${process.arch}.node.gz`;
    const compressed = await readFile(join(distDir, expected));
    const decompressed = await gunzipAsync(compressed);
    expect(decompressed).toEqual(FAKE_BINARY);
  });

  it("creates missing parent directories for templated output", async ({ expect }) => {
    await using tmp = await tempDir();
    const distDir = join(tmp.path, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "node_reqwest.node"), FAKE_BINARY);
    await writeTestPkg(tmp.path, "1.0.0");

    await pack(tmp.path, { output: "dist/gz/{platform}-{arch}/addon.node.gz" });

    const out = join(distDir, "gz", `${process.platform}-${process.arch}`, "addon.node.gz");
    const compressed = await readFile(out);
    const decompressed = await gunzipAsync(compressed);
    expect(decompressed).toEqual(FAKE_BINARY);
  });

  it("rejects output template escaping the package directory", async ({ expect }) => {
    await using tmp = await tempDir();
    const distDir = join(tmp.path, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "node_reqwest.node"), FAKE_BINARY);
    await writeTestPkg(tmp.path, "1.0.0");

    await expect(pack(tmp.path, { output: "../evil-{version}.gz" })).rejects.toThrow(
      /packed output/,
    );
  });

  it("rejects unknown template placeholders in output", async ({ expect }) => {
    await using tmp = await tempDir();
    const distDir = join(tmp.path, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "node_reqwest.node"), FAKE_BINARY);
    await writeTestPkg(tmp.path, "1.0.0");

    await expect(pack(tmp.path, { output: "dist/out-{libc}.gz" })).rejects.toThrow(
      /unresolved template placeholders/,
    );
  });
});
