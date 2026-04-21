// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Public verification API consumed by node-addon-slsa and verify-addons.
 * Owns manifest reading, Fulcio cert OID expectations, and the Rekor
 * ingestion-lag retry loop; delegates Rekor I/O to {@link ./rekor.ts}.
 */

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import { getTrustedRoot } from "@sigstore/tuf";
import { toSignedEntity } from "@sigstore/verify";
import {
  toTrustMaterial,
  Verifier as SigstoreVerifier,
  type TrustMaterial,
} from "@sigstore/verify";
import { bundleFromJSON } from "@sigstore/bundle";
import dedent from "dedent";

import { createHttpClient, withRetry } from "../http.ts";
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
import { readPackageJson } from "../package.ts";
import { errorMessage } from "../util/error.ts";
import { createHashPassthrough } from "../util/hash.ts";
import { isProvenanceError, ProvenanceError } from "../util/provenance-error.ts";
import type { CertificateOIDExpectations } from "./certificates.ts";
import type { ResolvedConfig } from "./config.ts";
import { resolveConfig } from "./config.ts";
import { DEFAULT_ATTEST_SIGNER_PATTERN, DEFAULT_MANIFEST_PATH } from "./constants.ts";
import { createRekorClient, type RekorClient } from "./rekor-client.ts";
import { verifyRekorAttestations } from "./rekor.ts";
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Normalize a `RegExp | string` pattern to a `RegExp`. Strings are anchored and escaped. */
function toRegExp(pattern: RegExp | string): RegExp {
  if (pattern instanceof RegExp) return pattern;
  return new RegExp(`^${escapeRegExp(pattern)}$`);
}

/**
 * Build a Build Signer URI pin from a URL prefix. The prefix must be the
 * full URL Fulcio embeds (e.g. `https://github.com/acme/fork/.github/\
 * workflows/publish.yaml`) — not the raw `job_workflow_ref` claim. It is
 * escaped and anchored with a required `@<40-hex-commit-sha>` suffix,
 * matching the shape {@link DEFAULT_ATTEST_SIGNER_PATTERN} enforces.
 * Forks that use reusable workflows get a commit SHA in `job_workflow_ref`
 * automatically, so this tail is the same for the default and any override.
 *
 * Accepting a raw RegExp here would be a footgun (`.*` silently nullifies
 * the pin); accepting `@.+$` would accept mutable refs (`refs/tags/v1`).
 */
export function buildSignerPatternFromPrefix(prefix: string): RegExp {
  return new RegExp(`^${escapeRegExp(prefix)}@[0-9a-f]{40}$`);
}

/** Default `refPattern` for a given installed package version. */
function defaultRefPattern(version: string): RegExp {
  return new RegExp(`^refs/tags/v?${escapeRegExp(version)}$`);
}

/**
 * Options for {@link verifyAttestation}. Plain strings are validated internally;
 * no branded-type constructors required at call sites.
 */
export type VerifyAttestationOptions = VerifyOptions & {
  readonly sha256: string;
  readonly repo: string;
  readonly runInvocationURI: string;
  readonly sourceCommit: string;
  readonly sourceRef: string;
  /**
   * Override the default Build Signer URI pin. Accepts a URL *prefix*
   * (everything up to — but not including — the `@<ref-or-sha>` segment);
   * the `@.+$` tail is enforced internally.
   */
  readonly attestSignerPattern?: string;
};

/** Default client: one undici-backed HttpClient shared across search + entry fetches. */
function clientFromConfig(config: ResolvedConfig): RekorClient {
  if (config.rekorClient) return config.rekorClient;
  return createRekorClient({
    http: createHttpClient({ dispatcher: config.dispatcher }),
    searchUrl: config.rekorSearchUrl,
    entryUrl: config.rekorEntryUrl,
    timeoutMs: config.timeoutMs,
  });
}

/** Retry on `rekor-not-found` per `delays`; fatal on anything else. */
function classifyIngestionLag(
  delays: readonly number[],
): (err: unknown, attempt: number) => { retry: true; delayMs: number } | { retry: false } {
  return (err, attempt) => {
    const index = attempt - 1;
    if (index >= delays.length) return { retry: false };
    if (isProvenanceError(err) && err.kind === "rekor-not-found") {
      return { retry: true, delayMs: delays[index] ?? 0 };
    }
    return { retry: false };
  };
}

/**
 * Verify a Rekor entry exists for the given sha256 whose signing cert's
 * OIDs match the expected workflow run. Retries briefly for Rekor
 * ingestion lag (publish-side only; new attestations take ~30s to index).
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
  const client = clientFromConfig(config);
  const expect: CertificateOIDExpectations = {
    sourceCommit: commit,
    sourceRef: ref,
    runInvocationURI: runURI,
    attestSignerPattern: options.attestSignerPattern
      ? buildSignerPatternFromPrefix(options.attestSignerPattern)
      : DEFAULT_ATTEST_SIGNER_PATTERN,
  };
  await withRetry(
    () =>
      verifyRekorAttestations({
        sha256: sha,
        repo,
        expect,
        client,
        verifier,
        maxEntries: config.maxRekorEntries,
      }),
    classifyIngestionLag(config.rekorIngestionRetryDelays),
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
   * Fulcio cert's Build Signer URI pin. Defaults to the built-in pattern
   * matching this toolkit's reusable publish workflow. Override only to
   * verify a package produced by a different fork's publish workflow.
   *
   * Accepts a URL *prefix* (e.g. `https://github.com/owner/fork/.github/workflows/publish.yaml`);
   * the required `@<ref-or-sha>` tail is enforced internally. Accepting a
   * raw RegExp would let a careless `.*` nullify the entire pin.
   */
  readonly attestSignerPattern?: string;
  /**
   * Directory to resolve `packageName` from. Defaults to `process.cwd()`.
   * Programmatic callers that don't want to depend on ambient cwd (test
   * harnesses, host processes that may `chdir`, long-running services)
   * should pass this explicitly — typically the host's own
   * `require.resolve('./package.json')` directory, or the project root.
   */
  readonly cwd?: string;
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
  const attestSignerPattern = options.attestSignerPattern
    ? buildSignerPatternFromPrefix(options.attestSignerPattern)
    : DEFAULT_ATTEST_SIGNER_PATTERN;

  // One-time setup per handle: TUF trust fetch, verifier build, Rekor
  // client. Hoisted out of `runRekor` so verifying N addon files against
  // the same package makes one TUF round-trip, not N.
  const config = resolveConfig(options);
  const verifier =
    config.verifier ?? createBundleVerifier(config.trustMaterial ?? (await loadTrustMaterial()));
  const client = clientFromConfig(config);
  const expect: CertificateOIDExpectations = {
    sourceCommit: manifest.sourceCommit,
    sourceRef: manifest.sourceRef,
    runInvocationURI: runURI,
    attestSignerPattern,
  };

  const runRekor = async (sha: Sha256Hex): Promise<void> => {
    await withRetry(
      () =>
        verifyRekorAttestations({
          sha256: sha,
          repo: expectedRepo,
          expect,
          client,
          verifier,
          maxEntries: config.maxRekorEntries,
        }),
      classifyIngestionLag(config.rekorIngestionRetryDelays),
      options.signal ? { signal: options.signal } : undefined,
    );
  };

  return {
    packageName: manifest.packageName,
    sourceRepo: manifest.sourceRepo,
    sourceCommit: manifest.sourceCommit,
    sourceRef: manifest.sourceRef,
    runInvocationURI: manifest.runInvocationURI,
    verifyAddonBySha256: async (sha256) => runRekor(sha256Hex(sha256)),
    verifyAddonFromFile: async (filePath) => runRekor(await hashFile(filePath)),
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
 *
 * @example
 * Minimal — trust bootstraps per call:
 * ```typescript
 * import { verifyPackage } from "node-addon-slsa";
 *
 * const p = await verifyPackage({
 *   packageName: "my-addon",
 *   repo: "owner/repo",
 * });
 * await p.verifyAddonFromFile("/path/to/my-addon/dist/addon.node.gz");
 * ```
 *
 * @example
 * Heavy use — pre-build the verifier once and reuse across many packages:
 * ```typescript
 * import { verifyPackage } from "node-addon-slsa";
 * import { loadTrustMaterial, createBundleVerifier } from "node-addon-slsa/advanced";
 *
 * const verifier = createBundleVerifier(await loadTrustMaterial());
 *
 * for (const name of ["addon-a", "addon-b", "addon-c"]) {
 *   const p = await verifyPackage({
 *     packageName: name,
 *     repo: "owner/repo",
 *     verifier,
 *   });
 *   await p.verifyAddonFromFile(`/path/to/${name}/dist/addon.node.gz`);
 * }
 * ```
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
  const { RekorError } = await import("./rekor-client.ts");

  const BASE_MANIFEST: SlsaManifest = {
    $schema: SLSA_MANIFEST_V1_SCHEMA_URL,
    packageName: "my-pkg",
    runInvocationURI: "https://github.com/owner/repo/actions/runs/1/attempts/1",
    sourceRepo: "owner/repo",
    sourceCommit: "a".repeat(40),
    sourceRef: "refs/tags/v1.2.3",
    addons: {
      linux: { x64: { url: "https://e.com/a.node.gz", sha256: "b".repeat(64) } },
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
      addon: { path: "./dist/my.node", manifest: "./slsa-manifest.json" },
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
      const p = await verifyPackageAt(tmp.path, { repo: "owner/repo" });
      expect(p.sourceRepo).toBe("owner/repo");
      expect(p.sourceCommit).toBe("a".repeat(40));
      expect(p.sourceRef).toBe("refs/tags/v1.2.3");
    });

    it("rejects manifest packageName mismatch", async ({ expect }) => {
      await using tmp = await makePackage({ manifest: { packageName: "other" } });
      await expect(verifyPackageAt(tmp.path, { repo: "owner/repo" })).rejects.toThrow(
        /manifest\.packageName/,
      );
    });

    it("rejects sourceRepo mismatch", async ({ expect }) => {
      await using tmp = await makePackage();
      await expect(verifyPackageAt(tmp.path, { repo: "evil/repo" })).rejects.toThrow(
        /manifest\.sourceRepo/,
      );
    });

    it("accepts case-insensitive repo match", async ({ expect }) => {
      await using tmp = await makePackage();
      await expect(verifyPackageAt(tmp.path, { repo: "Owner/Repo" })).resolves.toBeDefined();
    });

    it("rejects invalid repo option", async ({ expect }) => {
      await using tmp = await makePackage();
      await expect(verifyPackageAt(tmp.path, { repo: "not-a-slash" })).rejects.toThrow(TypeError);
    });

    it("default refPattern accepts v-prefixed and bare tag", async ({ expect }) => {
      await using tmpV = await makePackage();
      await expect(verifyPackageAt(tmpV.path, { repo: "owner/repo" })).resolves.toBeDefined();
      await using tmpBare = await makePackage({
        manifest: { sourceRef: "refs/tags/1.2.3" },
      });
      await expect(verifyPackageAt(tmpBare.path, { repo: "owner/repo" })).resolves.toBeDefined();
    });

    it("default refPattern rejects other versions / branches", async ({ expect }) => {
      await using tmpOther = await makePackage({ manifest: { sourceRef: "refs/tags/v1.2.4" } });
      await expect(verifyPackageAt(tmpOther.path, { repo: "owner/repo" })).rejects.toThrow();
    });

    it("escapes regex metachars in default pattern", async ({ expect }) => {
      await using tmp = await makePackage({
        pkg: { version: "1.2.3-rc.1" },
        manifest: { sourceRef: "refs/tags/v1.2.3-rc.1" },
      });
      await expect(verifyPackageAt(tmp.path, { repo: "owner/repo" })).resolves.toBeDefined();
    });

    it("escapes '+' metachar in default pattern", async ({ expect }) => {
      await using tmpOk = await makePackage({
        pkg: { version: "1.2.3+build.1" },
        manifest: { sourceRef: "refs/tags/v1.2.3+build.1" },
      });
      await expect(verifyPackageAt(tmpOk.path, { repo: "owner/repo" })).resolves.toBeDefined();
      // Literal '+' must not act as one-or-more: "1.2.3buildbuild.1" → reject.
      await using tmpBad = await makePackage({
        pkg: { version: "1.2.3+build.1" },
        manifest: { sourceRef: "refs/tags/v1.2.3buildbuild.1" },
      });
      await expect(verifyPackageAt(tmpBad.path, { repo: "owner/repo" })).rejects.toThrow();
    });

    it("explicit refPattern as string matches exactly", async ({ expect }) => {
      await using tmp = await makePackage();
      await expect(
        verifyPackageAt(tmp.path, { repo: "owner/repo", refPattern: "refs/tags/v1.2.3" }),
      ).resolves.toBeDefined();
      await expect(
        verifyPackageAt(tmp.path, { repo: "owner/repo", refPattern: "refs/tags" }),
      ).rejects.toThrow();
    });

    it("rejects wrong $schema in manifest", async ({ expect }) => {
      await using tmp = await makePackage({
        manifest: { $schema: "https://e.com/other.json" as SlsaManifest["$schema"] },
      });
      await expect(verifyPackageAt(tmp.path, { repo: "owner/repo" })).rejects.toThrow();
    });

    it("rejects missing manifest file", async ({ expect }) => {
      await using tmp = await tempDir();
      await writeFile(
        join(tmp.path, "package.json"),
        JSON.stringify({
          name: "x",
          version: "1.0.0",
          addon: { path: "./dist/my.node", manifest: "./slsa-manifest.json" },
        }),
      );
      await expect(verifyPackageAt(tmp.path, { repo: "owner/repo" })).rejects.toThrow(
        /manifest not found/,
      );
    });

    it("verifyAddonBySha256 validates input", async ({ expect }) => {
      await using tmp = await makePackage();
      const p = await verifyPackageAt(tmp.path, { repo: "owner/repo" });
      await expect(p.verifyAddonBySha256("not-hex")).rejects.toThrow(TypeError);
    });
  });

  describe("verifyPackage", () => {
    it("throws when package cannot be resolved", async ({ expect }) => {
      await expect(
        verifyPackage({ packageName: "nonexistent-pkg-xyz", repo: "o/r" }),
      ).rejects.toThrow(/could not resolve/);
    });

    it("resolves packageName via createRequire from process.cwd()", async ({ expect }) => {
      await using tmpRoot = await tempDir();
      const nm = join(tmpRoot.path, "node_modules", "my-pkg");
      await mkdir(nm, { recursive: true });
      await writeFile(
        join(nm, "package.json"),
        JSON.stringify({
          name: "my-pkg",
          version: "1.2.3",
          addon: { path: "./dist/my.node", manifest: "./slsa-manifest.json" },
        }),
      );
      await writeFile(join(nm, "slsa-manifest.json"), JSON.stringify(BASE_MANIFEST));
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpRoot.path);
      try {
        const p = await verifyPackage({ packageName: "my-pkg", repo: "owner/repo" });
        expect(p.sourceRepo).toBe("owner/repo");
      } finally {
        cwdSpy.mockRestore();
      }
    });

    it("resolves packageName from explicit `cwd` without touching process.cwd()", async ({
      expect,
    }) => {
      await using tmpRoot = await tempDir();
      const nm = join(tmpRoot.path, "node_modules", "my-pkg");
      await mkdir(nm, { recursive: true });
      await writeFile(
        join(nm, "package.json"),
        JSON.stringify({
          name: "my-pkg",
          version: "1.2.3",
          addon: { path: "./dist/my.node", manifest: "./slsa-manifest.json" },
        }),
      );
      await writeFile(join(nm, "slsa-manifest.json"), JSON.stringify(BASE_MANIFEST));
      // Point process.cwd() somewhere the package is NOT installed; the
      // explicit `cwd` option must take precedence.
      await using otherCwd = await tempDir();
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(otherCwd.path);
      try {
        const p = await verifyPackage({
          packageName: "my-pkg",
          repo: "owner/repo",
          cwd: tmpRoot.path,
        });
        expect(p.sourceRepo).toBe("owner/repo");
      } finally {
        cwdSpy.mockRestore();
      }
    });
  });

  describe("verifyAttestation with injected RekorClient", () => {
    const okVerifier: BundleVerifier = { verify: () => undefined };

    const baseOpts = {
      sha256: "a".repeat(64),
      repo: "owner/repo",
      runInvocationURI: "https://github.com/owner/repo/actions/runs/1/attempts/1",
      sourceCommit: "a".repeat(40),
      sourceRef: "refs/tags/v1.2.3",
      verifier: okVerifier,
      // Zero ingestion-retry delays so the test runs instantly.
      rekorIngestionRetryDelays: [],
    } as const;

    it("surfaces search=[] as ProvenanceError { kind: rekor-not-found }", async ({ expect }) => {
      const err = await verifyAttestation({
        ...baseOpts,
        rekorClient: {
          search: async () => [],
          fetchEntry: async () => {
            throw new Error("unreachable");
          },
        },
      }).catch((e) => e as unknown);
      expect(err).toBeInstanceOf(ProvenanceError);
      expect((err as ProvenanceError).kind).toBe("rekor-not-found");
    });

    it("retries on rekor-not-found per the configured schedule", async ({ expect }) => {
      let searchCalls = 0;
      const err = await verifyAttestation({
        ...baseOpts,
        rekorIngestionRetryDelays: [1, 1],
        rekorClient: {
          search: async () => {
            searchCalls++;
            return [];
          },
          fetchEntry: async () => {
            throw new Error("unreachable");
          },
        },
      }).catch((e) => e as unknown);
      expect(err).toBeInstanceOf(ProvenanceError);
      expect((err as ProvenanceError).kind).toBe("rekor-not-found");
      // Initial attempt + two retries.
      expect(searchCalls).toBe(3);
    });

    it("does NOT retry when search throws an unavailable RekorError", async ({ expect }) => {
      let calls = 0;
      await verifyAttestation({
        ...baseOpts,
        rekorClient: {
          search: async () => {
            calls++;
            throw new RekorError({ kind: "unavailable", message: "5xx" });
          },
          fetchEntry: async () => {
            throw new Error("unreachable");
          },
        },
      }).catch(() => {});
      expect(calls).toBe(1);
    });
  });

  describe("verifyPackageAt provenance-handle Rekor wiring", () => {
    it("routes verifyAddonBySha256 + verifyAddonFromFile through the injected RekorClient", async ({
      expect,
    }) => {
      await using tmp = await makePackage();
      // Seed a file to verify — contents irrelevant, we assert the fake
      // client observed *a* sha.
      const addonPath = join(tmp.path, "dist", "my.node");
      await mkdir(dirname(addonPath), { recursive: true });
      await writeFile(addonPath, "addon-bytes");

      const searched: string[] = [];
      const p = await verifyPackageAt(tmp.path, {
        repo: "owner/repo",
        verifier: { verify: () => undefined },
        rekorIngestionRetryDelays: [],
        rekorClient: {
          search: async (sha) => {
            searched.push(sha);
            return [];
          },
          fetchEntry: async () => {
            throw new Error("unreachable");
          },
        },
      });
      const provided = "b".repeat(64);
      await p.verifyAddonBySha256(provided).catch(() => {});
      await p.verifyAddonFromFile(addonPath).catch(() => {});
      expect(searched).toHaveLength(2);
      expect(searched[0]).toBe(provided);
      expect(searched[1]).toMatch(/^[0-9a-f]{64}$/);
      expect(searched[1]).not.toBe(provided);
    });
  });
}
