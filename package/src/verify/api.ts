// SPDX-License-Identifier: Apache-2.0 OR MIT

import { createVerifier } from "sigstore";
import dedent from "dedent";

import type { X509Certificate } from "@sigstore/core";

import { runInvocationURI } from "../types.ts";
import type {
  GitHubRepo,
  RunInvocationURI,
  SemVerString,
  Sha256Hex,
  VerifyOptions,
} from "../types.ts";
import { log } from "../util/log.ts";
import { ProvenanceError, isProvenanceError } from "../util/provenance-error.ts";
import { fetchGitHubAttestations, fetchNpmAttestations } from "./attestations.ts";
import { extractCertFromBundle, getExtensionValue, verifyCertificateOIDs } from "./certificates.ts";
import { resolveConfig } from "./config.ts";
import {
  GITHUB_ACTIONS_ISSUER,
  OID_RUN_INVOCATION_URI,
  SLSA_PROVENANCE_PREFIX,
} from "./constants.ts";

/**
 * Returned by {@link verifyPackageProvenance} after npm provenance checks pass.
 *
 * @remarks
 * Captures the Run Invocation URI from the npm provenance certificate.
 * Call {@link PackageProvenance.verifyAddon | verifyAddon} to confirm
 * the addon binary was produced by the same GitHub Actions workflow run.
 */
export interface PackageProvenance {
  readonly runInvocationURI: RunInvocationURI;
  verifyAddon(options: { sha256: Sha256Hex }): Promise<void>;
}

/**
 * Verify npm package provenance via sigstore attestations.
 * Checks the certificate chain, issuer identity, and source repository.
 * Returns a {@link PackageProvenance} handle for addon verification.
 *
 * @throws {@link ProvenanceError} if the package has no SLSA provenance
 *   attestation, the certificate is invalid, or the source repo does not match.
 * @throws `Error` on transient failures (network timeout, API rate limit) —
 *   safe to retry.
 *
 * @example
 * ```typescript
 * import {
 *   verifyPackageProvenance,
 *   semVerString,
 *   githubRepo,
 *   sha256Hex,
 * } from "node-addon-slsa";
 *
 * const provenance = await verifyPackageProvenance({
 *   packageName: "my-native-addon",
 *   version: semVerString("1.0.0"),
 *   repo: githubRepo("owner/repo"),
 * });
 *
 * // Verify the addon binary was produced by the same workflow run.
 * const addonHash = sha256Hex("a".repeat(64)); // SHA-256 of the binary
 * await provenance.verifyAddon({ sha256: addonHash });
 * ```
 */
export async function verifyPackageProvenance(
  options: {
    packageName: string;
    version: SemVerString;
    repo: GitHubRepo;
  } & VerifyOptions,
): Promise<PackageProvenance> {
  const { packageName, version, repo } = options;
  const verifier =
    options.verifier ?? (await createVerifier({ certificateIssuer: GITHUB_ACTIONS_ISSUER }));
  const config = resolveConfig({ ...options, verifier });

  log(`verifying npm package provenance`);
  const attestations = await fetchNpmAttestations({ packageName, version }, config);

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

  // Wrap: verify() may throw synchronously in some sigstore versions
  await Promise.resolve(verifier.verify(provenanceAttestation.bundle));

  const cert = extractCertFromBundle(provenanceAttestation.bundle);
  verifyCertificateOIDs(cert, repo);

  const rawRunURI = getExtensionValue(cert, OID_RUN_INVOCATION_URI);
  log(`run invocation URI: ${rawRunURI}`);

  if (!rawRunURI) {
    throw new ProvenanceError(
      dedent`
        Run Invocation URI not found in npm provenance certificate.
        The certificate may use an unsupported format.
      `,
    );
  }

  let runURI: RunInvocationURI;
  try {
    runURI = runInvocationURI(rawRunURI);
  } catch {
    throw new ProvenanceError(
      dedent`
        Invalid Run Invocation URI in npm provenance certificate: ${rawRunURI}
        Expected a GitHub Actions run URL.
      `,
    );
  }

  return {
    runInvocationURI: runURI,
    verifyAddon: ({ sha256 }: { sha256: Sha256Hex }) =>
      verifyAddonProvenance({ ...options, sha256, runInvocationURI: runURI, verifier }),
  };
}

/**
 * Verify addon binary provenance via the GitHub Attestations API.
 * Confirms the artifact was attested in the expected workflow run
 * and source repository.
 *
 * Typically called via {@link PackageProvenance.verifyAddon | verifyAddon}.
 * Use directly when you already have a {@link RunInvocationURI}.
 *
 * @throws {@link ProvenanceError} if no attestation matches the expected
 *   workflow run, or all attestations fail cryptographic verification.
 * @throws `Error` on transient failures (network timeout, API rate limit) —
 *   safe to retry.
 *
 * @example
 * ```typescript
 * import {
 *   verifyAddonProvenance,
 *   sha256Hex,
 *   githubRepo,
 *   runInvocationURI,
 * } from "node-addon-slsa";
 *
 * await verifyAddonProvenance({
 *   sha256: sha256Hex("a".repeat(64)),
 *   runInvocationURI: runInvocationURI(
 *     "https://github.com/owner/repo/actions/runs/123/attempts/1",
 *   ),
 *   repo: githubRepo("owner/repo"),
 * });
 * ```
 */
export async function verifyAddonProvenance(
  options: {
    sha256: Sha256Hex;
    runInvocationURI: RunInvocationURI;
    repo: GitHubRepo;
  } & VerifyOptions,
): Promise<void> {
  const { sha256, runInvocationURI, repo } = options;
  const config = resolveConfig(options);

  log(`verifying addon provenance`);
  const ghAttestations = await fetchGitHubAttestations({ repo, sha256 }, config);

  const verifier =
    config.verifier ?? (await createVerifier({ certificateIssuer: GITHUB_ACTIONS_ISSUER }));

  let verifyFailures = 0;
  for (const attestation of ghAttestations.attestations) {
    let cert: X509Certificate;
    try {
      // Guard against synchronous throw (see verifyPackageProvenance)
      await Promise.resolve(verifier.verify(attestation.bundle));
      cert = extractCertFromBundle(attestation.bundle);
    } catch (err) {
      if (isProvenanceError(err)) throw err;
      // This bundle failed cryptographic verification; try next.
      verifyFailures++;
      continue;
    }

    const certRunURI = getExtensionValue(cert, OID_RUN_INVOCATION_URI);
    if (certRunURI === runInvocationURI) {
      return verifyCertificateOIDs(cert, repo);
    }
  }

  const total = ghAttestations.attestations.length;
  const detail =
    verifyFailures === total
      ? dedent`
          All ${total} attestation(s) failed cryptographic verification.
          This may indicate a sigstore trust root issue rather than tampering.
        `
      : dedent`
          ${total} attestation(s) found but none matched workflow run ${runInvocationURI}.
          This can happen if the addon was rebuilt without re-attesting,
          or if the npm package and addon were produced by different workflow runs.
        `;
  throw new ProvenanceError(
    dedent`
      Addon provenance verification failed.
      ${detail}
    `,
  );
}
