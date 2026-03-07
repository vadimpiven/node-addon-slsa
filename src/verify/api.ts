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
 * Handle returned after npm package provenance verification succeeds.
 * Call {@link verifyAddon} to complete addon-level verification.
 */
export interface PackageProvenance {
  readonly runInvocationURI: RunInvocationURI;
  verifyAddon(options: { sha256: Sha256Hex }): Promise<void>;
}

/**
 * Verify npm package provenance: fetch attestations, validate the
 * certificate chain against Fulcio CA, verify identity, and check
 * source repo. Returns a {@link PackageProvenance} object with the
 * Run Invocation URI and a `verifyAddon()` continuation method.
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
 * Verify addon provenance: fetch attestation bundles from the
 * GitHub Attestations API for the artifact hash, verify each
 * through createVerifier (Fulcio chain, tlog inclusion proof,
 * SET, signature), and confirm the certificate matches the
 * expected workflow run and source repository.
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
