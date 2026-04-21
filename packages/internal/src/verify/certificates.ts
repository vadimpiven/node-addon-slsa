// SPDX-License-Identifier: Apache-2.0 OR MIT

/** X.509 certificate extraction and OID verification for Fulcio certs. */

import dedent from "dedent";

import type { GitHubRepo, RunInvocationURI } from "../types.ts";
import { ProvenanceError } from "../util/provenance-error.ts";
import {
  GITHUB_ACTIONS_ISSUER,
  OID_BUILD_SIGNER_URI,
  OID_ISSUER_V1,
  OID_ISSUER_V2,
  OID_RUN_INVOCATION_URI,
  OID_SOURCE_REPO_DIGEST,
  OID_SOURCE_REPO_REF,
  OID_SOURCE_REPO_URI,
} from "./constants.ts";

/** Expected values for Fulcio OID extensions in the signing cert. */
export type CertificateOIDExpectations = {
  readonly sourceCommit: string;
  readonly sourceRef: string;
  readonly runInvocationURI: RunInvocationURI;
  readonly attestSignerPattern: RegExp;
};

/**
 * Minimal structural shape used by this module. Satisfied by
 * {@link import("@sigstore/core").X509Certificate}; also allows narrow
 * fixtures without {@link !X509Certificate} escape casts.
 */
export type X509ExtensionReader = {
  extension(oid: string):
    | {
        readonly value: Buffer;
        readonly valueObj: { readonly subs: ReadonlyArray<{ readonly value: Buffer }> };
      }
    | undefined;
};

/**
 * Extract string value from X509 extension.
 * Handles both v1 (raw ASCII) and v2 (DER-encoded UTF8String).
 */
export function getExtensionValue(cert: X509ExtensionReader, oid: string): string | null {
  const ext = cert.extension(oid);
  if (!ext) return null;

  const sub = ext.valueObj.subs?.[0];
  if (sub) {
    return sub.value.toString("utf8");
  }
  return ext.value.toString("ascii");
}

function assertOidEquals(
  cert: X509ExtensionReader,
  oid: string,
  expected: string,
  label: string,
): void {
  const actual = getExtensionValue(cert, oid);
  if (actual !== expected) {
    throw new ProvenanceError(
      dedent`
        ${label} mismatch.
        Expected: ${expected}
        Got: ${actual ?? "<missing>"}
      `,
    );
  }
}

/**
 * Verify Fulcio certificate OIDs (X.509 Object Identifiers) match expected
 * identity. `createVerifier` enforces issuer via policy; we double-check
 * issuer, source repo, commit, ref, run URI, and Build Signer URI manually
 * for defense-in-depth against sigstore library bugs.
 *
 * `attestSignerPattern` is the pin binding attestations to the reusable
 * publish workflow: no workflow outside this toolkit's own `publish.yaml`
 * mints matching certs.
 */
export function verifyCertificateOIDs(
  cert: X509ExtensionReader,
  repo: GitHubRepo,
  expect: CertificateOIDExpectations,
): void {
  const issuer = getExtensionValue(cert, OID_ISSUER_V2) ?? getExtensionValue(cert, OID_ISSUER_V1);
  if (issuer !== GITHUB_ACTIONS_ISSUER) {
    throw new ProvenanceError(
      dedent`
        Certificate issuer mismatch.
        Expected: ${GITHUB_ACTIONS_ISSUER}
        Got: ${issuer ?? "<missing>"}
      `,
    );
  }

  const sourceRepoURI = getExtensionValue(cert, OID_SOURCE_REPO_URI);
  // GitHub treats repository names as case-insensitive.
  const repoURI = `https://github.com/${repo}`;
  if (sourceRepoURI?.toLowerCase() !== repoURI.toLowerCase()) {
    throw new ProvenanceError(
      dedent`
        Source repository mismatch.
        Expected: ${repoURI}
        Got: ${sourceRepoURI ?? "<missing>"}
      `,
    );
  }

  assertOidEquals(cert, OID_SOURCE_REPO_DIGEST, expect.sourceCommit, "Source commit");
  assertOidEquals(cert, OID_SOURCE_REPO_REF, expect.sourceRef, "Source ref");
  assertOidEquals(cert, OID_RUN_INVOCATION_URI, expect.runInvocationURI, "Run invocation URI");

  const signerURI = getExtensionValue(cert, OID_BUILD_SIGNER_URI);
  if (!signerURI || !expect.attestSignerPattern.test(signerURI)) {
    throw new ProvenanceError(
      dedent`
        Build Signer URI does not match the attestation signer pattern.
        Pattern: ${expect.attestSignerPattern.source}
        Got: ${signerURI ?? "<missing>"}
      `,
    );
  }
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;
  const { runInvocationURI } = await import("../types.ts");
  const { DEFAULT_ATTEST_SIGNER_PATTERN } = await import("./constants.ts");

  const SIGNER_BASE =
    "https://github.com/vadimpiven/node-addon-slsa/.github/workflows/publish.yaml";

  const expect_ok = {
    sourceCommit: "a".repeat(40),
    sourceRef: "refs/tags/v1.2.3",
    runInvocationURI: runInvocationURI("https://github.com/owner/repo/actions/runs/1/attempts/1"),
    attestSignerPattern: DEFAULT_ATTEST_SIGNER_PATTERN,
  };

  function mockCert(values: Record<string, string | null>): X509ExtensionReader {
    return {
      extension: (oid: string) => {
        const v = values[oid];
        if (v === undefined || v === null) return undefined;
        return {
          valueObj: { subs: [{ value: Buffer.from(v) }] },
          value: Buffer.from(v),
        };
      },
    };
  }

  const good = {
    [OID_ISSUER_V2]: GITHUB_ACTIONS_ISSUER,
    [OID_SOURCE_REPO_URI]: "https://github.com/owner/repo",
    [OID_SOURCE_REPO_DIGEST]: "a".repeat(40),
    [OID_SOURCE_REPO_REF]: "refs/tags/v1.2.3",
    [OID_RUN_INVOCATION_URI]: "https://github.com/owner/repo/actions/runs/1/attempts/1",
    [OID_BUILD_SIGNER_URI]: `${SIGNER_BASE}@` + "a".repeat(40),
  };

  describe("verifyCertificateOIDs", () => {
    it("accepts a matching cert", ({ expect }) => {
      expect(() => verifyCertificateOIDs(mockCert(good), "owner/repo", expect_ok)).not.toThrow();
    });

    it("rejects wrong sourceCommit", ({ expect }) => {
      const cert = mockCert({ ...good, [OID_SOURCE_REPO_DIGEST]: "b".repeat(40) });
      expect(() => verifyCertificateOIDs(cert, "owner/repo", expect_ok)).toThrow(
        /Source commit mismatch/,
      );
    });

    it("rejects wrong sourceRef", ({ expect }) => {
      const cert = mockCert({ ...good, [OID_SOURCE_REPO_REF]: "refs/tags/v9.9.9" });
      expect(() => verifyCertificateOIDs(cert, "owner/repo", expect_ok)).toThrow(
        /Source ref mismatch/,
      );
    });

    it("rejects wrong runInvocationURI", ({ expect }) => {
      const cert = mockCert({
        ...good,
        [OID_RUN_INVOCATION_URI]: "https://github.com/owner/repo/actions/runs/2/attempts/1",
      });
      expect(() => verifyCertificateOIDs(cert, "owner/repo", expect_ok)).toThrow(
        /Run invocation URI mismatch/,
      );
    });

    it("rejects Build Signer URI from unrelated workflow", ({ expect }) => {
      const cert = mockCert({
        ...good,
        [OID_BUILD_SIGNER_URI]:
          "https://github.com/other/repo/.github/workflows/publish.yaml@" + "a".repeat(40),
      });
      expect(() => verifyCertificateOIDs(cert, "owner/repo", expect_ok)).toThrow(
        /Build Signer URI/,
      );
    });

    it("falls back to v1 issuer when v2 is absent", ({ expect }) => {
      const cert = mockCert({
        ...good,
        [OID_ISSUER_V2]: null,
        [OID_ISSUER_V1]: GITHUB_ACTIONS_ISSUER,
      });
      expect(() => verifyCertificateOIDs(cert, "owner/repo", expect_ok)).not.toThrow();
    });

    it("rejects when issuer missing", ({ expect }) => {
      const cert = mockCert({ ...good, [OID_ISSUER_V2]: null });
      expect(() => verifyCertificateOIDs(cert, "owner/repo", expect_ok)).toThrow(/issuer mismatch/);
    });

    it("rejects wrong issuer", ({ expect }) => {
      const cert = mockCert({ ...good, [OID_ISSUER_V2]: "https://evil.example.com" });
      expect(() => verifyCertificateOIDs(cert, "owner/repo", expect_ok)).toThrow(/issuer mismatch/);
    });

    it("rejects missing source repo URI", ({ expect }) => {
      const cert = mockCert({ ...good, [OID_SOURCE_REPO_URI]: null });
      expect(() => verifyCertificateOIDs(cert, "owner/repo", expect_ok)).toThrow(
        /Source repository mismatch/,
      );
    });

    it("rejects missing Build Signer URI", ({ expect }) => {
      const cert = mockCert({ ...good, [OID_BUILD_SIGNER_URI]: null });
      expect(() => verifyCertificateOIDs(cert, "owner/repo", expect_ok)).toThrow(
        /Build Signer URI/,
      );
    });

    it("getExtensionValue returns null when OID absent", ({ expect }) => {
      const cert = mockCert({});
      expect(getExtensionValue(cert, "1.2.3.4")).toBeNull();
    });

    it("getExtensionValue reads raw ASCII when subs missing (v1 format)", ({ expect }) => {
      const val = "plain-ascii-value";
      const cert: X509ExtensionReader = {
        extension: () => ({ valueObj: { subs: [] }, value: Buffer.from(val) }),
      };
      expect(getExtensionValue(cert, "1.2.3")).toBe(val);
    });

    it("rejects tag-pinned Build Signer URI", ({ expect }) => {
      const cert = mockCert({
        ...good,
        [OID_BUILD_SIGNER_URI]: `${SIGNER_BASE}@refs/tags/v1.2.3`,
      });
      expect(() => verifyCertificateOIDs(cert, "owner/repo", expect_ok)).toThrow(
        /Build Signer URI/,
      );
    });
  });
}
