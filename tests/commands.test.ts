// SPDX-License-Identifier: Apache-2.0 OR MIT

import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { describe, it, vi } from "vitest";

import { wget } from "../src/commands.ts";
import { tempDir } from "../src/util/fs.ts";
import type { RunInvocationURI } from "../src/verify.ts";
import { FAKE_BINARY, writeTestPkg } from "./fixtures.ts";

const { access, readdir, readFile } = fsp;

const mockVerifyAddon = vi.fn().mockResolvedValue(undefined);

vi.mock("node:fs/promises", async (importOriginal) => {
  const orig = await importOriginal<typeof fsp>();
  return { ...orig, unlink: vi.fn(orig.unlink) };
});

vi.mock("../src/verify.ts", () => ({
  verifyPackageProvenance: vi.fn().mockResolvedValue({
    runInvocationURI:
      "https://github.com/vadimpiven/node_reqwest/actions/runs/123/attempts/1" as RunInvocationURI,
    verifyAddon: (...args: unknown[]) => mockVerifyAddon(...args),
  }),
  verifyAddonProvenance: vi.fn().mockResolvedValue(undefined),
}));

function mockDownload(status: number, body: Buffer | string): MockAgent & AsyncDisposable {
  const original = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);

  agent
    .get("https://github.com")
    .intercept({
      path: /^\/vadimpiven\/node_reqwest\/releases\/download\//,
      method: "GET",
    })
    .reply(status, body);

  return Object.assign(agent, {
    async [Symbol.asyncDispose]() {
      setGlobalDispatcher(original);
      await agent.close();
    },
  });
}

describe("wget (download pipeline)", () => {
  it("downloads, decompresses, and writes binary correctly", async ({ expect }) => {
    await using _mock = mockDownload(200, gzipSync(FAKE_BINARY));
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "1.0.0");

    await wget(tmp.path);

    const written = await readFile(join(tmp.path, "dist", "node_reqwest.node"));
    expect(written).toEqual(FAKE_BINARY);
  });

  it("propagates HTTP 503 error with status", async ({ expect }) => {
    await using _mock = mockDownload(503, "Service Unavailable");
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "1.0.0");

    await expect(wget(tmp.path)).rejects.toThrow(/503/);
  });

  it("throws on invalid (non-gzip) content", async ({ expect }) => {
    await using _mock = mockDownload(200, Buffer.from("this is not gzip data"));
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "1.0.0");

    await expect(wget(tmp.path)).rejects.toThrow();
  });

  it("cleans up temp file when verifyAddon rejects", async ({ expect }) => {
    await using _mock = mockDownload(200, gzipSync(FAKE_BINARY));
    mockVerifyAddon.mockRejectedValueOnce(new Error("provenance failed"));

    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "1.0.0");

    await expect(wget(tmp.path)).rejects.toThrow("provenance failed");

    // Final binary should not exist
    await expect(access(join(tmp.path, "dist", "node_reqwest.node"))).rejects.toThrow();

    // No temp files should remain in dist/
    const files = await readdir(join(tmp.path, "dist"));
    expect(files.filter((f) => f.startsWith(".tmp-"))).toHaveLength(0);
  });

  it("logs non-ENOENT unlink errors during cleanup", async ({ expect }) => {
    await using _mock = mockDownload(200, gzipSync(FAKE_BINARY));
    mockVerifyAddon.mockRejectedValueOnce(new Error("provenance failed"));

    const eacces = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.mocked(fsp.unlink).mockRejectedValueOnce(eacces);

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "1.0.0");

    await expect(wget(tmp.path)).rejects.toThrow("provenance failed");

    expect(spy).toHaveBeenCalledWith("Failed to clean up temp file:", eacces);
    spy.mockRestore();
  });
});
