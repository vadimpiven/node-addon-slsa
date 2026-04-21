// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Integration tests for `.github/actions/verify-addons/index.ts`. The
 * action is pure in/out (env inputs, one `manifest` JSON output), so
 * tests only stub `verifyAttestation` and `@actions/core.setOutput`;
 * the fetch pipeline runs real against undici's MockAgent. Covers the
 * happy path, the size-cap guards (declared and streaming), the
 * fail-fast checks on `GITHUB_REF`, and error surfacing.
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { main } from "../../../.github/actions/verify-addons/index.ts";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockVerifyAttestation, mockSetOutput } = vi.hoisted(() => ({
  mockVerifyAttestation: vi.fn<(opts: unknown) => Promise<void>>(),
  mockSetOutput: vi.fn<(name: string, value: unknown) => void>(),
}));

vi.mock("@node-addon-slsa/internal", async (orig) => {
  const actual = await orig<typeof import("@node-addon-slsa/internal")>();
  return {
    ...actual,
    verifyAttestation: (opts: unknown) => mockVerifyAttestation(opts),
  };
});

vi.mock("@actions/core", async (orig) => {
  const actual = await orig<typeof import("@actions/core")>();
  return {
    ...actual,
    setOutput: (name: string, value: unknown) => mockSetOutput(name, value),
  };
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const GOOD_BINARY = Buffer.from("fake-addon-binary-bytes");
const GOOD_GZ = gzipSync(GOOD_BINARY);
const GOOD_SHA = createHash("sha256").update(GOOD_GZ).digest("hex");
const ADDON_URL = "https://cdn.example.com/v1.0.0/my-addon-linux-x64.node.gz";
const BUNDLE_URL = "https://cdn.example.com/v1.0.0/my-addon-linux-x64.node.gz.sigstore";

function getManifest(): Record<string, unknown> {
  const call = mockSetOutput.mock.calls.find((c) => c[0] === "manifest");
  if (!call) throw new Error("setOutput('manifest') was not called");
  return JSON.parse(call[1] as string) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Env wiring
// ---------------------------------------------------------------------------

type Env = {
  addons: unknown;
  packageName?: string;
  maxBinaryBytes?: string;
  maxBinarySeconds?: string;
  ref?: string;
  unsetRef?: boolean;
};

function wireEnv(env: Env): void {
  vi.stubEnv("INPUT_PACKAGE-NAME", env.packageName ?? "my-addon");
  vi.stubEnv("INPUT_ADDONS", JSON.stringify(env.addons));
  vi.stubEnv("INPUT_MAX-BINARY-BYTES", env.maxBinaryBytes ?? "");
  vi.stubEnv("INPUT_MAX-BINARY-SECONDS", env.maxBinarySeconds ?? "");
  vi.stubEnv("GITHUB_REPOSITORY", "owner/repo");
  vi.stubEnv("GITHUB_RUN_ID", "123");
  vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
  vi.stubEnv("GITHUB_SHA", "a".repeat(40));
  if (env.unsetRef) {
    vi.stubEnv("GITHUB_REF", "");
  } else {
    vi.stubEnv("GITHUB_REF", env.ref ?? "refs/tags/v1.0.0");
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let prevDispatcher: Dispatcher;
let agent: MockAgent;

beforeEach(() => {
  mockVerifyAttestation.mockReset().mockResolvedValue(undefined);
  mockSetOutput.mockReset();
  prevDispatcher = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  setGlobalDispatcher(prevDispatcher);
  await agent.close();
  vi.unstubAllEnvs();
});

function interceptAddon(
  reply: (opts: { method: string; path: string }) => {
    statusCode: number;
    data?: Buffer | string;
    headers?: Record<string, string>;
  },
  times = 1,
): void {
  agent
    .get("https://cdn.example.com")
    .intercept({ path: () => true, method: () => true })
    .reply((opts) => {
      const r = reply({ method: opts.method as string, path: opts.path as string });
      return {
        statusCode: r.statusCode,
        data: r.data ?? "",
        responseOptions: { headers: r.headers ?? {} },
      };
    })
    .times(times);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verify-addons main()", () => {
  it("happy path: fetches, verifies, emits manifest JSON", async ({ expect }) => {
    interceptAddon(() => ({
      statusCode: 200,
      data: GOOD_GZ,
      headers: { "content-length": String(GOOD_GZ.length) },
    }));
    wireEnv({ addons: { linux: { x64: { url: ADDON_URL, bundleUrl: BUNDLE_URL } } } });
    await main();
    expect(mockVerifyAttestation).toHaveBeenCalledOnce();

    const manifest = getManifest();
    expect(manifest["packageName"]).toBe("my-addon");
    expect(manifest["sourceRepo"]).toBe("owner/repo");
    expect(manifest["sourceCommit"]).toBe("a".repeat(40));
    expect(manifest["sourceRef"]).toBe("refs/tags/v1.0.0");
    expect(manifest["runInvocationURI"]).toBe(
      "https://github.com/owner/repo/actions/runs/123/attempts/1",
    );
    const linuxX64 = (
      manifest["addons"] as {
        linux: { x64: { url: string; bundleUrl: string; sha256: string } };
      }
    ).linux.x64;
    expect(linuxX64.url).toBe(ADDON_URL);
    expect(linuxX64.bundleUrl).toBe(BUNDLE_URL);
    expect(linuxX64.sha256).toBe(GOOD_SHA);
  });

  it("rejects when verifyAttestation rejects", async ({ expect }) => {
    interceptAddon(() => ({
      statusCode: 200,
      data: GOOD_GZ,
      headers: { "content-length": String(GOOD_GZ.length) },
    }));
    mockVerifyAttestation.mockRejectedValueOnce(new Error("wrong bytes: Rekor miss"));
    wireEnv({ addons: { linux: { x64: { url: ADDON_URL, bundleUrl: BUNDLE_URL } } } });
    await expect(main()).rejects.toThrow(/wrong bytes/);
    expect(mockSetOutput).not.toHaveBeenCalled();
  });

  it("rejects on Content-Length over the cap without verifying", async ({ expect }) => {
    interceptAddon(() => ({
      statusCode: 200,
      data: GOOD_GZ,
      headers: { "content-length": "99999999999" },
    }));
    wireEnv({ addons: { linux: { x64: { url: ADDON_URL, bundleUrl: BUNDLE_URL } } } });
    await expect(main()).rejects.toThrow(/Content-Length .* exceeds cap/);
    expect(mockVerifyAttestation).not.toHaveBeenCalled();
  });

  it("aborts mid-stream when body exceeds cap without declared Content-Length", async ({
    expect,
  }) => {
    const bigBody = Buffer.alloc(4096, 0x41);
    interceptAddon(() => ({ statusCode: 200, data: bigBody }));
    wireEnv({
      addons: { linux: { x64: { url: ADDON_URL, bundleUrl: BUNDLE_URL } } },
      maxBinaryBytes: "128",
    });
    await expect(main()).rejects.toThrow(/body exceeds cap/);
    expect(mockVerifyAttestation).not.toHaveBeenCalled();
  });

  it("respects max-binary-bytes override", async ({ expect }) => {
    interceptAddon(() => ({
      statusCode: 200,
      data: GOOD_GZ,
      headers: { "content-length": String(GOOD_GZ.length) },
    }));
    wireEnv({
      addons: { linux: { x64: { url: ADDON_URL, bundleUrl: BUNDLE_URL } } },
      maxBinaryBytes: String(GOOD_GZ.length - 1),
    });
    await expect(main()).rejects.toThrow(/Content-Length .* exceeds cap/);
  });

  it("errors with URL + status on non-2xx HTTP", async ({ expect }) => {
    interceptAddon(() => ({ statusCode: 503, data: "boom" }), 3);
    wireEnv({ addons: { linux: { x64: { url: ADDON_URL, bundleUrl: BUNDLE_URL } } } });
    const err = await main().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/503/);
    expect((err as Error).message).toContain(ADDON_URL);
  }, 15_000);

  it("throws on empty addons input", async ({ expect }) => {
    wireEnv({ addons: { linux: {} } });
    await expect(main()).rejects.toThrow(/no URLs|at least one/);
  });

  it("uses supplied package-name in manifest", async ({ expect }) => {
    interceptAddon(() => ({
      statusCode: 200,
      data: GOOD_GZ,
      headers: { "content-length": String(GOOD_GZ.length) },
    }));
    wireEnv({
      addons: { linux: { x64: { url: ADDON_URL, bundleUrl: BUNDLE_URL } } },
      packageName: "@scope/my-pkg",
    });
    await main();
    expect(getManifest()["packageName"]).toBe("@scope/my-pkg");
  });

  it("fails fast on missing GITHUB_REF", async ({ expect }) => {
    wireEnv({
      addons: { linux: { x64: { url: ADDON_URL, bundleUrl: BUNDLE_URL } } },
      unsetRef: true,
    });
    await expect(main()).rejects.toThrow(/GITHUB_REF/);
  });

  it("fails fast on non-tag GITHUB_REF", async ({ expect }) => {
    wireEnv({
      addons: { linux: { x64: { url: ADDON_URL, bundleUrl: BUNDLE_URL } } },
      ref: "refs/heads/main",
    });
    await expect(main()).rejects.toThrow(/refs\/tags\//);
  });
});
