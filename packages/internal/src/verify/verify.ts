// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Public verification API consumed by node-addon-slsa and verify-addons.
 * Owns manifest reading, Fulcio cert OID expectations, and the sidecar
 * bundle fetch-retry loop; delegates per-addon bundle verification to
 * {@link ./bundle.ts}.
 */

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import { bundleFromJSON } from "@sigstore/bundle";
import { getTrustedRoot } from "@sigstore/tuf";
import {
  toSignedEntity,
  toTrustMaterial,
  Verifier as SigstoreVerifier,
  type TrustMaterial,
} from "@sigstore/verify";
import dedent from "dedent";

import { createHttpClient, HttpError, withRetry, type HttpClient } from "../http.ts";
import { readPackageJson } from "../package.ts";
import {
  githubRepo,
  runInvocationURI,
  sha256Hex,
  sourceCommitSha,
  sourceRef,
  type BundleVerifier,
  type GitHubRepo,
  type Sha256Hex,
  type VerifyOptions,
} from "../types.ts";
import { errorMessage } from "../util/error.ts";
import { createHashPassthrough } from "../util/hash.ts";
import { ProvenanceError } from "../util/provenance-error.ts";
import { verifyAddonBundle } from "./bundle.ts";
import type { CertificateOIDExpectations } from "./certificates.ts";
import type { ResolvedConfig } from "./config.ts";
import { resolveConfig } from "./config.ts";
import { buildAttestSignerPattern, DEFAULT_MANIFEST_PATH, escapeRegExp } from "./constants.ts";
import { SLSA_MANIFEST_V1_SCHEMA_URL, SlsaManifestSchemaV1, type SlsaManifest } from "./schemas.ts";

/** Load sigstore trust material (Fulcio CAs, Rekor public keys) from the TUF repository. */
export async function loadTrustMaterial(): Promise<TrustMaterial> {
  return toTrustMaterial(await getTrustedRoot());
}

/**
 * Build a sigstore {@link BundleVerifier} over the given trust material.
 * Exposed for callers that want to reuse a single verifier across many
 * verifications (amortizes trust-material loading and lets them tune
 * sigstore threshold options directly via `@sigstore/verify.Verifier`).
 */
export function createBundleVerifier(trustMaterial: TrustMaterial): BundleVerifier {
  const verifier = new SigstoreVerifier(trustMaterial);
  return {
    verify(bundle) {
      verifier.verify(toSignedEntity(bundleFromJSON(bundle)));
    },
  };
}

/** Normalize a `RegExp | string` pattern to a `RegExp`. Strings are anchored and escaped. */
function toRegExp(pattern: RegExp | string): RegExp {
  if (pattern instanceof RegExp) return pattern;
  return new RegExp(`^${escapeRegExp(pattern)}$`);
}

/** Default `refPattern` for a given installed package version. */
function defaultRefPattern(version: string): RegExp {
  return new RegExp(`^refs/tags/v?${escapeRegExp(version)}$`);
}

/**
 * Retry when the sidecar bundle URL 404s (CDN propagation lag after a
 * fresh release-asset upload). Any other error is fatal.
 */
function classifyBundle404(
  delays: readonly number[],
): (err: unknown, attempt: number) => { retry: true; delayMs: number } | { retry: false } {
  return (err, attempt) => {
    const index = attempt - 1;
    if (index >= delays.length) return { retry: false };
    if (err instanceof HttpError && err.kind === "status" && err.status === 404) {
      return { retry: true, delayMs: delays[index] ?? 0 };
    }
    return { retry: false };
  };
}

/** Options for {@link verifyAttestation}. */
export type VerifyAttestationOptions = VerifyOptions & {
  readonly sha256: string;
  readonly bundleUrl: string;
  readonly repo: string;
  readonly runInvocationURI: string;
  readonly sourceCommit: string;
  readonly sourceRef: string;
  /**
   * Fulcio Build Signer URI pin (OID 1.3.6.1.4.1.57264.1.9). Attestations
   * whose `job_workflow_ref` claim doesn't match this pattern are
   * rejected. Build with `buildAttestSignerPattern` (from
   * `node-addon-slsa/advanced`) for the common "one workflow in one
   * repo" case, or pass a regex directly for advanced multi-workflow
   * setups.
   */
  readonly attestSignerPattern: RegExp | string;
};

function httpFromConfig(config: ResolvedConfig): HttpClient {
  return createHttpClient({ dispatcher: config.dispatcher });
}

/**
 * Verify that the bundle at `bundleUrl` attests the given `sha256` and
 * carries a Fulcio cert whose OIDs match the expected workflow run.
 * Retries briefly on 404 for CDN propagation; any other failure is fatal.
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
    classifyBundle404(config.bundleFetchRetryDelays),
    options.signal ? { signal: options.signal } : undefined,
  );
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
  /**
   * Directory to resolve `packageName` from. Defaults to `process.cwd()`.
   * Programmatic callers that don't want to depend on ambient cwd (test
   * harnesses, host processes that may `chdir`, long-running services)
   * should pass this explicitly — typically the host's own
   * `require.resolve('./package.json')` directory, or the project root.
   */
  readonly cwd?: string;
  /**
   * Override the Fulcio Build Signer URI pin. When omitted, the pattern
   * is derived from `manifest.sourceRepo` + `pkg.addon.attestWorkflow`
   * via `buildAttestSignerPattern` (from `node-addon-slsa/advanced`).
   * Override to accept attestations from additional workflows, or to
   * tighten the pattern further.
   */
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

async function readManifest(packageRoot: string, manifestRel: string): Promise<SlsaManifest> {
  const manifestAbs = resolve(packageRoot, manifestRel);
  let raw: string;
  try {
    raw = await readFile(manifestAbs, "utf8");
  } catch {
    throw new ProvenanceError(dedent`
      manifest not found at ${manifestRel}.
      The package was not published with node-addon-slsa, or the
      "addon.manifest" field in package.json points to a missing file.
    `);
  }
  try {
    return SlsaManifestSchemaV1.parse(JSON.parse(raw));
  } catch (err) {
    throw new ProvenanceError(dedent`
      manifest at ${manifestRel} failed schema validation.
      ${errorMessage(err)}
    `);
  }
}

/** Locate the manifest addon entry whose sha256 matches the hashed binary. */
function findAddonEntryBySha(
  manifest: SlsaManifest,
  sha256: string,
): { url: string; bundleUrl: string; sha256: string } {
  for (const byArch of Object.values(manifest.addons)) {
    for (const entry of Object.values(byArch ?? {})) {
      if (entry && entry.sha256.toLowerCase() === sha256.toLowerCase()) {
        return entry;
      }
    }
  }
  throw new ProvenanceError(
    `sha256 ${sha256} not found in manifest's addon inventory — the binary does not match any declared addon.`,
  );
}

/**
 * Verify an installed package's manifest and return a provenance handle.
 * Prefer {@link verifyPackage}; this form is for test fixtures
 * and hosts that have already resolved the package directory.
 */
export async function verifyPackageAt(
  packageRoot: string,
  options: Omit<VerifyPackageOptions, "packageName">,
): Promise<PackageProvenance> {
  // Share the strict PackageJsonSchema with the CLI install path so both
  // enforce the same guards (addon.path traversal, SemVer, etc.).
  const pkg = await readPackageJson(packageRoot);
  const manifestRel = pkg.addon.manifest ?? DEFAULT_MANIFEST_PATH;
  const manifest = await readManifest(packageRoot, manifestRel);

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
    : buildAttestSignerPattern({
        repo: manifest.sourceRepo,
        workflow: pkg.addon.attestWorkflow,
      });
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
      classifyBundle404(config.bundleFetchRetryDelays),
      options.signal ? { signal: options.signal } : undefined,
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
 * Verify an installed npm package's SLSA manifest and return a handle
 * for per-addon provenance verification. Manifest-level checks run once;
 * the returned handle reuses them across every addon file the caller
 * feeds in, so call `verifyPackage` once and `verifyAddonFromFile` for
 * each `.node` binary the host is about to load.
 *
 * @throws {@link ProvenanceError} on any schema or trust-chain mismatch.
 * @throws `TypeError` on malformed option values (invalid `repo` slug, etc.).
 */
export async function verifyPackage(options: VerifyPackageOptions): Promise<PackageProvenance> {
  // Resolution base: caller-supplied `cwd` for programmatic use, falling
  // back to `process.cwd()` for CLI-style callers. The trailing slash is
  // required so createRequire treats the path as a directory — without
  // it, createRequire would treat it as a *module* and resolve ../ from it.
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
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { tempDir } = await import("../util/fs.ts");

  const ADDON_SHA = "b".repeat(64);

  const BASE_MANIFEST: SlsaManifest = {
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
  };

  async function makePackage(
    overrides: {
      pkg?: Record<string, unknown>;
      manifest?: Partial<SlsaManifest>;
    } = {},
  ): Promise<{ path: string } & AsyncDisposable> {
    const tmp = await tempDir();
    const pkg = {
      name: "my-pkg",
      version: "1.2.3",
      addon: {
        path: "./dist/my.node",
        manifest: "./slsa-manifest.json",
        attestWorkflow: "release.yaml",
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
        manifest: { $schema: "https://e.com/other.json" as SlsaManifest["$schema"] },
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
