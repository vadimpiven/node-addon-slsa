// SPDX-License-Identifier: Apache-2.0 OR MIT

/** URLs, OIDs, and defaults for verification endpoints. */

// Sigstore Fulcio OID extensions
// https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md
export const OID_ISSUER_V1 = "1.3.6.1.4.1.57264.1.1"; // Issuer (v1)
export const OID_ISSUER_V2 = "1.3.6.1.4.1.57264.1.8"; // Issuer (v2)
export const OID_SOURCE_REPO_URI = "1.3.6.1.4.1.57264.1.12"; // Source Repository URI
export const OID_RUN_INVOCATION_URI = "1.3.6.1.4.1.57264.1.21"; // Run Invocation URI

export const NPM_ATTESTATIONS_URL =
  "https://registry.npmjs.org/-/npm/v1/attestations/{name}@{version}";
export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
export const SLSA_PROVENANCE_PREFIX = "https://slsa.dev/provenance/";

/** Upper bound for JSON API responses (npm registry, Rekor). */
export const MAX_JSON_RESPONSE_BYTES = 50 * 1024 * 1024; // 50 MB

export const REKOR_SEARCH_URL = "https://rekor.sigstore.dev/api/v1/index/retrieve";
export const REKOR_ENTRY_URL = "https://rekor.sigstore.dev/api/v1/log/entries/{uuid}";

/** Max Rekor entries to check per artifact hash. */
export const MAX_REKOR_ENTRIES = 10;

/** Shared advice appended to Rekor network errors. */
export const REKOR_NETWORK_ADVICE =
  "Check your network connection and try again.\n" +
  "If this persists, check https://status.sigstore.dev for outages.";
