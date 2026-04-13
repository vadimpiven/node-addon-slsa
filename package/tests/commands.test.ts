// SPDX-License-Identifier: Apache-2.0 OR MIT

import { join } from "node:path";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { promisify } from "node:util";
import { gunzip, gzipSync } from "node:zlib";
import { MockAgent } from "undici";
import { beforeEach, describe, it, vi } from "vitest";

import { pack, wget } from "../src/commands.ts";
import { tempDir } from "../src/util/fs.ts";
import { FAKE_BINARY, writeTestPkg } from "./fixtures.ts";

const gunzipAsync = promisify(gunzip);

const { mockVerifyAddon, MOCK_RUN_URI } = vi.hoisted(() => {
  const mockVerifyAddon = vi.fn().mockResolvedValue(undefined);
  // vi.mock factories are hoisted above imports, so branded type
  // constructors are unavailable. Use a pre-validated literal.
  const MOCK_RUN_URI = "https://github.com/vadimpiven/node_reqwest/actions/runs/123/attempts/1";
  return { mockVerifyAddon, MOCK_RUN_URI };
});

vi.mock("../src/verify/index.ts", () => ({
  verifyPackageProvenance: vi.fn().mockResolvedValue({
    // Type cast: vi.mock is hoisted above imports,
    // so runtime constructors are unavailable
    runInvocationURI: MOCK_RUN_URI,
    verifyAddon: (...args: unknown[]) => mockVerifyAddon(...args),
  }),
  verifyAddonProvenance: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  mockVerifyAddon.mockClear();
  delete process.env["SLSA_DEBUG"];
});

function mockDownload(
  status: number,
  body: Buffer | string,
  times = 1,
): MockAgent & AsyncDisposable {
  const agent = new MockAgent();
  agent.disableNetConnect();

  agent
    .get("https://github.com")
    .intercept({
      path: /^\/vadimpiven\/node_reqwest\/releases\/download\//,
      method: "GET",
    })
    .reply(status, body)
    .times(times);

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
      addon: {
        path: "./dist/test.node",
        url: "https://github.com/owner/repo/releases/download/v{version}/test.node.gz",
      },
      repository: "https://gitlab.com/owner/repo",
    };
    await writeFile(join(tmp.path, "package.json"), JSON.stringify(pkg));

    await expect(wget(tmp.path)).rejects.toThrow("could not determine expected repository");
  });
});

describe("wget (download pipeline)", () => {
  it("downloads, decompresses, and writes binary correctly", async ({ expect }) => {
    await using dispatcher = mockDownload(200, gzipSync(FAKE_BINARY));
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "1.0.0");

    await wget(tmp.path, { dispatcher });

    const written = await readFile(join(tmp.path, "dist", "node_reqwest.node"));
    expect(written).toEqual(FAKE_BINARY);
  });

  it("propagates HTTP 503 error with status", async ({ expect }) => {
    await using dispatcher = mockDownload(503, "Service Unavailable", 3);
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "1.0.0");

    await expect(wget(tmp.path, { dispatcher })).rejects.toThrow(/503/);
  });

  it("throws on invalid (non-gzip) content and cleans up temp file", async ({ expect }) => {
    await using dispatcher = mockDownload(200, Buffer.from("this is not gzip data"));
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "1.0.0");

    await expect(wget(tmp.path, { dispatcher })).rejects.toThrow();

    // No temp files should remain in dist/
    const files = await readdir(join(tmp.path, "dist"));
    expect(files.filter((f) => f.startsWith(".tmp-"))).toHaveLength(0);
  });

  it("cleans up temp file when verifyAddon rejects", async ({ expect }) => {
    await using dispatcher = mockDownload(200, gzipSync(FAKE_BINARY));
    mockVerifyAddon.mockRejectedValueOnce(new Error("provenance failed"));

    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "1.0.0");

    await expect(wget(tmp.path, { dispatcher })).rejects.toThrow("provenance failed");

    // Final binary should not exist
    await expect(access(join(tmp.path, "dist", "node_reqwest.node"))).rejects.toThrow();

    // No temp files should remain in dist/
    const files = await readdir(join(tmp.path, "dist"));
    expect(files.filter((f) => f.startsWith(".tmp-"))).toHaveLength(0);
  });
});

describe("pack", () => {
  it("creates valid gzip output", async ({ expect }) => {
    await using tmp = await tempDir();
    const distDir = join(tmp.path, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "node_reqwest.node"), FAKE_BINARY);
    await writeTestPkg(tmp.path, "1.0.0");

    await pack(tmp.path);

    const platform = process.platform;
    const arch = process.arch;
    const packedPath = join(distDir, `node_reqwest-v1.0.0-${platform}-${arch}.node.gz`);
    const compressed = await readFile(packedPath);
    const decompressed = await gunzipAsync(compressed);
    expect(decompressed).toEqual(FAKE_BINARY);
  });

  it("cleans up partial output on pipeline failure", async ({ expect }) => {
    await using tmp = await tempDir();
    const distDir = join(tmp.path, "dist");
    await mkdir(distDir, { recursive: true });
    // Create an empty binary to cause pipeline success, but test cleanup
    // by providing an unreadable file
    await writeTestPkg(tmp.path, "1.0.0");

    // Binary doesn't exist — createReadStream will fail
    await expect(pack(tmp.path)).rejects.toThrow();

    // No packed output should remain
    const files = await readdir(distDir);
    expect(files.filter((f) => f.endsWith(".gz"))).toHaveLength(0);
  });

  it("rejects path traversal in addon.path", async ({ expect }) => {
    await using tmp = await tempDir();

    // addon.path with ".." — rejected by Zod schema validation
    const pkg = {
      name: "test-pkg",
      version: "1.0.0",
      addon: {
        path: "../etc/evil.node",
        url: "https://github.com/owner/repo/releases/download/v{version}/evil.node.gz",
      },
      repository: {
        url: "git+https://github.com/owner/repo.git",
      },
    };
    await writeFile(join(tmp.path, "package.json"), JSON.stringify(pkg));

    await expect(pack(tmp.path)).rejects.toThrow(/addon\.path must be a relative/);
  });
});
