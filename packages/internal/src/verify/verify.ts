// SPDX-License-Identifier: Apache-2.0 OR MIT

/** Public verification API for `node-addon-slsa` and `verify-addons`. */

import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";

import type { SerializedBundle } from "@sigstore/bundle";
import dedent from "dedent";

import { createHttpClient, withRetry, type HttpClient } from "../http.ts";
import { readPackageJson } from "../package.ts";
import {
  githubRepo,
  runInvocationURI,
  sha256Hex,
  sourceCommitSha,
  sourceRef,
  type GitHubRepo,
  type Sha256Hex,
  type VerifyOptions,
} from "../types.ts";
import { createHashPassthrough } from "../util/hash.ts";
import { ProvenanceError } from "../util/provenance-error.ts";
import { verifyAddonBundle, verifyBundleSerialized } from "./bundle.ts";
import type { CertificateOIDExpectations } from "./certificates.ts";
import type { ResolvedConfig } from "./config.ts";
import { resolveConfig } from "./config.ts";
import { buildToolkitAttestSignerPattern } from "./constants.ts";
import { findAddonEntryBySha, readManifest } from "./manifest-lookup.ts";
import {
  classifyBundle404,
  createBundleVerifier,
  defaultRefPattern,
  loadTrustMaterial,
  toRegExp,
} from "./trust.ts";

export { createBundleVerifier, loadTrustMaterial } from "./trust.ts";

/** Options for {@link verifyAttestation}. */
export type VerifyAttestationOptions = VerifyOptions & {
  readonly sha256: string;
  readonly bundleUrl: string;
  readonly repo: string;
  readonly runInvocationURI: string;
  readonly sourceCommit: string;
  readonly sourceRef: string;
  /** Fulcio Build Signer URI pattern. Build with `buildAttestSignerPattern` from `node-addon-slsa/advanced`. */
  readonly attestSignerPattern: RegExp | string;
};

function httpFromConfig(config: ResolvedConfig): HttpClient {
  return createHttpClient({ dispatcher: config.dispatcher });
}

/**
 * Fetch a sidecar bundle and run the full provenance pipeline:
 * subject-bind to `sha256`, sigstore chain (TUF → Fulcio → Rekor),
 * and Fulcio cert OID pin (repo, commit, ref, runInvocationURI,
 * Build Signer URI).
 */
export async function verifyAttestation(options: VerifyAttestationOptions): Promise<void> {
  const sha = sha256Hex(options.sha256);
  const repo = githubRepo(options.repo);
  const runURI = runInvocationURI(options.runInvocationURI);
  const commit = sourceCommitSha(options.sourceCommit);
  const ref = sourceRef(options.sourceRef);
  const config = resolveConfig(options);
  const verifier =
    config.verifier ?? createBundleVerifier(config.trustMaterial ?? (await loadTrustMaterial()));
  const http = httpFromConfig(config);
  const expect: CertificateOIDExpectations = {
    sourceCommit: commit,
    sourceRef: ref,
    runInvocationURI: runURI,
    attestSignerPattern: toRegExp(options.attestSignerPattern),
  };
  await withRetry(
    () =>
      verifyAddonBundle({
        sha256: sha,
        bundleUrl: options.bundleUrl,
        repo,
        expect,
        http,
        verifier,
      }),
    {
      classify: classifyBundle404(config.bundleFetchRetryDelays),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
}

export type VerifyAttestationFromBundleOptions = VerifyOptions & {
  readonly sha256: string;
  /** Parsed sigstore bundle JSON. */
  readonly bundle: SerializedBundle;
  readonly repo: string;
  readonly runInvocationURI: string;
  readonly sourceCommit: string;
  readonly sourceRef: string;
  readonly attestSignerPattern: RegExp | string;
};

/** Same as {@link verifyAttestation} but for an in-memory bundle (no fetch, no retry). */
export async function verifyAttestationFromBundle(
  options: VerifyAttestationFromBundleOptions,
): Promise<void> {
  const sha = sha256Hex(options.sha256);
  const repo = githubRepo(options.repo);
  const runURI = runInvocationURI(options.runInvocationURI);
  const commit = sourceCommitSha(options.sourceCommit);
  const ref = sourceRef(options.sourceRef);
  const config = resolveConfig(options);
  const verifier =
    config.verifier ?? createBundleVerifier(config.trustMaterial ?? (await loadTrustMaterial()));
  const expect: CertificateOIDExpectations = {
    sourceCommit: commit,
    sourceRef: ref,
    runInvocationURI: runURI,
    attestSignerPattern: toRegExp(options.attestSignerPattern),
  };
  verifyBundleSerialized({
    sha256: sha,
    bundle: options.bundle,
    repo,
    expect,
    verifier,
  });
}

/** Options for {@link verifyPackage}. */
export type VerifyPackageOptions = VerifyOptions & {
  /** Installed package to verify. Resolved via `createRequire`. */
  readonly packageName: string;
  /** Expected source repository (`owner/repo`). Consumer's trust anchor. */
  readonly repo: string;
  /**
   * Expected tag ref. Default: `^refs/tags/v?<escaped-installed-version>$`.
   * String → exact-match (literal); RegExp → pattern match.
   */
  readonly refPattern?: RegExp | string;
  /** Resolution base; defaults to `process.cwd()`. Pass explicitly to avoid ambient-cwd dependence. */
  readonly cwd?: string;
  /** Override the Fulcio Build Signer URI pin. Defaults to the toolkit's `attest-addon.yaml`. */
  readonly attestSignerPattern?: RegExp | string;
};

/** Provenance handle returned by {@link verifyPackage}. */
export type PackageProvenance = {
  readonly packageName: string;
  readonly sourceRepo: string;
  readonly sourceCommit: string;
  readonly sourceRef: string;
  readonly runInvocationURI: string;
  /** Verify a single native-addon binary whose sha256 the caller already has. */
  verifyAddonBySha256(sha256: string): Promise<void>;
  /** Hash the file at `filePath` and verify its attestation against this provenance. */
  verifyAddonFromFile(filePath: string): Promise<void>;
};

async function hashFile(filePath: string): Promise<Sha256Hex> {
  const { stream, digest } = createHashPassthrough();
  await pipeline(createReadStream(filePath), stream, async (src) => {
    // Consume the passthrough so the pipeline completes; we only need the digest.
    for await (const _ of src) void _;
  });
  return digest();
}

/** Options for {@link verifyPackageAt} — {@link VerifyPackageOptions} minus `packageName`. */
export type VerifyPackageAtOptions = Omit<VerifyPackageOptions, "packageName">;

/** Like {@link verifyPackage}, but takes a resolved package directory. */
export async function verifyPackageAt(
  packageRoot: string,
  options: VerifyPackageAtOptions,
): Promise<PackageProvenance> {
  // Share the strict PackageJsonSchema with the CLI install path so both
  // enforce the same guards (addon.path traversal, SemVer, etc.).
  const pkg = await readPackageJson(packageRoot);
  const manifest = await readManifest(packageRoot, pkg.addon.manifest);

  if (manifest.packageName !== pkg.name) {
    throw new ProvenanceError(dedent`
      manifest.packageName does not match installed package.json name.
      manifest.packageName: ${manifest.packageName}
      package.json name:    ${pkg.name}
    `);
  }

  let expectedRepo: GitHubRepo;
  try {
    expectedRepo = githubRepo(options.repo);
  } catch (err) {
    throw new TypeError(`invalid repo option: ${options.repo}`, { cause: err });
  }
  if (manifest.sourceRepo.toLowerCase() !== expectedRepo.toLowerCase()) {
    throw new ProvenanceError(dedent`
      manifest.sourceRepo does not match expected repo.
      manifest.sourceRepo: ${manifest.sourceRepo}
      expected:            ${expectedRepo}
    `);
  }

  const refPattern = toRegExp(options.refPattern ?? defaultRefPattern(pkg.version));
  if (!refPattern.test(manifest.sourceRef)) {
    throw new ProvenanceError(dedent`
      manifest.sourceRef does not match expected refPattern.
      manifest.sourceRef: ${manifest.sourceRef}
      pattern:            ${refPattern.source}
    `);
  }

  const runURI = runInvocationURI(manifest.runInvocationURI);

  // One-time setup per handle: TUF trust fetch, verifier build, HTTP client.
  // Hoisted out of `runVerify` so verifying N addon files against the same
  // package makes one TUF round-trip, not N.
  const config = resolveConfig(options);
  const verifier =
    config.verifier ?? createBundleVerifier(config.trustMaterial ?? (await loadTrustMaterial()));
  const http = httpFromConfig(config);
  const attestSignerPattern = options.attestSignerPattern
    ? toRegExp(options.attestSignerPattern)
    : buildToolkitAttestSignerPattern();
  const expect: CertificateOIDExpectations = {
    sourceCommit: manifest.sourceCommit,
    sourceRef: manifest.sourceRef,
    runInvocationURI: runURI,
    attestSignerPattern,
  };

  const runVerify = async (sha: Sha256Hex): Promise<void> => {
    const entry = findAddonEntryBySha(manifest, sha);
    await withRetry(
      () =>
        verifyAddonBundle({
          sha256: sha,
          bundleUrl: entry.bundleUrl,
          repo: expectedRepo,
          expect,
          http,
          verifier,
        }),
      {
        classify: classifyBundle404(config.bundleFetchRetryDelays),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
  };

  return {
    packageName: manifest.packageName,
    sourceRepo: manifest.sourceRepo,
    sourceCommit: manifest.sourceCommit,
    sourceRef: manifest.sourceRef,
    runInvocationURI: manifest.runInvocationURI,
    verifyAddonBySha256: async (sha256) => runVerify(sha256Hex(sha256)),
    verifyAddonFromFile: async (filePath) => runVerify(await hashFile(filePath)),
  };
}

/**
 * Verify an installed npm package's SLSA manifest. Manifest-level checks
 * run once; reuse the returned handle to verify each `.node` binary.
 */
export async function verifyPackage(options: VerifyPackageOptions): Promise<PackageProvenance> {
  // Trailing slash forces createRequire to treat the path as a directory,
  // not a module name (which would resolve `../` from it).
  const cwd = options.cwd ?? process.cwd();
  const require = createRequire(cwd + "/");
  let pkgJsonPath: string;
  try {
    pkgJsonPath = require.resolve(`${options.packageName}/package.json`);
  } catch (err) {
    throw new Error(
      dedent`
      could not resolve ${options.packageName}/package.json from ${cwd}.
      Ensure the package is installed, or pass { cwd } explicitly.
    `,
      { cause: err },
    );
  }
  return verifyPackageAt(dirname(pkgJsonPath), options);
}

if (import.meta.vitest) {
  const { describe, it, vi } = import.meta.vitest;
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { Readable } = await import("node:stream");
  const { tempDir } = await import("../util/fs.ts");
  const { SLSA_MANIFEST_V1_SCHEMA_URL } = await import("./manifest.ts");
  const { buildAttestSignerPattern } = await import("./constants.ts");

  const FIXTURE_PATH = join(
    new URL(".", import.meta.url).pathname,
    "..",
    "..",
    "tests",
    "fixtures",
    "node-reqwest-v0.0.27.bundle.json",
  );
  const FIXTURE_SHA = "217358cf5d7c23c687cd39ec9ff50c760374fffcd338aaceb5b2a290e0a304e5";
  const FIXTURE_REPO = "vadimpiven/node_reqwest";
  const FIXTURE_COMMIT = "7492facdbdb163499e82c8b0f0cbcca0dd4f3a20";
  const FIXTURE_REF = "refs/tags/v0.0.27";
  const FIXTURE_RUN_URI =
    "https://github.com/vadimpiven/node_reqwest/actions/runs/24739695502/attempts/1";
  const fixtureSignerPattern = buildAttestSignerPattern({
    repo: "vadimpiven/node-addon-slsa",
    workflow: "publish.yaml",
  });

  void Readable;

  describe("verifyAttestationFromBundle", () => {
    it("verifies a real bundle's subject + cert OIDs (no fetch)", async () => {
      const bundle = JSON.parse((await readFile(FIXTURE_PATH)).toString("utf8"));
      await verifyAttestationFromBundle({
        sha256: FIXTURE_SHA,
        bundle,
        repo: FIXTURE_REPO,
        runInvocationURI: FIXTURE_RUN_URI,
        sourceCommit: FIXTURE_COMMIT,
        sourceRef: FIXTURE_REF,
        attestSignerPattern: fixtureSignerPattern,
        verifier: { verify: () => undefined },
      });
    });

    it("rejects when the requested sha is not in the bundle's subjects", async ({ expect }) => {
      const bundle = JSON.parse((await readFile(FIXTURE_PATH)).toString("utf8"));
      await expect(
        verifyAttestationFromBundle({
          sha256: "0".repeat(64),
          bundle,
          repo: FIXTURE_REPO,
          runInvocationURI: FIXTURE_RUN_URI,
          sourceCommit: FIXTURE_COMMIT,
          sourceRef: FIXTURE_REF,
          attestSignerPattern: fixtureSignerPattern,
          verifier: { verify: () => undefined },
        }),
      ).rejects.toThrow(/does not attest the requested artifact/);
    });
  });

  describe("verifyAttestation", () => {
    it("fetches the sidecar bundle via dispatcher and verifies it", async () => {
      const bundleBytes = await readFile(FIXTURE_PATH);
      const { mockFetch } = await import("../../tests/helpers/mock-fetch.ts");
      await using dispatcher = mockFetch(() => ({
        statusCode: 200,
        responseOptions: { headers: { "content-type": "application/json" } },
        data: bundleBytes,
      }));
      await verifyAttestation({
        sha256: FIXTURE_SHA,
        bundleUrl: "https://example.invalid/bundle.sigstore",
        repo: FIXTURE_REPO,
        runInvocationURI: FIXTURE_RUN_URI,
        sourceCommit: FIXTURE_COMMIT,
        sourceRef: FIXTURE_REF,
        attestSignerPattern: fixtureSignerPattern,
        verifier: { verify: () => undefined },
        dispatcher,
      });
    });
  });

  const ADDON_SHA = "b".repeat(64);

  const BASE_MANIFEST = {
    $schema: SLSA_MANIFEST_V1_SCHEMA_URL,
    packageName: "my-pkg",
    runInvocationURI: "https://github.com/owner/repo/actions/runs/1/attempts/1",
    sourceRepo: "owner/repo",
    sourceCommit: "a".repeat(40),
    sourceRef: "refs/tags/v1.2.3",
    addons: {
      linux: {
        x64: {
          url: "https://e.com/a.node.gz",
          bundleUrl: "https://e.com/a.node.gz.sigstore",
          sha256: ADDON_SHA,
        },
      },
    },
  } as const;

  async function makePackage(
    overrides: {
      pkg?: Record<string, unknown>;
      manifest?: Record<string, unknown>;
    } = {},
  ): Promise<{ path: string } & AsyncDisposable> {
    const tmp = await tempDir();
    const pkg = {
      name: "my-pkg",
      version: "1.2.3",
      addon: {
        path: "./dist/my.node",
        manifest: "./slsa-manifest.json",
      },
      ...overrides.pkg,
    };
    const manifest = { ...BASE_MANIFEST, ...overrides.manifest };
    await writeFile(join(tmp.path, "package.json"), JSON.stringify(pkg));
    await writeFile(join(tmp.path, "slsa-manifest.json"), JSON.stringify(manifest));
    return tmp;
  }

  describe("verifyPackageAt", () => {
    it("returns a provenance handle for a matching manifest", async ({ expect }) => {
      await using tmp = await makePackage();
      const p = await verifyPackageAt(tmp.path, {
        repo: "owner/repo",
        verifier: { verify: () => undefined },
      });
      expect(p.sourceRepo).toBe("owner/repo");
      expect(p.sourceCommit).toBe("a".repeat(40));
      expect(p.sourceRef).toBe("refs/tags/v1.2.3");
    });

    it("rejects manifest packageName mismatch", async ({ expect }) => {
      await using tmp = await makePackage({ manifest: { packageName: "other" } });
      await expect(
        verifyPackageAt(tmp.path, { repo: "owner/repo", verifier: { verify: () => undefined } }),
      ).rejects.toThrow(/manifest\.packageName/);
    });

    it("rejects sourceRepo mismatch", async ({ expect }) => {
      await using tmp = await makePackage();
      await expect(
        verifyPackageAt(tmp.path, { repo: "evil/repo", verifier: { verify: () => undefined } }),
      ).rejects.toThrow(/manifest\.sourceRepo/);
    });

    it("accepts case-insensitive repo match", async ({ expect }) => {
      await using tmp = await makePackage();
      await expect(
        verifyPackageAt(tmp.path, { repo: "Owner/Repo", verifier: { verify: () => undefined } }),
      ).resolves.toBeDefined();
    });

    it("rejects invalid repo option", async ({ expect }) => {
      await using tmp = await makePackage();
      await expect(
        verifyPackageAt(tmp.path, { repo: "not-a-slash", verifier: { verify: () => undefined } }),
      ).rejects.toThrow(TypeError);
    });

    it("default refPattern rejects other versions / branches", async ({ expect }) => {
      await using tmpOther = await makePackage({ manifest: { sourceRef: "refs/tags/v1.2.4" } });
      await expect(
        verifyPackageAt(tmpOther.path, {
          repo: "owner/repo",
          verifier: { verify: () => undefined },
        }),
      ).rejects.toThrow();
    });

    it("rejects wrong $schema in manifest", async ({ expect }) => {
      await using tmp = await makePackage({
        manifest: { $schema: "https://e.com/other.json" },
      });
      await expect(
        verifyPackageAt(tmp.path, { repo: "owner/repo", verifier: { verify: () => undefined } }),
      ).rejects.toThrow();
    });

    it("rejects missing manifest file", async ({ expect }) => {
      await using tmp = await tempDir();
      await writeFile(
        join(tmp.path, "package.json"),
        JSON.stringify({
          name: "x",
          version: "1.0.0",
          addon: {
            path: "./dist/my.node",
            manifest: "./slsa-manifest.json",
            attestWorkflow: "release.yaml",
          },
        }),
      );
      await expect(
        verifyPackageAt(tmp.path, { repo: "owner/repo", verifier: { verify: () => undefined } }),
      ).rejects.toThrow(/manifest not found/);
    });

    it("verifyAddonBySha256 validates input", async ({ expect }) => {
      await using tmp = await makePackage();
      const p = await verifyPackageAt(tmp.path, {
        repo: "owner/repo",
        verifier: { verify: () => undefined },
      });
      await expect(p.verifyAddonBySha256("not-hex")).rejects.toThrow(TypeError);
    });

    it("verifyAddonBySha256 rejects an sha not present in the manifest", async ({ expect }) => {
      await using tmp = await makePackage();
      const p = await verifyPackageAt(tmp.path, {
        repo: "owner/repo",
        verifier: { verify: () => undefined },
      });
      await expect(p.verifyAddonBySha256("c".repeat(64))).rejects.toThrow(/not found in manifest/);
    });

    it("verifyAddonFromFile hashes the file and looks it up in the manifest", async ({
      expect,
    }) => {
      await using tmp = await makePackage();
      const p = await verifyPackageAt(tmp.path, {
        repo: "owner/repo",
        verifier: { verify: () => undefined },
      });
      const filePath = join(tmp.path, "fake.node.gz");
      await writeFile(filePath, "not the addon");
      // Hash won't match the manifest's recorded sha so we land in
      // findAddonEntryBySha's rejection branch — but only after
      // verifyAddonFromFile streams + hashes the file, which is the line
      // we want to cover.
      await expect(p.verifyAddonFromFile(filePath)).rejects.toThrow(/not found in manifest/);
    });
  });

  describe("verifyPackage", () => {
    it("throws when package cannot be resolved", async ({ expect }) => {
      await expect(
        verifyPackage({ packageName: "nonexistent-pkg-xyz", repo: "o/r" }),
      ).rejects.toThrow(/could not resolve/);
    });

    it("resolves packageName via createRequire from explicit cwd", async ({ expect }) => {
      await using tmpRoot = await tempDir();
      const nm = join(tmpRoot.path, "node_modules", "my-pkg");
      await mkdir(nm, { recursive: true });
      await writeFile(
        join(nm, "package.json"),
        JSON.stringify({
          name: "my-pkg",
          version: "1.2.3",
          addon: {
            path: "./dist/my.node",
            manifest: "./slsa-manifest.json",
            attestWorkflow: "release.yaml",
          },
        }),
      );
      await writeFile(join(nm, "slsa-manifest.json"), JSON.stringify(BASE_MANIFEST));
      await using otherCwd = await tempDir();
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(otherCwd.path);
      try {
        const p = await verifyPackage({
          packageName: "my-pkg",
          repo: "owner/repo",
          cwd: tmpRoot.path,
          verifier: { verify: () => undefined },
        });
        expect(p.sourceRepo).toBe("owner/repo");
      } finally {
        cwdSpy.mockRestore();
      }
    });
  });
}
