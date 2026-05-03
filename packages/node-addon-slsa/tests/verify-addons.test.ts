// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Integration tests for `.github/actions/verify-addons/index.ts`. The
 * action is pure in/out: it consumes a directory of descriptor + bundle
 * artifact files (produced by `attest-addon`) and emits one `manifest`
 * JSON output via `@actions/core.setOutput`. Tests stub
 * `verifyAttestationFromBundle` and the global `fetch` (HEAD smoke
 * check), so no network is touched.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { tempDir } from "@node-addon-slsa/internal";

import { main } from "../../../.github/actions/verify-addons/index.ts";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockVerifyFromBundle, mockSetOutput } = vi.hoisted(() => ({
  mockVerifyFromBundle: vi.fn<(opts: unknown) => Promise<void>>(),
  mockSetOutput: vi.fn<(name: string, value: unknown) => void>(),
}));

vi.mock("@node-addon-slsa/internal", async (orig) => {
  const actual = await orig<typeof import("@node-addon-slsa/internal")>();
  return {
    ...actual,
    verifyAttestationFromBundle: (opts: unknown) => mockVerifyFromBundle(opts),
    // Stub trust-material loading to avoid a real TUF round-trip during tests.
    loadTrustMaterial: async () => ({}) as never,
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

const ADDON_URL = "https://cdn.example.com/v1.0.0/my-addon-linux-x64.node.gz";
const BUNDLE_URL = "https://cdn.example.com/v1.0.0/my-addon-linux-x64.node.gz.sigstore";
const ADDON_SHA = "a".repeat(64);

/** Minimal valid descriptor + bundle pair as `attest-addon` would write. */
async function writePair(
  dir: string,
  descriptor: {
    platform: string;
    arch: string;
    url?: string;
    bundleUrl?: string;
    sha256?: string;
  },
): Promise<void> {
  const url = descriptor.url ?? ADDON_URL;
  const bundleUrl = descriptor.bundleUrl ?? BUNDLE_URL;
  const sha256 = descriptor.sha256 ?? ADDON_SHA;
  const baseName = `addon-${descriptor.platform}-${descriptor.arch}.node.gz`;
  const bundlePath = join(dir, `${baseName}.sigstore`);
  const descriptorPath = `${bundlePath}.slsa.json`;
  await writeFile(
    descriptorPath,
    JSON.stringify({
      platform: descriptor.platform,
      arch: descriptor.arch,
      url,
      bundleUrl,
      sha256,
    }),
  );
  // Bundle content doesn't matter — it's passed opaquely to the
  // mocked `verifyAttestationFromBundle`.
  await writeFile(bundlePath, JSON.stringify({ stub: "bundle" }));
}

function getManifest(): Record<string, unknown> {
  const call = mockSetOutput.mock.calls.find((c) => c[0] === "manifest");
  if (!call) throw new Error("setOutput('manifest') was not called");
  return JSON.parse(call[1] as string) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Env wiring
// ---------------------------------------------------------------------------

type Env = {
  descriptorsDir: string;
  packageName?: string;
  releaseBaseUrl?: string;
  ref?: string;
  unsetRef?: boolean;
};

function wireEnv(env: Env): void {
  vi.stubEnv("INPUT_PACKAGE-NAME", env.packageName ?? "my-addon");
  vi.stubEnv("INPUT_DESCRIPTORS-DIR", env.descriptorsDir);
  vi.stubEnv("INPUT_RELEASE-BASE-URL", env.releaseBaseUrl ?? "https://cdn.example.com/v1.0.0/");
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

const fetchSpy = vi.spyOn(globalThis, "fetch");

beforeEach(() => {
  mockVerifyFromBundle.mockReset().mockResolvedValue(undefined);
  mockSetOutput.mockReset();
  fetchSpy.mockReset();
  // Default: HEAD reachability check passes for everything.
  fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verify-addons main()", () => {
  it("happy path: reads descriptor + bundle, verifies, emits manifest JSON", async ({ expect }) => {
    await using tmp = await tempDir();
    await writePair(tmp.path, { platform: "linux", arch: "x64" });
    wireEnv({ descriptorsDir: tmp.path });
    await main();
    expect(mockVerifyFromBundle).toHaveBeenCalledOnce();

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
    expect(linuxX64.sha256).toBe(ADDON_SHA);
  });

  it("rejects when verifyAttestationFromBundle rejects", async ({ expect }) => {
    await using tmp = await tempDir();
    await writePair(tmp.path, { platform: "linux", arch: "x64" });
    mockVerifyFromBundle.mockRejectedValueOnce(new Error("Source commit mismatch"));
    wireEnv({ descriptorsDir: tmp.path });
    await expect(main()).rejects.toThrow(/Source commit mismatch/);
    expect(mockSetOutput).not.toHaveBeenCalled();
  });

  it("rejects descriptor URLs not under release-base-url", async ({ expect }) => {
    await using tmp = await tempDir();
    await writePair(tmp.path, {
      platform: "linux",
      arch: "x64",
      url: "https://evil.example/leak.node.gz",
      bundleUrl: "https://evil.example/leak.node.gz.sigstore",
    });
    wireEnv({ descriptorsDir: tmp.path });
    await expect(main()).rejects.toThrow(/does not start with release-base-url/);
  });

  it("rejects duplicate (platform, arch) pairs", async ({ expect }) => {
    await using tmp = await tempDir();
    await mkdir(join(tmp.path, "a"), { recursive: true });
    await mkdir(join(tmp.path, "b"), { recursive: true });
    // Same platform/arch in two subdirs → duplicate.
    await writePair(join(tmp.path, "a"), { platform: "linux", arch: "x64" });
    await writePair(join(tmp.path, "b"), { platform: "linux", arch: "x64" });
    wireEnv({ descriptorsDir: tmp.path });
    await expect(main()).rejects.toThrow(/duplicate/);
  });

  it("throws when no descriptor files are found", async ({ expect }) => {
    await using tmp = await tempDir();
    wireEnv({ descriptorsDir: tmp.path });
    await expect(main()).rejects.toThrow(/no \*\.slsa\.json/);
  });

  it("throws when bundle sibling is missing", async ({ expect }) => {
    await using tmp = await tempDir();
    // Write descriptor without sibling bundle.
    await writeFile(
      join(tmp.path, "addon-linux-x64.node.gz.sigstore.slsa.json"),
      JSON.stringify({
        platform: "linux",
        arch: "x64",
        url: ADDON_URL,
        bundleUrl: BUNDLE_URL,
        sha256: ADDON_SHA,
      }),
    );
    wireEnv({ descriptorsDir: tmp.path });
    await expect(main()).rejects.toThrow(/no sibling bundle/);
  });

  it("HEAD reachability failure aborts publish", async ({ expect }) => {
    await using tmp = await tempDir();
    await writePair(tmp.path, { platform: "linux", arch: "x64" });
    fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));
    wireEnv({ descriptorsDir: tmp.path });
    await expect(main()).rejects.toThrow(/release asset not reachable/);
  });

  it("uses supplied package-name in manifest", async ({ expect }) => {
    await using tmp = await tempDir();
    await writePair(tmp.path, { platform: "linux", arch: "x64" });
    wireEnv({ descriptorsDir: tmp.path, packageName: "@scope/my-pkg" });
    await main();
    expect(getManifest()["packageName"]).toBe("@scope/my-pkg");
  });

  it("fails fast on missing GITHUB_REF", async ({ expect }) => {
    await using tmp = await tempDir();
    await writePair(tmp.path, { platform: "linux", arch: "x64" });
    wireEnv({ descriptorsDir: tmp.path, unsetRef: true });
    await expect(main()).rejects.toThrow(/GITHUB_REF/);
  });

  it("fails fast on non-tag GITHUB_REF", async ({ expect }) => {
    await using tmp = await tempDir();
    await writePair(tmp.path, { platform: "linux", arch: "x64" });
    wireEnv({ descriptorsDir: tmp.path, ref: "refs/heads/main" });
    await expect(main()).rejects.toThrow(/refs\/tags\//);
  });

  it("rejects non-https release-base-url", async ({ expect }) => {
    await using tmp = await tempDir();
    await writePair(tmp.path, { platform: "linux", arch: "x64" });
    wireEnv({ descriptorsDir: tmp.path, releaseBaseUrl: "http://insecure.example/" });
    await expect(main()).rejects.toThrow(/release-base-url must start with https/);
  });
});
