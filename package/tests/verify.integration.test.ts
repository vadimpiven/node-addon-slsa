// SPDX-License-Identifier: Apache-2.0 OR MIT

import { beforeAll, describe, it, vi } from "vitest";
import { createVerifier } from "sigstore";
import { type TrustMaterial } from "@sigstore/verify";

import { runInvocationURI, sha256Hex, type BundleVerifier } from "../src/types.ts";
import type { PackageProvenance } from "../src/verify/index.ts";
import { ProvenanceError } from "../src/util/provenance-error.ts";
import { GITHUB_ACTIONS_ISSUER } from "../src/verify/constants.ts";
import { resolveConfig } from "../src/verify/config.ts";
import {
  verifyAddonProvenance,
  verifyPackageProvenance,
  loadTrustMaterial,
} from "../src/verify/index.ts";
import { verifyRekorAttestations } from "../src/verify/rekor.ts";

vi.setConfig({ testTimeout: 30_000 });

// Integration tests below require network access. They verify provenance
// against real npm/Rekor responses for specific published versions.

describe("verifyPackageProvenance (integration)", () => {
  // Shared sigstore verifier — avoids re-initialising TUF trust root per test.
  let verifier: BundleVerifier;
  beforeAll(async () => {
    verifier = await createVerifier({ certificateIssuer: GITHUB_ACTIONS_ISSUER });
  });

  // Fetched once in "succeeds for unscoped package", reused by later tests
  // to avoid redundant npm registry round-trips for the same package.
  let semverProvenance: PackageProvenance;

  it("succeeds for unscoped package", async ({ expect }) => {
    semverProvenance = await verifyPackageProvenance({
      packageName: "semver",
      version: "7.6.3",
      repo: "npm/node-semver",
      verifier,
    });
    expect(semverProvenance.runInvocationURI).toMatch(
      /^https:\/\/github\.com\/npm\/node-semver\/actions\/runs\//,
    );
    expect(semverProvenance.verifyAddon).toBeTypeOf("function");
  });

  it("succeeds for scoped package", async ({ expect }) => {
    const provenance = await verifyPackageProvenance({
      packageName: "@npmcli/run-script",
      version: "9.0.2",
      repo: "npm/run-script",
      verifier,
    });
    expect(provenance.runInvocationURI).toMatch(
      /^https:\/\/github\.com\/npm\/run-script\/actions\/runs\//,
    );
  });

  it("succeeds for bundle v0.3 format", async ({ expect }) => {
    // undici@7.3.0 uses Sigstore bundle v0.3 with top-level
    // `certificate` instead of `x509CertificateChain`
    const provenance = await verifyPackageProvenance({
      packageName: "undici",
      version: "7.3.0",
      repo: "nodejs/undici",
      verifier,
    });
    expect(provenance.runInvocationURI).toMatch(
      /^https:\/\/github\.com\/nodejs\/undici\/actions\/runs\//,
    );
  });

  it("rejects when expected repo does not match", async ({ expect }) => {
    await expect(
      verifyPackageProvenance({
        packageName: "semver",
        version: "7.6.3",
        repo: "wrong/repo",
        verifier,
      }),
    ).rejects.toThrow("SECURITY");
  });

  it("verifyAddon rejects wrong hash for verified package", async ({ expect }) => {
    // Reuses the handle from "succeeds for unscoped package" — no extra npm fetch.
    await expect(
      semverProvenance.verifyAddon({
        sha256: sha256Hex("0000000000000000000000000000000000000000000000000000000000000000"),
      }),
    ).rejects.toThrow(ProvenanceError);
  });

  it("rejects for a package without provenance", async ({ expect }) => {
    await expect(
      verifyPackageProvenance({
        packageName: "express",
        version: "4.21.2",
        repo: "expressjs/express",
        verifier,
      }),
    ).rejects.toThrow();
  });
});

// Real cli/cli attestation data (stable, published release)
const CLI_HASH = sha256Hex("7c6d3b5ac88c897fb3ac0c8a479f4fb8083bd05a758fb8d3275642a93d20570d");
const CLI_REPO = "cli/cli";
const CLI_RUN_URI = runInvocationURI(
  "https://github.com/cli/cli/actions/runs/22312430014/attempts/4",
);

// Pre-load TUF trust material once for all Rekor tests.
let trustMaterial: TrustMaterial;
beforeAll(async () => {
  trustMaterial = await loadTrustMaterial();
});

const rekorConfig = resolveConfig({ retryCount: 0 });

describe("verifyAddonProvenance (integration)", () => {
  it("succeeds with correct hash, repo, and run URI", async ({ expect }) => {
    await expect(
      verifyAddonProvenance({
        sha256: CLI_HASH,
        runInvocationURI: CLI_RUN_URI,
        repo: CLI_REPO,
        trustMaterial,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects when repo does not match", async ({ expect }) => {
    await expect(
      verifyAddonProvenance({
        sha256: CLI_HASH,
        runInvocationURI: CLI_RUN_URI,
        repo: "wrong/repo",
        trustMaterial,
      }),
    ).rejects.toThrow(ProvenanceError);
  });

  it("rejects when run URI does not match", async ({ expect }) => {
    await expect(
      verifyAddonProvenance({
        sha256: CLI_HASH,
        runInvocationURI: runInvocationURI("https://github.com/cli/cli/actions/runs/1/attempts/1"),
        repo: CLI_REPO,
        trustMaterial,
      }),
    ).rejects.toThrow(ProvenanceError);
  });
});

describe("verifyRekorAttestations (integration)", () => {
  it("succeeds for known public attestation", async ({ expect }) => {
    await expect(
      verifyRekorAttestations({
        sha256: CLI_HASH,
        runInvocationURI: CLI_RUN_URI,
        repo: CLI_REPO,
        config: rekorConfig,
        trustMaterial,
      }),
    ).resolves.toBeUndefined();
  });

  it("throws ProvenanceError for unknown hash", async ({ expect }) => {
    await expect(
      verifyRekorAttestations({
        sha256: sha256Hex("ff".repeat(32)),
        runInvocationURI: CLI_RUN_URI,
        repo: CLI_REPO,
        config: rekorConfig,
        trustMaterial,
      }),
    ).rejects.toThrow(ProvenanceError);
  });

  it("throws ProvenanceError when run URI mismatches", async ({ expect }) => {
    await expect(
      verifyRekorAttestations({
        sha256: CLI_HASH,
        runInvocationURI: runInvocationURI("https://github.com/cli/cli/actions/runs/1/attempts/1"),
        repo: CLI_REPO,
        config: rekorConfig,
        trustMaterial,
      }),
    ).rejects.toThrow(ProvenanceError);
  });

  it("throws ProvenanceError when repo mismatches", async ({ expect }) => {
    await expect(
      verifyRekorAttestations({
        sha256: CLI_HASH,
        runInvocationURI: CLI_RUN_URI,
        repo: "wrong/repo",
        config: rekorConfig,
        trustMaterial,
      }),
    ).rejects.toThrow(ProvenanceError);
  });
});
