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

/** 256 MiB. Same default on the publish side (`verify-addons`) and consumer side (`slsa wget`). */
export const DEFAULT_MAX_BINARY_BYTES = 256 * 1024 * 1024;

/** Default per-binary fetch timeout, seconds. Applied as undici headersTimeout + bodyTimeout. */
export const DEFAULT_MAX_BINARY_SECONDS = 300;

/** Upper bound for JSON responses (sigstore bundles ~a few KB; cap generously). */
export const MAX_JSON_RESPONSE_BYTES = 50 * 1024 * 1024;

/** GitHub release assets (and most CDNs) take a few seconds to propagate after upload. */
export const BUNDLE_FETCH_RETRY_DELAYS: readonly number[] = [2_000, 5_000, 10_000, 15_000];

/** Escape regex metacharacters so a literal string matches exactly inside a pattern. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Options for {@link buildAttestSignerPattern}. */
export type BuildAttestSignerPatternOptions = {
  /** "owner/repo" */
  readonly repo: string;
  /** Workflow filename, e.g. "release.yaml". No path segments allowed. */
  readonly workflow: string;
};

/**
 * Fulcio Build Signer URI pin (OID 1.3.6.1.4.1.57264.1.9). Tag and branch
 * refs are rejected — only `@<40-hex>` SHA pins, because tags are mutable
 * and could mint attestations passing a looser pin after retagging.
 */
export function buildAttestSignerPattern(opts: BuildAttestSignerPatternOptions): RegExp {
  if (opts.workflow.includes("/") || opts.workflow.includes("\\")) {
    throw new TypeError(`attest workflow must be a bare filename: ${opts.workflow}`);
  }
  const base = `https://github.com/${opts.repo}/.github/workflows/${opts.workflow}`;
  return new RegExp(`^${escapeRegExp(base)}@[0-9a-f]{40}$`);
}

// Single trust anchor for every package published with this toolkit:
// consumers SHA-pin `attest-addon.yaml` via `uses:`, and the Fulcio
// Build Signer URI resolves to that workflow regardless of caller.
const TOOLKIT_REPO = "vadimpiven/node-addon-slsa";
const ATTEST_WORKFLOW_FILENAME = "attest-addon.yaml";

/**
 * Build the toolkit's reusable-workflow Build Signer URI pin —
 * `attest-addon.yaml` in `vadimpiven/node-addon-slsa`, SHA-anchored.
 * This is the default trust anchor when no custom `attestSignerPattern` is set.
 */
export function buildToolkitAttestSignerPattern(): RegExp {
  return buildAttestSignerPattern({ repo: TOOLKIT_REPO, workflow: ATTEST_WORKFLOW_FILENAME });
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

  describe("buildAttestSignerPattern", () => {
    const pattern = buildAttestSignerPattern({ repo: "owner/repo", workflow: "release.yaml" });
    const base = "https://github.com/owner/repo/.github/workflows/release.yaml";

    it("accepts a SHA-pinned reusable workflow URI", ({ expect }) => {
      expect(pattern.test(`${base}@${"a".repeat(40)}`)).toBe(true);
    });

    it("rejects values missing the https://github.com/ prefix", ({ expect }) => {
      // Regression: Fulcio emits the wrapped URI, not the raw claim.
      const uri = `owner/repo/.github/workflows/release.yaml@${"a".repeat(40)}`;
      expect(pattern.test(uri)).toBe(false);
    });

    it("rejects tag-pinned URIs", ({ expect }) => {
      expect(pattern.test(`${base}@refs/tags/v1.2.3`)).toBe(false);
    });

    it("rejects branch-pinned URIs", ({ expect }) => {
      expect(pattern.test(`${base}@refs/heads/main`)).toBe(false);
    });

    it("rejects URIs from unrelated workflows", ({ expect }) => {
      const uri = `https://github.com/other/repo/.github/workflows/release.yaml@${"a".repeat(40)}`;
      expect(pattern.test(uri)).toBe(false);
    });

    it("rejects a different workflow filename in the same repo", ({ expect }) => {
      const uri = `https://github.com/owner/repo/.github/workflows/evil.yaml@${"a".repeat(40)}`;
      expect(pattern.test(uri)).toBe(false);
    });

    it("rejects short hex", ({ expect }) => {
      expect(pattern.test(`${base}@${"a".repeat(20)}`)).toBe(false);
    });

    it("rejects workflow with path separator", ({ expect }) => {
      expect(() =>
        buildAttestSignerPattern({ repo: "owner/repo", workflow: "../evil.yaml" }),
      ).toThrow(TypeError);
    });
  });
}
