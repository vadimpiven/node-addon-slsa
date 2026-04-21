// SPDX-License-Identifier: Apache-2.0 OR MIT

/** URLs, OIDs, and defaults for verification endpoints. */

import { BRAND_PUBLISH_WORKFLOW_PATH, BRAND_REPO } from "./brand.ts";

// Sigstore Fulcio OID extensions — https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md

/** Fulcio OID for the v1 OIDC token issuer. */
export const OID_ISSUER_V1 = "1.3.6.1.4.1.57264.1.1";
/** Fulcio OID for the v2 OIDC token issuer. */
export const OID_ISSUER_V2 = "1.3.6.1.4.1.57264.1.8";
/** Fulcio OID for the Build Signer URI (job_workflow_ref). */
export const OID_BUILD_SIGNER_URI = "1.3.6.1.4.1.57264.1.9";
/** Fulcio OID for the source repository URI. */
export const OID_SOURCE_REPO_URI = "1.3.6.1.4.1.57264.1.12";
/** Fulcio OID for the source repository digest (commit sha). */
export const OID_SOURCE_REPO_DIGEST = "1.3.6.1.4.1.57264.1.13";
/** Fulcio OID for the source repository ref (e.g. refs/tags/v1.2.3). */
export const OID_SOURCE_REPO_REF = "1.3.6.1.4.1.57264.1.14";
/** Fulcio OID for the CI run invocation URI. */
export const OID_RUN_INVOCATION_URI = "1.3.6.1.4.1.57264.1.21";

/** Expected OIDC issuer for GitHub Actions identity tokens. */
export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";

/** Default manifest path inside the published tarball; overridden by `addon.manifest`. */
export const DEFAULT_MANIFEST_PATH = "slsa-manifest.json";

/**
 * Default per-binary download cap (256 MiB). Shared by the publish-side
 * `verify-addons` action and the consumer-side `slsa wget` / `requireAddon`
 * flow so both ends enforce the same bound unless explicitly overridden.
 */
export const DEFAULT_MAX_BINARY_BYTES = 256 * 1024 * 1024;

/** Default per-binary fetch timeout, seconds. Applied as undici headersTimeout + bodyTimeout. */
export const DEFAULT_MAX_BINARY_SECONDS = 300;

/** Upper bound for JSON API responses (Rekor). */
export const MAX_JSON_RESPONSE_BYTES = 50 * 1024 * 1024;

/** Rekor search-by-hash endpoint. */
export const REKOR_SEARCH_URL = "https://rekor.sigstore.dev/api/v1/index/retrieve";
/** Rekor get-entry endpoint template; `{uuid}` expands to the entry UUID. */
export const REKOR_ENTRY_URL = "https://rekor.sigstore.dev/api/v1/log/entries/{uuid}";

/**
 * Retry delays (ms) for Rekor ingestion lag. Newly-published attestations
 * take ~30s to appear in Rekor's index; the publish-side self-verify in
 * `verify-addons` retries through this schedule before giving up.
 */
export const REKOR_INGESTION_RETRY_DELAYS: readonly number[] = [2_000, 5_000, 10_000, 15_000];

/**
 * Max Rekor entries to check per artifact hash. Rekor's index is append-only;
 * any GitHub actor with `id-token: write` can submit an attestation for an
 * arbitrary sha256. An attacker flooding the log with entries for a legit
 * hash could push the legit entry out of a too-small newest-N window.
 *
 * 100 matches Rekor's default pagination page size and tolerates 99 attacker
 * entries per release before verification degrades from "rejected flooder,
 * found legit" to "all visible entries rejected" (still fail-closed — no
 * bypass — but the error becomes less diagnostic).
 */
export const MAX_REKOR_ENTRIES = 100;

/** Shared advice appended to Rekor network errors. */
export const REKOR_NETWORK_ADVICE =
  "Check your network connection and try again.\n" +
  "If this persists, check https://status.sigstore.dev for outages.";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** URI scheme Fulcio prepends to `job_workflow_ref` in the Build Signer URI extension. */
const GITHUB_URI_PREFIX = "https://github.com/";

/**
 * SHA-only pin for Fulcio cert's Build Signer URI. Tags are mutable; a
 * retagged `publish.yaml` could mint attestations passing a tag-based pin.
 * GitHub populates `job_workflow_ref` with the literal ref from the
 * caller's `uses:` line, so a SHA-pinned `uses:` produces `@<40-hex>`.
 * Fulcio wraps that claim into an `https://github.com/…` URI in OID
 * 1.3.6.1.4.1.57264.1.9 — the pin anchors on that exact shape.
 * Override via {@link VerifyPackageOptions.attestSignerPattern} only to
 * verify a package produced by a different fork's publish workflow.
 */
export const DEFAULT_ATTEST_SIGNER_PATTERN = new RegExp(
  `^${escapeRegExp(`${GITHUB_URI_PREFIX}${BRAND_REPO}/${BRAND_PUBLISH_WORKFLOW_PATH}`)}@` +
    String.raw`[0-9a-f]{40}$`,
);

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

  const BASE = `${GITHUB_URI_PREFIX}${BRAND_REPO}/${BRAND_PUBLISH_WORKFLOW_PATH}`;

  describe("DEFAULT_ATTEST_SIGNER_PATTERN", () => {
    it("derives its prefix from BRAND_REPO/BRAND_PUBLISH_WORKFLOW_PATH", ({ expect }) => {
      // Pins the "forks only edit brand.ts" invariant: a drift where someone
      // inlines a hard-coded owner/repo would fail this round-trip check.
      const uri = `${BASE}@${"a".repeat(40)}`;
      expect(DEFAULT_ATTEST_SIGNER_PATTERN.test(uri)).toBe(true);
      const evil = `${GITHUB_URI_PREFIX}evil/fork/${BRAND_PUBLISH_WORKFLOW_PATH}@${"a".repeat(40)}`;
      expect(DEFAULT_ATTEST_SIGNER_PATTERN.test(evil)).toBe(false);
    });

    it("accepts SHA-pinned reusable workflow URI", ({ expect }) => {
      const uri = `${BASE}@${"a".repeat(40)}`;
      expect(DEFAULT_ATTEST_SIGNER_PATTERN.test(uri)).toBe(true);
    });

    it("rejects values missing the https://github.com/ prefix", ({ expect }) => {
      // Regression: Fulcio emits the wrapped URI, not the raw claim.
      const uri = `${BRAND_REPO}/${BRAND_PUBLISH_WORKFLOW_PATH}@${"a".repeat(40)}`;
      expect(DEFAULT_ATTEST_SIGNER_PATTERN.test(uri)).toBe(false);
    });

    it("rejects tag-pinned URIs", ({ expect }) => {
      const uri = `${BASE}@refs/tags/v1.2.3`;
      expect(DEFAULT_ATTEST_SIGNER_PATTERN.test(uri)).toBe(false);
    });

    it("rejects branch-pinned URIs", ({ expect }) => {
      const uri = `${BASE}@refs/heads/main`;
      expect(DEFAULT_ATTEST_SIGNER_PATTERN.test(uri)).toBe(false);
    });

    it("rejects URIs from unrelated workflows", ({ expect }) => {
      const uri = `${GITHUB_URI_PREFIX}other/repo/.github/workflows/publish.yaml@${"a".repeat(40)}`;
      expect(DEFAULT_ATTEST_SIGNER_PATTERN.test(uri)).toBe(false);
    });

    it("rejects short hex", ({ expect }) => {
      const uri = `${BASE}@${"a".repeat(20)}`;
      expect(DEFAULT_ATTEST_SIGNER_PATTERN.test(uri)).toBe(false);
    });
  });
}
