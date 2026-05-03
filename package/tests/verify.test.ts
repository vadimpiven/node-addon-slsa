// SPDX-License-Identifier: Apache-2.0 OR MIT

import { describe, it, vi } from "vitest";

import { bundleToJSON, bundleFromJSON } from "@sigstore/bundle";

import { verifyPackageProvenance } from "../src/verify/verify.ts";
import type { BundleVerifier } from "../src/types.ts";
import { ProvenanceError } from "../src/util/provenance-error.ts";

vi.mock("../src/verify/npm.ts", () => ({
  fetchNpmAttestations: vi.fn(),
}));

const { fetchNpmAttestations } = await import("../src/verify/npm.ts");

// Minimal valid bundle structure that passes BundleSchema validation.
// BundleSchema round-trips through bundleFromJSON/bundleToJSON.
const STUB_BUNDLE = bundleToJSON(
  bundleFromJSON({
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: {
      certificate: { rawBytes: Buffer.from("stub").toString("base64") },
      tlogEntries: [],
      timestampVerificationData: { rfc3161Timestamps: [] },
    },
    messageSignature: {
      messageDigest: { algorithm: "SHA2_256", digest: Buffer.from("stub").toString("base64") },
      signature: Buffer.from("stub").toString("base64"),
    },
  }),
);

/**
 * Create a minimal BundleVerifier stub for unit tests.
 * The test only checks error paths before `verify()` is called,
 * so the verifier is never actually invoked.
 */
function fakeVerifier(): BundleVerifier {
  return {
    verify: vi.fn<BundleVerifier["verify"]>(),
  };
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
    if (err instanceof ProvenanceError) {
      expect(err.message).toMatch(/No SLSA provenance attestation found/);
    }
  });

  it("surfaces synchronous verifier.verify throws as a rejected promise", async ({ expect }) => {
    vi.mocked(fetchNpmAttestations).mockResolvedValueOnce({
      attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: STUB_BUNDLE }],
    });

    const throwingVerifier: BundleVerifier = {
      verify: vi.fn<BundleVerifier["verify"]>(() => {
        throw new Error("sync verify failure");
      }),
    };

    await expect(
      verifyPackageProvenance({
        packageName: "pkg",
        version: "1.0.0",
        repo: "owner/repo",
        verifier: throwingVerifier,
      }),
    ).rejects.toThrow("sync verify failure");
  });
});

// verifyAddonProvenance delegation and error propagation are covered
// by verify.integration.test.ts against real Rekor data.
