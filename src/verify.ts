// SPDX-License-Identifier: Apache-2.0 OR MIT

import process from "node:process";

import { bundleFromJSON, bundleToJSON } from "@sigstore/bundle";
import { X509Certificate } from "@sigstore/core";
import { snappyUncompress } from "hysnappy";
import { createVerifier } from "sigstore";
import { z } from "zod/v4";

import type { SerializedBundle } from "@sigstore/bundle";

import dedent from "dedent";

import { fetchWithTimeout } from "./download.ts";
import { ProvenanceError } from "./util/provenance-error.ts";
import { evalTemplate } from "./util/template.ts";

declare const __runInvocationURIBrand: unique symbol;
export type RunInvocationURI = string & {
  readonly [__runInvocationURIBrand]: true;
};

// -- Zod schemas for external HTTP responses --

/** Validate via official sigstore parser and return typed SerializedBundle. */
const BundleSchema = z.looseObject({}).transform((val) => bundleToJSON(bundleFromJSON(val)));

const NpmAttestationsSchema = z.object({
  attestations: z.array(
    z.object({
      predicateType: z.string(),
      bundle: BundleSchema,
    }),
  ),
});

type NpmAttestations = z.infer<typeof NpmAttestationsSchema>;

/** Raw GitHub API response — bundle may be inline or referenced via URL. */
const GitHubAttestationsApiSchema = z.object({
  attestations: z.array(
    z
      .object({
        bundle: z.looseObject({}).nullable(),
        bundle_url: z.url().optional(),
      })
      .refine((attestation) => attestation.bundle != null || attestation.bundle_url != null, {
        message: "attestation has neither bundle nor bundle_url",
      }),
  ),
});

/** Internal type after resolving bundle_url → SerializedBundle. */
type GitHubAttestations = { attestations: { bundle: SerializedBundle }[] };

// Sigstore Fulcio OID extensions
// https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md
const OID_ISSUER_V1 = "1.3.6.1.4.1.57264.1.1";
const OID_ISSUER_V2 = "1.3.6.1.4.1.57264.1.8";
const OID_SOURCE_REPO_URI = "1.3.6.1.4.1.57264.1.12";
const OID_RUN_INVOCATION_URI = "1.3.6.1.4.1.57264.1.21";

const NPM_ATTESTATIONS_URL = "https://registry.npmjs.org/-/npm/v1/attestations/{name}@{version}";
const GITHUB_ATTESTATIONS_URL = "https://api.github.com/repos/{repo}/attestations/sha256:{hash}";
const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
const SLSA_PROVENANCE_PREFIX = "https://slsa.dev/provenance/";

// -- Internal helpers --

let _verifier: Awaited<ReturnType<typeof createVerifier>> | undefined;

async function getVerifier(): ReturnType<typeof createVerifier> {
  _verifier ??= await createVerifier({ certificateIssuer: GITHUB_ACTIONS_ISSUER });
  return _verifier;
}

/**
 * Reads the uncompressed length from the start of a Snappy-compressed block.
 *
 * Snappy prepends the uncompressed length as a little-endian base-128 varint
 * (same encoding as protobuf). Each byte stores 7 data bits in [6:0] and a
 * continuation flag in bit 7. At most 5 bytes (35 bits) are consumed.
 *
 * hysnappy requires this length upfront for WASM memory pre-allocation.
 *
 * @see https://github.com/google/snappy/blob/main/format_description.txt
 * @see https://en.wikipedia.org/wiki/LEB128
 */
function readSnappyUncompressedLength(data: Uint8Array): number {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < Math.min(data.length, 5); i++) {
    const byte = data[i]!;
    result |= (byte & 0x7f) << shift; // accumulate 7 data bits
    if ((byte & 0x80) === 0) return result; // no continuation flag → done
    shift += 7;
  }
  throw new Error("failed to decompress attestation bundle: invalid snappy header");
}

/**
 * Extract string value from X509 extension.
 * Handles both v1 (raw ASCII) and v2 (DER-encoded UTF8String).
 */
function getExtensionValue(cert: X509Certificate, oid: string): string | null {
  const ext = cert.extension(oid);
  if (!ext) return null;

  // v2 extensions (1.3.6.1.4.1.57264.1.8+) are DER-encoded
  // v1 extensions store raw ASCII in the value
  const sub = ext.valueObj.subs?.[0];
  if (sub) {
    return sub.value.toString("utf8");
  }
  return ext.value.toString("ascii");
}

/**
 * Verify certificate OIDs match expected identity.
 * createVerifier enforces issuer via its policy, but we
 * double-check both issuer and source repo manually for
 * defense-in-depth against sigstore library bugs.
 */
function verifyCertificateOIDs(cert: X509Certificate, repo: string): void {
  const issuer = getExtensionValue(cert, OID_ISSUER_V2) ?? getExtensionValue(cert, OID_ISSUER_V1);

  if (issuer !== GITHUB_ACTIONS_ISSUER) {
    throw new ProvenanceError(
      dedent`
        Certificate issuer mismatch.
        Expected: ${GITHUB_ACTIONS_ISSUER}
        Got: ${issuer}
      `,
    );
  }

  const sourceRepoURI = getExtensionValue(cert, OID_SOURCE_REPO_URI);
  const repoURI = `https://github.com/${repo}`;

  if (sourceRepoURI !== repoURI) {
    throw new ProvenanceError(
      dedent`
        Source repository mismatch.
        Expected: ${repoURI}
        Got: ${sourceRepoURI}
      `,
    );
  }
}

/**
 * Extract leaf certificate from a bundle's verification material.
 * Re-parses via bundleFromJSON to access the typed $case
 * discriminated union (BundleSchema already validated the bundle).
 */
function extractCertFromBundle(bundle: SerializedBundle): X509Certificate {
  const parsed = bundleFromJSON(bundle);
  const { content } = parsed.verificationMaterial;

  let certBytes: Buffer | undefined;
  switch (content.$case) {
    case "x509CertificateChain":
      certBytes = content.x509CertificateChain.certificates[0]?.rawBytes;
      break;
    case "certificate":
      certBytes = content.certificate.rawBytes;
      break;
  }

  if (!certBytes) {
    throw new ProvenanceError(
      dedent`
        No certificate found in provenance bundle.
        This may indicate an unsupported sigstore bundle format.
      `,
    );
  }

  return X509Certificate.parse(Buffer.from(certBytes));
}

/**
 * Fetch npm package attestations from registry.
 */
async function fetchNpmAttestations({
  packageName,
  version,
}: {
  packageName: string;
  version: string;
}): Promise<NpmAttestations> {
  const url = evalTemplate(NPM_ATTESTATIONS_URL, {
    name: encodeURIComponent(packageName),
    version: encodeURIComponent(version),
  });
  const response = await fetchWithTimeout(url);
  if (response.status === 404) {
    throw new ProvenanceError(
      dedent`
        No attestation found on npm for ${packageName}@${version}.
        The package may have been published without provenance or tampered with.
      `,
    );
  }
  if (!response.ok) {
    throw new Error(`failed to fetch npm attestations: ${response.status} ${response.statusText}`);
  }
  return NpmAttestationsSchema.parse(await response.json());
}

/**
 * Fetch attestation bundles from the GitHub Attestations API.
 * Returns full sigstore SerializedBundle objects created by
 * actions/attest-build-provenance, suitable for cryptographic
 * verification via createVerifier.
 *
 * Public repos do not require authentication.
 */
async function fetchGitHubAttestations({
  repo,
  sha256,
}: {
  repo: string;
  sha256: string;
}): Promise<GitHubAttestations> {
  const url = evalTemplate(GITHUB_ATTESTATIONS_URL, {
    repo,
    hash: sha256,
  });
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env["GITHUB_TOKEN"];
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const response = await fetchWithTimeout(url, { headers });

  // Rate-limit: 403 with exhausted quota, or 429
  if (
    (response.status === 403 && response.headers.get("X-RateLimit-Remaining") === "0") ||
    response.status === 429
  ) {
    const hint = token ? "rate limit exhausted" : "set GITHUB_TOKEN to increase rate limits";
    throw new Error(`GitHub API rate limit exceeded (${hint})`);
  }

  const noAttestationMsg = dedent`
    No attestation found on GitHub for artifact hash ${sha256}.
    The artifact may have been tampered with.
  `;

  if (response.status === 404) {
    throw new ProvenanceError(noAttestationMsg);
  }
  if (!response.ok) {
    throw new Error(
      `failed to fetch GitHub attestations: ${response.status} ${response.statusText}`,
    );
  }

  const apiResponse = GitHubAttestationsApiSchema.parse(await response.json());

  if (apiResponse.attestations.length === 0) {
    throw new ProvenanceError(noAttestationMsg);
  }

  // Resolve all attestations in parallel: use inline bundle if present,
  // otherwise fetch from bundle_url (Snappy-compressed protobuf-JSON).
  const resolveBundle = async (
    attestation: (typeof apiResponse.attestations)[number],
  ): Promise<SerializedBundle> => {
    if (attestation.bundle) return BundleSchema.parse(attestation.bundle);
    const response = await fetchWithTimeout(attestation.bundle_url!);
    if (!response.ok) {
      throw new Error(
        `failed to fetch attestation bundle from ${attestation.bundle_url}:` +
          ` ${response.status} ${response.statusText}`,
      );
    }
    const compressed = new Uint8Array(await response.arrayBuffer());
    const uncompressedLen = readSnappyUncompressedLength(compressed);
    const decompressed = snappyUncompress(compressed, uncompressedLen);
    const json = new TextDecoder().decode(decompressed);
    return BundleSchema.parse(JSON.parse(json));
  };

  const results = await Promise.allSettled(apiResponse.attestations.map(resolveBundle));
  const resolved: GitHubAttestations = { attestations: [] };
  for (const result of results) {
    if (result.status === "fulfilled") {
      resolved.attestations.push({ bundle: result.value });
    }
  }

  if (resolved.attestations.length === 0) {
    throw new ProvenanceError(noAttestationMsg);
  }

  return resolved;
}

// -- Public API --

/**
 * Verified npm package provenance with a continuation method
 * to verify the associated addon binary.
 */
export interface PackageProvenance {
  readonly runInvocationURI: RunInvocationURI;
  verifyAddon(options: { sha256: string }): Promise<void>;
}

/**
 * Verify npm package provenance: fetch attestations, validate the
 * certificate chain against Fulcio CA, verify identity, and check
 * source repo. Returns a {@link PackageProvenance} object with the
 * Run Invocation URI and a `verifyAddon()` continuation method.
 */
export async function verifyPackageProvenance({
  packageName,
  version,
  repo,
}: {
  packageName: string;
  version: string;
  repo: string;
}): Promise<PackageProvenance> {
  const attestations = await fetchNpmAttestations({ packageName, version });

  const provenanceAttestation = attestations.attestations.find((attestation) =>
    attestation.predicateType.startsWith(SLSA_PROVENANCE_PREFIX),
  );

  if (!provenanceAttestation) {
    throw new ProvenanceError(
      dedent`
        No SLSA provenance attestation found in npm package.
        The package may have been published without provenance or tampered with.
      `,
    );
  }

  const verifier = await getVerifier();
  // Wrap: verify() may throw synchronously in some sigstore versions
  await Promise.resolve(verifier.verify(provenanceAttestation.bundle));

  const cert = extractCertFromBundle(provenanceAttestation.bundle);
  verifyCertificateOIDs(cert, repo);

  const runInvocationURI = getExtensionValue(
    cert,
    OID_RUN_INVOCATION_URI,
  ) as RunInvocationURI | null;

  if (!runInvocationURI) {
    throw new ProvenanceError(
      dedent`
        Run Invocation URI not found in npm provenance certificate.
        The certificate may use an unsupported format.
      `,
    );
  }

  return {
    runInvocationURI,
    verifyAddon: ({ sha256 }: { sha256: string }) =>
      verifyAddonProvenance({ sha256, runInvocationURI, repo }),
  };
}

/**
 * Verify binary provenance: fetch attestation bundles from the
 * GitHub Attestations API for the artifact hash, verify each
 * through createVerifier (Fulcio chain, tlog inclusion proof,
 * SET, signature), and confirm the certificate matches the
 * expected workflow run and source repository.
 */
export async function verifyAddonProvenance({
  sha256,
  runInvocationURI,
  repo,
}: {
  sha256: string;
  runInvocationURI: RunInvocationURI;
  repo: string;
}): Promise<void> {
  const ghAttestations = await fetchGitHubAttestations({ repo, sha256 });

  const verifier = await getVerifier();

  let verifyFailures = 0;
  for (const attestation of ghAttestations.attestations) {
    let cert: X509Certificate;
    try {
      // Wrap: verify() may throw synchronously in some sigstore versions
      await Promise.resolve(verifier.verify(attestation.bundle));
      cert = extractCertFromBundle(attestation.bundle);
    } catch (err) {
      if (err instanceof ProvenanceError) throw err;
      // This bundle failed cryptographic verification; try next.
      verifyFailures++;
      continue;
    }

    const certRunURI = getExtensionValue(cert, OID_RUN_INVOCATION_URI);
    if (certRunURI === runInvocationURI) {
      verifyCertificateOIDs(cert, repo);
      return;
    }
  }

  const total = ghAttestations.attestations.length;
  const detail =
    verifyFailures === total
      ? dedent`
          All ${total} attestation(s) failed cryptographic verification.
          This may indicate a sigstore trust root issue rather than tampering.
        `
      : `${total} attestation(s) found but none matched workflow run ${runInvocationURI}.`;
  throw new ProvenanceError(
    dedent`
      Binary provenance verification failed.
      ${detail}
    `,
  );
}

if (import.meta.vitest) {
  const { FETCH_TIMEOUT_MS } = await import("./download.ts");
  const { describe, it, vi } = import.meta.vitest;
  vi.setConfig({ testTimeout: FETCH_TIMEOUT_MS });

  describe("getExtensionValue", () => {
    it("handles v1 raw ASCII extension format", ({ expect }) => {
      const rawValue = Buffer.from("https://token.actions.githubusercontent.com");
      const mockCert = {
        extension: (oid: string) => {
          if (oid === OID_ISSUER_V1) {
            return { valueObj: {}, value: rawValue };
          }
          return null;
        },
      } as unknown as X509Certificate;
      expect(getExtensionValue(mockCert, OID_ISSUER_V1)).toBe(rawValue.toString("ascii"));
    });
  });

  describe("verifyCertificateOIDs", () => {
    it("accepts correct issuer and source repo", ({ expect }) => {
      const expectedRepo = "owner/repo";
      const mockCert = {
        extension: (oid: string) => {
          if (oid === OID_ISSUER_V2)
            return {
              valueObj: { subs: [{ value: Buffer.from(GITHUB_ACTIONS_ISSUER) }] },
              value: Buffer.from(GITHUB_ACTIONS_ISSUER),
            };
          if (oid === OID_SOURCE_REPO_URI)
            return {
              valueObj: { subs: [{ value: Buffer.from(`https://github.com/${expectedRepo}`) }] },
              value: Buffer.from(`https://github.com/${expectedRepo}`),
            };
          return null;
        },
      } as unknown as X509Certificate;
      expect(() => verifyCertificateOIDs(mockCert, expectedRepo)).not.toThrow();
    });

    it("rejects certificates with wrong issuer", ({ expect }) => {
      const evilIssuer = "https://evil-ca.example.com";
      const mockCert = {
        extension: () => ({
          valueObj: { subs: [{ value: Buffer.from(evilIssuer) }] },
          value: Buffer.from(evilIssuer),
        }),
      } as unknown as X509Certificate;
      expect(() => verifyCertificateOIDs(mockCert, "any/repo")).toThrow(ProvenanceError);
    });

    it("rejects certificates with wrong source repo", ({ expect }) => {
      const wrongRepo = "https://github.com/evil/repo";
      const mockCert = {
        extension: (oid: string) => {
          if (oid === OID_ISSUER_V2)
            return {
              valueObj: { subs: [{ value: Buffer.from(GITHUB_ACTIONS_ISSUER) }] },
              value: Buffer.from(GITHUB_ACTIONS_ISSUER),
            };
          if (oid === OID_SOURCE_REPO_URI)
            return {
              valueObj: { subs: [{ value: Buffer.from(wrongRepo) }] },
              value: Buffer.from(wrongRepo),
            };
          return null;
        },
      } as unknown as X509Certificate;
      expect(() => verifyCertificateOIDs(mockCert, "owner/repo")).toThrow(ProvenanceError);
      expect(() => verifyCertificateOIDs(mockCert, "owner/repo")).toThrow(
        /Source repository mismatch/,
      );
    });
  });

  function stubFetch(impl: typeof fetch): Disposable {
    vi.stubGlobal("fetch", impl);
    return { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  }

  function stubEnvVar(key: string, value: string): Disposable {
    vi.stubEnv(key, value);
    return { [Symbol.dispose]: () => vi.unstubAllEnvs() };
  }

  describe("fetchNpmAttestations", () => {
    it("propagates server error as regular Error (not ProvenanceError)", async ({ expect }) => {
      using _fetch = stubFetch(
        async () => new Response(null, { status: 500, statusText: "Server Error" }),
      );
      await expect(fetchNpmAttestations({ packageName: "pkg", version: "1.0.0" })).rejects.toThrow(
        Error,
      );
      await expect(
        fetchNpmAttestations({ packageName: "pkg", version: "1.0.0" }),
      ).rejects.not.toThrow(ProvenanceError);
    });
  });

  describe("fetchGitHubAttestations", () => {
    it("includes Authorization header when GITHUB_TOKEN is set", async ({ expect }) => {
      let capturedHeaders: Record<string, string> | undefined;
      using _fetch = stubFetch(async (_url, init?: RequestInit) => {
        capturedHeaders = init?.headers as Record<string, string> | undefined;
        return new Response(JSON.stringify({ attestations: [] }), { status: 200 });
      });
      using _env = stubEnvVar("GITHUB_TOKEN", "ghp_test123");
      await fetchGitHubAttestations({ repo: "owner/repo", sha256: "abc123" }).catch(() => {});
      expect(capturedHeaders).toHaveProperty("Authorization", "Bearer ghp_test123");
    });

    it("omits Authorization header when GITHUB_TOKEN is not set", async ({ expect }) => {
      let capturedHeaders: Record<string, string> | undefined;
      using _fetch = stubFetch(async (_url, init?: RequestInit) => {
        capturedHeaders = init?.headers as Record<string, string> | undefined;
        return new Response(JSON.stringify({ attestations: [] }), { status: 200 });
      });
      using _env = stubEnvVar("GITHUB_TOKEN", "");
      await fetchGitHubAttestations({ repo: "owner/repo", sha256: "abc123" }).catch(() => {});
      expect(capturedHeaders).not.toHaveProperty("Authorization");
    });

    it("returns ProvenanceError on 404", async ({ expect }) => {
      using _fetch = stubFetch(
        async () => new Response(null, { status: 404, statusText: "Not Found" }),
      );
      await expect(
        fetchGitHubAttestations({ repo: "owner/repo", sha256: "abc123" }),
      ).rejects.toThrow(ProvenanceError);
      await expect(
        fetchGitHubAttestations({ repo: "owner/repo", sha256: "abc123" }),
      ).rejects.toThrow(/No attestation found/);
    });

    it("propagates server error as regular Error", async ({ expect }) => {
      using _fetch = stubFetch(
        async () => new Response(null, { status: 500, statusText: "Server Error" }),
      );
      await expect(
        fetchGitHubAttestations({ repo: "owner/repo", sha256: "abc123" }),
      ).rejects.toThrow(Error);
      await expect(
        fetchGitHubAttestations({ repo: "owner/repo", sha256: "abc123" }),
      ).rejects.not.toThrow(ProvenanceError);
    });

    it("throws rate-limit error on 403 with X-RateLimit-Remaining: 0", async ({ expect }) => {
      using _fetch = stubFetch(
        async () =>
          new Response(null, {
            status: 403,
            headers: { "X-RateLimit-Remaining": "0" },
          }),
      );
      using _env = stubEnvVar("GITHUB_TOKEN", "ghp_test");
      await expect(
        fetchGitHubAttestations({ repo: "owner/repo", sha256: "abc123" }),
      ).rejects.toThrow(/rate limit exceeded.*exhausted/);
      await expect(
        fetchGitHubAttestations({ repo: "owner/repo", sha256: "abc123" }),
      ).rejects.not.toThrow(ProvenanceError);
    });

    it("throws rate-limit error on 429", async ({ expect }) => {
      using _fetch = stubFetch(async () => new Response(null, { status: 429 }));
      using _env = stubEnvVar("GITHUB_TOKEN", "");
      await expect(
        fetchGitHubAttestations({ repo: "owner/repo", sha256: "abc123" }),
      ).rejects.toThrow(/rate limit exceeded.*GITHUB_TOKEN/);
    });

    it("falls through to generic error on 403 without rate-limit header", async ({ expect }) => {
      using _fetch = stubFetch(
        async () => new Response(null, { status: 403, statusText: "Forbidden" }),
      );
      await expect(
        fetchGitHubAttestations({ repo: "owner/repo", sha256: "abc123" }),
      ).rejects.toThrow(/403/);
      await expect(
        fetchGitHubAttestations({ repo: "owner/repo", sha256: "abc123" }),
      ).rejects.not.toThrow(/rate limit/);
    });

    it("returns ProvenanceError on empty attestation list", async ({ expect }) => {
      using _fetch = stubFetch(
        async () =>
          new Response(JSON.stringify({ attestations: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      await expect(
        fetchGitHubAttestations({ repo: "owner/repo", sha256: "abc123" }),
      ).rejects.toThrow(ProvenanceError);
      await expect(
        fetchGitHubAttestations({ repo: "owner/repo", sha256: "abc123" }),
      ).rejects.toThrow(/No attestation found/);
    });

    it("returns ProvenanceError when all bundle_url fetches fail", async ({ expect }) => {
      using _fetch = stubFetch(async (url: string | URL | Request) => {
        const urlString = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (new URL(urlString).hostname === "api.github.com") {
          return new Response(
            JSON.stringify({
              attestations: [{ bundle: null, bundle_url: "https://blob.example.com/b" }],
            }),
            { status: 200 },
          );
        }
        return new Response(null, { status: 500, statusText: "Server Error" });
      });
      await expect(
        fetchGitHubAttestations({ repo: "owner/repo", sha256: "abc123" }),
      ).rejects.toThrow(ProvenanceError);
      await expect(
        fetchGitHubAttestations({ repo: "owner/repo", sha256: "abc123" }),
      ).rejects.toThrow(/No attestation found/);
    });
  });

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
          sha256: "0000000000000000000000000000000000000000000000000000000000000000",
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
  const CLI_HASH = "7c6d3b5ac88c897fb3ac0c8a479f4fb8083bd05a758fb8d3275642a93d20570d";
  const CLI_REPO = "cli/cli";
  const CLI_RUN_URI =
    "https://github.com/cli/cli/actions/runs/22312430014/attempts/4" as RunInvocationURI;

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
      const wrongRunURI =
        "https://github.com/cli/cli/actions/runs/1/attempts/1" as RunInvocationURI;
      await expect(
        verifyAddonProvenance({
          sha256: CLI_HASH,
          runInvocationURI: wrongRunURI,
          repo: CLI_REPO,
        }),
      ).rejects.toThrow(ProvenanceError);
    });
  });

  describe("readSnappyUncompressedLength", () => {
    it("parses single-byte varint", ({ expect }) => {
      expect(readSnappyUncompressedLength(new Uint8Array([0x0a]))).toBe(10);
    });

    it("parses multi-byte varint", ({ expect }) => {
      // 300 = 0b100101100 → varint bytes: 0xAC 0x02
      expect(readSnappyUncompressedLength(new Uint8Array([0xac, 0x02]))).toBe(300);
    });

    it("throws on truncated varint", ({ expect }) => {
      // 5 continuation bytes with no termination
      expect(() =>
        readSnappyUncompressedLength(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80])),
      ).toThrow("invalid snappy header");
    });
  });
}
