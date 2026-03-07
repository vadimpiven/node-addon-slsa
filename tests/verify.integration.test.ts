// SPDX-License-Identifier: Apache-2.0 OR MIT

import { describe, it, vi } from "vitest";

import { runInvocationURI, sha256Hex } from "../src/types.ts";
import { ProvenanceError } from "../src/util/provenance-error.ts";
import { verifyAddonProvenance, verifyPackageProvenance } from "../src/verify/index.ts";

vi.setConfig({ testTimeout: 30_000 });

// Integration tests below require network access. They verify provenance
// against real npm/GitHub API responses for specific published versions.

describe("verifyPackageProvenance (integration)", () => {
  it("succeeds for unscoped package", async ({ expect }) => {
    const provenance = await verifyPackageProvenance({
      packageName: "semver",
      version: "7.6.3",
      repo: "npm/node-semver",
    });
    expect(provenance.runInvocationURI).toMatch(
      /^https:\/\/github\.com\/npm\/node-semver\/actions\/runs\//,
    );
    expect(provenance.verifyAddon).toBeTypeOf("function");
  });

  it("succeeds for scoped package", async ({ expect }) => {
    const provenance = await verifyPackageProvenance({
      packageName: "@npmcli/run-script",
      version: "9.0.2",
      repo: "npm/run-script",
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
    });
    expect(provenance.runInvocationURI).toMatch(
      /^https:\/\/github\.com\/nodejs\/undici\/actions\/runs\//,
    );
  });

  it("rejects when expected repo does not match", async ({ expect }) => {
    await expect(
      verifyPackageProvenance({ packageName: "semver", version: "7.6.3", repo: "wrong/repo" }),
    ).rejects.toThrow("SECURITY");
  });

  it("verifyAddon rejects wrong hash for verified package", async ({ expect }) => {
    const provenance = await verifyPackageProvenance({
      packageName: "semver",
      version: "7.6.3",
      repo: "npm/node-semver",
    });
    await expect(
      provenance.verifyAddon({
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

describe("verifyAddonProvenance (integration)", () => {
  it("succeeds with correct hash, repo, and run URI", async ({ expect }) => {
    await expect(
      verifyAddonProvenance({
        sha256: CLI_HASH,
        runInvocationURI: CLI_RUN_URI,
        repo: CLI_REPO,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects when expected repo does not match", async ({ expect }) => {
    await expect(
      verifyAddonProvenance({
        sha256: CLI_HASH,
        runInvocationURI: CLI_RUN_URI,
        repo: "wrong/repo",
      }),
    ).rejects.toThrow(ProvenanceError);
  });

  it("rejects when run invocation URI does not match", async ({ expect }) => {
    const wrongRunURI = runInvocationURI("https://github.com/cli/cli/actions/runs/1/attempts/1");
    await expect(
      verifyAddonProvenance({
        sha256: CLI_HASH,
        runInvocationURI: wrongRunURI,
        repo: CLI_REPO,
      }),
    ).rejects.toThrow(ProvenanceError);
  });
});
