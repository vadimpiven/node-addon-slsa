// SPDX-License-Identifier: Apache-2.0 OR MIT

import process from "node:process";

import { bundleFromJSON, bundleToJSON } from "@sigstore/bundle";
import { X509Certificate } from "@sigstore/core";
import { createVerifier } from "sigstore";
import { z } from "zod/v4";

import type { SerializedBundle } from "@sigstore/bundle";

import dedent from "dedent";

import { fetchWithTimeout } from "./download.ts";
import { SecurityError } from "./util/security-error.ts";
import { evalTemplate } from "./util/template.ts";

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

const GitHubAttestationsSchema = z.object({
  attestations: z.array(
    z.object({
      bundle: BundleSchema,
    }),
  ),
});

type GitHubAttestations = z.infer<typeof GitHubAttestationsSchema>;

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
function verifyCertificateOIDs(cert: X509Certificate, expectedRepo: string): void {
  const issuer = getExtensionValue(cert, OID_ISSUER_V2) ?? getExtensionValue(cert, OID_ISSUER_V1);

  if (issuer !== GITHUB_ACTIONS_ISSUER) {
    throw new SecurityError(
      dedent`
        Certificate issuer mismatch.
        Expected: ${GITHUB_ACTIONS_ISSUER}
        Got: ${issuer}
      `,
    );
  }

  const sourceRepoURI = getExtensionValue(cert, OID_SOURCE_REPO_URI);
  const expectedRepoURI = `https://github.com/${expectedRepo}`;

  if (sourceRepoURI !== expectedRepoURI) {
    throw new SecurityError(
      dedent`
        Source repository mismatch.
        Expected: ${expectedRepoURI}
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
    throw new SecurityError(
      dedent`
        No certificate found in provenance bundle.
        Provenance verification cannot proceed.
      `,
    );
  }

  return X509Certificate.parse(Buffer.from(certBytes));
}

/**
 * Fetch npm package attestations from registry.
 */
async function fetchNpmAttestations(
  packageName: string,
  version: string,
): Promise<NpmAttestations> {
  const url = evalTemplate(NPM_ATTESTATIONS_URL, {
    name: encodeURIComponent(packageName),
    version: encodeURIComponent(version),
  });
  const response = await fetchWithTimeout(url);
  if (response.status === 404) {
    throw new SecurityError(
      dedent`
        No attestation found on npm for ${packageName}@${version}.
        The package may have been published without provenance or tampered with.
      `,
    );
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch npm attestations: ${response.status} ${response.statusText}`);
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
async function fetchGitHubAttestations(
  expectedRepo: string,
  sha256Hash: string,
): Promise<GitHubAttestations> {
  const url = evalTemplate(GITHUB_ATTESTATIONS_URL, {
    repo: expectedRepo,
    hash: sha256Hash,
  });
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env["GITHUB_TOKEN"];
  if (token) {
    headers["Authorization"] = `token ${token}`;
  }
  const response = await fetchWithTimeout(url, { headers });

  const noAttestationMsg = dedent`
    No attestation found on GitHub for artifact hash ${sha256Hash}.
    The artifact may have been tampered with.
  `;

  if (response.status === 404) {
    throw new SecurityError(noAttestationMsg);
  }
  if (!response.ok) {
    throw new Error(
      `Failed to fetch GitHub attestations: ${response.status} ${response.statusText}`,
    );
  }

  const parsed = GitHubAttestationsSchema.parse(await response.json());

  if (parsed.attestations.length === 0) {
    throw new SecurityError(noAttestationMsg);
  }

  return parsed;
}

// -- Public API --

/**
 * Verify npm package provenance: fetch attestations, validate the
 * certificate chain against Fulcio CA, verify identity, and check
 * source repo. Returns the Run Invocation URI that identifies the
 * workflow run that built the npm package.
 */
export async function verifyNpmProvenance(
  packageName: string,
  version: string,
  expectedRepo: string,
): Promise<string> {
  const attestations = await fetchNpmAttestations(packageName, version);

  const provenanceAttestation = attestations.attestations.find((a) =>
    a.predicateType.startsWith(SLSA_PROVENANCE_PREFIX),
  );

  if (!provenanceAttestation) {
    throw new SecurityError(
      dedent`
        No SLSA provenance attestation found in npm package.
        The package may have been published without provenance or tampered with.
      `,
    );
  }

  const verifier = await getVerifier();
  verifier.verify(provenanceAttestation.bundle);

  const cert = extractCertFromBundle(provenanceAttestation.bundle);
  verifyCertificateOIDs(cert, expectedRepo);

  const runInvocationURI = getExtensionValue(cert, OID_RUN_INVOCATION_URI);

  if (!runInvocationURI) {
    throw new SecurityError(
      dedent`
        Run Invocation URI not found in npm provenance certificate.
        Provenance verification cannot proceed.
      `,
    );
  }

  return runInvocationURI;
}

/**
 * Verify binary provenance: fetch attestation bundles from the
 * GitHub Attestations API for the artifact hash, verify each
 * through createVerifier (Fulcio chain, tlog inclusion proof,
 * SET, signature), and confirm the certificate matches the
 * expected workflow run and source repository.
 */
export async function verifyBinaryProvenance(
  artifactHash: string,
  expectedRunInvocationURI: string,
  expectedRepo: string,
): Promise<void> {
  const ghAttestations = await fetchGitHubAttestations(expectedRepo, artifactHash);

  const verifier = await getVerifier();

  let verifyFailures = 0;
  for (const attestation of ghAttestations.attestations) {
    let cert: X509Certificate;
    try {
      // Wrap: verify() may throw synchronously in some sigstore versions
      await Promise.resolve(verifier.verify(attestation.bundle));
      cert = extractCertFromBundle(attestation.bundle);
    } catch (err) {
      if (err instanceof SecurityError) throw err;
      // This bundle failed cryptographic verification; try next.
      verifyFailures++;
      continue;
    }

    const runURI = getExtensionValue(cert, OID_RUN_INVOCATION_URI);
    if (runURI === expectedRunInvocationURI) {
      verifyCertificateOIDs(cert, expectedRepo);
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
      : `${total} attestation(s) found but none matched workflow run ${expectedRunInvocationURI}.`;
  throw new SecurityError(
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
      expect(() => verifyCertificateOIDs(mockCert, "any/repo")).toThrow(SecurityError);
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
      expect(() => verifyCertificateOIDs(mockCert, "owner/repo")).toThrow(SecurityError);
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
    it("propagates server error as regular Error (not SecurityError)", async ({ expect }) => {
      using _fetch = stubFetch(
        async () => new Response(null, { status: 500, statusText: "Server Error" }),
      );
      await expect(fetchNpmAttestations("pkg", "1.0.0")).rejects.toThrow(Error);
      await expect(fetchNpmAttestations("pkg", "1.0.0")).rejects.not.toThrow(SecurityError);
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
      await fetchGitHubAttestations("owner/repo", "abc123").catch(() => {});
      expect(capturedHeaders).toHaveProperty("Authorization", "token ghp_test123");
    });

    it("omits Authorization header when GITHUB_TOKEN is not set", async ({ expect }) => {
      let capturedHeaders: Record<string, string> | undefined;
      using _fetch = stubFetch(async (_url, init?: RequestInit) => {
        capturedHeaders = init?.headers as Record<string, string> | undefined;
        return new Response(JSON.stringify({ attestations: [] }), { status: 200 });
      });
      using _env = stubEnvVar("GITHUB_TOKEN", "");
      await fetchGitHubAttestations("owner/repo", "abc123").catch(() => {});
      expect(capturedHeaders).not.toHaveProperty("Authorization");
    });

    it("returns SecurityError on 404", async ({ expect }) => {
      using _fetch = stubFetch(
        async () => new Response(null, { status: 404, statusText: "Not Found" }),
      );
      await expect(fetchGitHubAttestations("owner/repo", "abc123")).rejects.toThrow(SecurityError);
      await expect(fetchGitHubAttestations("owner/repo", "abc123")).rejects.toThrow(
        /No attestation found/,
      );
    });

    it("propagates server error as regular Error", async ({ expect }) => {
      using _fetch = stubFetch(
        async () => new Response(null, { status: 500, statusText: "Server Error" }),
      );
      await expect(fetchGitHubAttestations("owner/repo", "abc123")).rejects.toThrow(Error);
      await expect(fetchGitHubAttestations("owner/repo", "abc123")).rejects.not.toThrow(
        SecurityError,
      );
    });

    it("returns SecurityError on empty attestation list", async ({ expect }) => {
      using _fetch = stubFetch(
        async () =>
          new Response(JSON.stringify({ attestations: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      await expect(fetchGitHubAttestations("owner/repo", "abc123")).rejects.toThrow(SecurityError);
      await expect(fetchGitHubAttestations("owner/repo", "abc123")).rejects.toThrow(
        /No attestation found/,
      );
    });
  });

  describe("verifyNpmProvenance (integration)", () => {
    it("succeeds for unscoped package", async ({ expect }) => {
      const runURI = await verifyNpmProvenance("semver", "7.6.3", "npm/node-semver");
      expect(runURI).toMatch(/^https:\/\/github\.com\/npm\/node-semver\/actions\/runs\//);
    });

    it("succeeds for scoped package", async ({ expect }) => {
      const runURI = await verifyNpmProvenance("@npmcli/run-script", "9.0.2", "npm/run-script");
      expect(runURI).toMatch(/^https:\/\/github\.com\/npm\/run-script\/actions\/runs\//);
    });

    it("succeeds for bundle v0.3 format", async ({ expect }) => {
      // undici@7.3.0 uses Sigstore bundle v0.3 with top-level
      // `certificate` instead of `x509CertificateChain`
      const runURI = await verifyNpmProvenance("undici", "7.3.0", "nodejs/undici");
      expect(runURI).toMatch(/^https:\/\/github\.com\/nodejs\/undici\/actions\/runs\//);
    });

    it("rejects when expected repo does not match", async ({ expect }) => {
      await expect(verifyNpmProvenance("semver", "7.6.3", "wrong/repo")).rejects.toThrow(
        "SECURITY",
      );
    });

    it("rejects for a package without provenance", async ({ expect }) => {
      await expect(verifyNpmProvenance("express", "4.21.2", "expressjs/express")).rejects.toThrow();
    });
  });
}
