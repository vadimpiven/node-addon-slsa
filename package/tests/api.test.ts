// SPDX-License-Identifier: Apache-2.0 OR MIT

import { describe, it, vi } from "vitest";

import type { SerializedBundle } from "@sigstore/bundle";

import { verifyAddonProvenance, verifyPackageProvenance } from "../src/verify/api.ts";
import { sha256Hex } from "../src/types.ts";
import type { BundleVerifier } from "../src/types.ts";
import { ProvenanceError } from "../src/util/provenance-error.ts";

vi.mock("../src/verify/attestations.ts", () => ({
  fetchNpmAttestations: vi.fn(),
  fetchGitHubAttestations: vi.fn(),
}));

const { fetchNpmAttestations, fetchGitHubAttestations } =
  await import("../src/verify/attestations.ts");

const STUB_BUNDLE = {} as SerializedBundle;

function fakeVerifier(impl?: () => void): BundleVerifier {
  return { verify: vi.fn(impl ?? (() => {})) } as unknown as BundleVerifier;
}

describe("verifyPackageProvenance", () => {
  it("throws ProvenanceError when no SLSA provenance attestation exists", async ({ expect }) => {
    vi.mocked(fetchNpmAttestations).mockResolvedValueOnce({
      attestations: [{ predicateType: "https://in-toto.io/Statement/v0.1", bundle: STUB_BUNDLE }],
    });

    const err = await verifyPackageProvenance({
      packageName: "pkg",
      version: "1.0.0",
      repo: "owner/repo",
      verifier: fakeVerifier(),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProvenanceError);
    expect((err as Error).message).toMatch(/No SLSA provenance attestation found/);
  });
});

describe("verifyAddonProvenance", () => {
  it("counts verify failures and throws ProvenanceError when all fail", async ({ expect }) => {
    vi.mocked(fetchGitHubAttestations).mockResolvedValueOnce({
      attestations: [{ bundle: STUB_BUNDLE }, { bundle: STUB_BUNDLE }],
    });

    const verifier = fakeVerifier(() => {
      throw new Error("signature invalid");
    });

    await expect(
      verifyAddonProvenance({
        sha256: sha256Hex("a".repeat(64)),
        runInvocationURI:
          "https://github.com/owner/repo/actions/runs/1/attempts/1" as import("../src/types.ts").RunInvocationURI,
        repo: "owner/repo",
        verifier,
      }),
    ).rejects.toThrow(/All 2 attestation\(s\) failed cryptographic verification/);
  });

  it("re-throws ProvenanceError from verifier.verify immediately", async ({ expect }) => {
    vi.mocked(fetchGitHubAttestations).mockResolvedValueOnce({
      attestations: [{ bundle: STUB_BUNDLE }, { bundle: STUB_BUNDLE }],
    });

    const verifier = fakeVerifier(() => {
      throw new ProvenanceError("cert chain invalid");
    });

    await expect(
      verifyAddonProvenance({
        sha256: sha256Hex("a".repeat(64)),
        runInvocationURI:
          "https://github.com/owner/repo/actions/runs/1/attempts/1" as import("../src/types.ts").RunInvocationURI,
        repo: "owner/repo",
        verifier,
      }),
    ).rejects.toThrow("cert chain invalid");
  });
});
