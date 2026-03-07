// SPDX-License-Identifier: Apache-2.0 OR MIT

// Sigstore Fulcio OID extensions
// https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md
export const OID_ISSUER_V1 = "1.3.6.1.4.1.57264.1.1"; // Issuer (v1)
export const OID_ISSUER_V2 = "1.3.6.1.4.1.57264.1.8"; // Issuer (v2)
export const OID_SOURCE_REPO_URI = "1.3.6.1.4.1.57264.1.12"; // Source Repository URI
export const OID_RUN_INVOCATION_URI = "1.3.6.1.4.1.57264.1.21"; // Run Invocation URI

export const NPM_ATTESTATIONS_URL =
  "https://registry.npmjs.org/-/npm/v1/attestations/{name}@{version}";
export const GITHUB_ATTESTATIONS_URL =
  "https://api.github.com/repos/{repo}/attestations/sha256:{hash}";
export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
export const SLSA_PROVENANCE_PREFIX = "https://slsa.dev/provenance/";

/** Upper bound for attestation bundle size (compressed or uncompressed). */
export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024; // 50 MB

/** Upper bound for JSON API responses (npm registry, GitHub API). */
export const MAX_JSON_RESPONSE_BYTES = 50 * 1024 * 1024; // 50 MB

/** Max concurrent bundle_url fetches to avoid connection storms. */
export const RESOLVE_CONCURRENCY = 5;
