// SPDX-License-Identifier: Apache-2.0 OR MIT

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AddonDescriptorSchema, tempDir } from "@node-addon-slsa/internal";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { main } from "../../../.github/actions/attest-addon/index.ts";

type AttestProvenance = typeof import("@actions/attest").attestProvenance;
type UploadArtifact = (
  name: string,
  files: string[],
  rootDirectory: string,
  options?: { retentionDays?: number },
) => Promise<{ id: number; size: number }>;

const { mockAttestProvenance, mockUploadArtifact } = vi.hoisted(() => ({
  mockAttestProvenance: vi.fn<AttestProvenance>(),
  mockUploadArtifact: vi.fn<UploadArtifact>(),
}));

vi.mock("@actions/attest", async (orig) => {
  const actual = await orig<typeof import("@actions/attest")>();
  return { ...actual, attestProvenance: mockAttestProvenance };
});

vi.mock("@actions/artifact", () => ({
  DefaultArtifactClient: class {
    uploadArtifact = mockUploadArtifact;
  },
}));

function setInput(name: string, value: string): void {
  vi.stubEnv(`INPUT_${name.replaceAll(" ", "_").toUpperCase()}`, value);
}

let workdir: { path: string } & AsyncDisposable;

beforeEach(async () => {
  mockAttestProvenance.mockReset();
  mockUploadArtifact.mockReset();
  mockAttestProvenance.mockResolvedValue({
    attestationID: "stub-attestation-id",
    certificate: "stub-cert",
    bundle: { mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.3" } as never,
  } as Awaited<ReturnType<AttestProvenance>>);
  mockUploadArtifact.mockResolvedValue({ id: 42, size: 1 });
  workdir = await tempDir("attest-addon-test-");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await workdir[Symbol.asyncDispose]();
});

/** Wire all required inputs for one binary; tests override individual fields as needed. */
function wireDefaults(binaryPath: string): void {
  setInput("binary-path", binaryPath);
  setInput("url-prefix", "https://cdn.example.com/v1/");
  setInput("github-token", "stub-token");
}

describe("attest-addon main()", () => {
  it("hashes binary, mints bundle, writes descriptor + bundle, uploads artifact", async ({
    expect,
  }) => {
    const bytes = Buffer.from("hello-addon-bytes");
    const expectedSha = createHash("sha256").update(bytes).digest("hex");
    const baseName = "myaddon-linux-x64.node.gz";
    const binaryPath = join(workdir.path, baseName);
    await writeFile(binaryPath, bytes);

    wireDefaults(binaryPath);

    await main();

    expect(mockAttestProvenance).toHaveBeenCalledTimes(1);
    const subjects = mockAttestProvenance.mock.calls[0]?.[0]?.subjects;
    expect(subjects).toEqual([
      { name: `https://cdn.example.com/v1/${baseName}`, digest: { sha256: expectedSha } },
    ]);

    const bundlePath = `${binaryPath}.sigstore`;
    const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
    expect(bundle.mediaType).toBe("application/vnd.dev.sigstore.bundle+json;version=0.3");

    const descriptorPath = `${bundlePath}.slsa.json`;
    const descriptor = AddonDescriptorSchema.parse(
      JSON.parse(await readFile(descriptorPath, "utf8")),
    );
    expect(descriptor).toEqual({
      platform: "linux",
      arch: "x64",
      url: `https://cdn.example.com/v1/${baseName}`,
      bundleUrl: `https://cdn.example.com/v1/${baseName}.sigstore`,
      sha256: expectedSha,
    });

    // Both descriptor and bundle must ship in the artifact so verify-addons
    // can read them without a network round-trip.
    expect(mockUploadArtifact).toHaveBeenCalledTimes(1);
    const [artifactName, files] = mockUploadArtifact.mock.calls[0] ?? [];
    expect(artifactName).toBe("slsa-addons-linux-x64");
    expect(files).toEqual([descriptorPath, bundlePath]);
  });

  it("auto-appends trailing slash to url-prefix", async ({ expect }) => {
    const baseName = "myaddon-linux-x64.node.gz";
    const binaryPath = join(workdir.path, baseName);
    await writeFile(binaryPath, Buffer.from("x"));
    wireDefaults(binaryPath);
    setInput("url-prefix", "https://cdn.example.com/v1");
    await main();
    const subjects = mockAttestProvenance.mock.calls[0]?.[0]?.subjects;
    expect(subjects?.[0]?.name).toBe(`https://cdn.example.com/v1/${baseName}`);
  });

  it("rejects http url-prefix", async ({ expect }) => {
    const binaryPath = join(workdir.path, "myaddon-linux-x64.node.gz");
    await writeFile(binaryPath, Buffer.from("x"));
    wireDefaults(binaryPath);
    setInput("url-prefix", "http://cdn.example.com/v1/");
    await expect(main()).rejects.toThrow(/must start with https:\/\//);
  });

  it("rejects binary basename without platform/arch suffix", async ({ expect }) => {
    const binaryPath = join(workdir.path, "addon.node.gz");
    await writeFile(binaryPath, Buffer.from("x"));
    wireDefaults(binaryPath);
    await expect(main()).rejects.toThrow(/Cannot derive platform\/arch/);
  });

  it("rejects binary basename with unsupported platform", async ({ expect }) => {
    const binaryPath = join(workdir.path, "addon-freebsd-x64.node.gz");
    await writeFile(binaryPath, Buffer.from("x"));
    wireDefaults(binaryPath);
    await expect(main()).rejects.toThrow(/Cannot derive platform\/arch/);
  });

  it("rejects binary basename with unsupported arch", async ({ expect }) => {
    const binaryPath = join(workdir.path, "addon-linux-riscv64.node.gz");
    await writeFile(binaryPath, Buffer.from("x"));
    wireDefaults(binaryPath);
    await expect(main()).rejects.toThrow(/Cannot derive platform\/arch/);
  });

  it("rejects binary larger than max-binary-bytes", async ({ expect }) => {
    const binaryPath = join(workdir.path, "big-linux-x64.node.gz");
    await writeFile(binaryPath, Buffer.alloc(2048));
    wireDefaults(binaryPath);
    setInput("max-binary-bytes", "1024");
    await expect(main()).rejects.toThrow(/exceeds cap/);
  });

  it("rejects non-numeric max-binary-bytes", async ({ expect }) => {
    const binaryPath = join(workdir.path, "myaddon-linux-x64.node.gz");
    await writeFile(binaryPath, Buffer.from("x"));
    wireDefaults(binaryPath);
    setInput("max-binary-bytes", "not-a-number");
    await expect(main()).rejects.toThrow(/positive integer/);
  });
});
