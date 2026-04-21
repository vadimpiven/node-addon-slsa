// SPDX-License-Identifier: Apache-2.0 OR MIT

/** URLs, OIDs, and defaults for verification endpoints. */

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

/** Upper bound for JSON responses (sigstore bundles ~a few KB; cap generously). */
export const MAX_JSON_RESPONSE_BYTES = 50 * 1024 * 1024;

/**
 * Retry delays (ms) for sidecar bundle 404s — GitHub release assets (and
 * most CDNs) take a few seconds to propagate after upload, so the
 * publish-side self-verify in `verify-addons` retries through this schedule
 * before giving up.
 */
export const BUNDLE_FETCH_RETRY_DELAYS: readonly number[] = [2_000, 5_000, 10_000, 15_000];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * SHA-only pin for Fulcio cert's Build Signer URI (OID 1.3.6.1.4.1.57264.1.9).
 * Tags are mutable; a retagged `publish.yaml` could mint attestations
 * passing a tag-based pin. GitHub populates `job_workflow_ref` with the
 * literal ref from the caller's `uses:` line, so a SHA-pinned `uses:`
 * produces `@<40-hex>`. Fulcio wraps that claim into the `https://github.com/…`
 * URI form in the extension; the pin anchors on that exact shape.
 */
const SIGNER_BASE = "https://github.com/vadimpiven/node-addon-slsa/.github/workflows/publish.yaml";
export const DEFAULT_ATTEST_SIGNER_PATTERN = new RegExp(
  `^${escapeRegExp(SIGNER_BASE)}@` + String.raw`[0-9a-f]{40}$`,
);

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

  describe("DEFAULT_ATTEST_SIGNER_PATTERN", () => {
    it("accepts the SHA-pinned reusable workflow URI that Fulcio emits", ({ expect }) => {
      const uri = `${SIGNER_BASE}@${"a".repeat(40)}`;
      expect(DEFAULT_ATTEST_SIGNER_PATTERN.test(uri)).toBe(true);
    });

    it("rejects values missing the https://github.com/ prefix", ({ expect }) => {
      // Regression: Fulcio emits the wrapped URI, not the raw claim.
      const uri = `vadimpiven/node-addon-slsa/.github/workflows/publish.yaml@${"a".repeat(40)}`;
      expect(DEFAULT_ATTEST_SIGNER_PATTERN.test(uri)).toBe(false);
    });

    it("rejects tag-pinned URIs", ({ expect }) => {
      expect(DEFAULT_ATTEST_SIGNER_PATTERN.test(`${SIGNER_BASE}@refs/tags/v1.2.3`)).toBe(false);
    });

    it("rejects branch-pinned URIs", ({ expect }) => {
      expect(DEFAULT_ATTEST_SIGNER_PATTERN.test(`${SIGNER_BASE}@refs/heads/main`)).toBe(false);
    });

    it("rejects URIs from unrelated workflows", ({ expect }) => {
      const uri = `https://github.com/other/repo/.github/workflows/publish.yaml@${"a".repeat(40)}`;
      expect(DEFAULT_ATTEST_SIGNER_PATTERN.test(uri)).toBe(false);
    });

    it("rejects short hex", ({ expect }) => {
      expect(DEFAULT_ATTEST_SIGNER_PATTERN.test(`${SIGNER_BASE}@${"a".repeat(20)}`)).toBe(false);
    });
  });
}
