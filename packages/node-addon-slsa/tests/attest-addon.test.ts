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

describe("attest-addon main()", () => {
  it("hashes binary, mints bundle, writes descriptor, uploads artifact", async ({ expect }) => {
    const bytes = Buffer.from("hello-addon-bytes");
    const expectedSha = createHash("sha256").update(bytes).digest("hex");
    const platformBasename = `myaddon-${process.platform}-${process.arch}.node.gz`;
    const binaryPath = join(workdir.path, platformBasename);
    await writeFile(binaryPath, bytes);

    setInput("binary", join(workdir.path, "*.node.gz"));
    setInput("url-prefix", "https://cdn.example.com/v1/");
    setInput("github-token", "stub-token");

    await main();

    expect(mockAttestProvenance).toHaveBeenCalledTimes(1);
    const subjects = mockAttestProvenance.mock.calls[0]?.[0]?.subjects;
    expect(subjects).toEqual([
      { name: `https://cdn.example.com/v1/${platformBasename}`, digest: { sha256: expectedSha } },
    ]);

    const bundlePath = `${binaryPath}.sigstore`;
    const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
    expect(bundle.mediaType).toBe("application/vnd.dev.sigstore.bundle+json;version=0.3");

    const descriptorPath = `${bundlePath}.slsa.json`;
    const descriptor = AddonDescriptorSchema.parse(
      JSON.parse(await readFile(descriptorPath, "utf8")),
    );
    expect(descriptor).toEqual({
      platform: process.platform,
      arch: process.arch,
      url: `https://cdn.example.com/v1/${platformBasename}`,
      bundleUrl: `https://cdn.example.com/v1/${platformBasename}.sigstore`,
      sha256: expectedSha,
    });

    expect(mockUploadArtifact).toHaveBeenCalledTimes(1);
    const [artifactName, files] = mockUploadArtifact.mock.calls[0] ?? [];
    expect(artifactName).toBe(`slsa-addons-${process.platform}-${process.arch}`);
    expect(files).toEqual([descriptorPath]);
  });

  it("auto-appends trailing slash to url-prefix", async ({ expect }) => {
    const platformBasename = `myaddon-${process.platform}-${process.arch}.node.gz`;
    await writeFile(join(workdir.path, platformBasename), Buffer.from("x"));
    setInput("binary", join(workdir.path, "*.node.gz"));
    setInput("url-prefix", "https://cdn.example.com/v1");
    setInput("github-token", "stub");
    await main();
    const subjects = mockAttestProvenance.mock.calls[0]?.[0]?.subjects;
    expect(subjects?.[0]?.name).toBe(`https://cdn.example.com/v1/${platformBasename}`);
  });

  it("rejects http url-prefix", async ({ expect }) => {
    await writeFile(join(workdir.path, "x.node.gz"), Buffer.from("x"));
    setInput("binary", join(workdir.path, "*.node.gz"));
    setInput("url-prefix", "http://cdn.example.com/v1/");
    setInput("github-token", "stub");
    await expect(main()).rejects.toThrow(/must start with https:\/\//);
  });

  it("fails when glob matches zero files", async ({ expect }) => {
    setInput("binary", join(workdir.path, "*.node.gz"));
    setInput("url-prefix", "https://cdn.example.com/v1/");
    setInput("github-token", "stub");
    await expect(main()).rejects.toThrow(/matched no files/);
  });

  it("fails when glob matches multiple files", async ({ expect }) => {
    await writeFile(join(workdir.path, "a.node.gz"), Buffer.from("a"));
    await writeFile(join(workdir.path, "b.node.gz"), Buffer.from("b"));
    setInput("binary", join(workdir.path, "*.node.gz"));
    setInput("url-prefix", "https://cdn.example.com/v1/");
    setInput("github-token", "stub");
    await expect(main()).rejects.toThrow(/matched 2 files/);
  });

  it("rejects binary larger than max-binary-bytes", async ({ expect }) => {
    await writeFile(join(workdir.path, "big.node.gz"), Buffer.alloc(2048));
    setInput("binary", join(workdir.path, "*.node.gz"));
    setInput("url-prefix", "https://cdn.example.com/v1/");
    setInput("github-token", "stub");
    setInput("max-binary-bytes", "1024");
    await expect(main()).rejects.toThrow(/exceeds cap/);
  });

  it("rejects non-numeric max-binary-bytes", async ({ expect }) => {
    await writeFile(join(workdir.path, "x.node.gz"), Buffer.from("x"));
    setInput("binary", join(workdir.path, "*.node.gz"));
    setInput("url-prefix", "https://cdn.example.com/v1/");
    setInput("github-token", "stub");
    setInput("max-binary-bytes", "not-a-number");
    await expect(main()).rejects.toThrow(/positive integer/);
  });
});
