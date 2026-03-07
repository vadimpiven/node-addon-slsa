// SPDX-License-Identifier: Apache-2.0 OR MIT

import { bundleFromJSON } from "@sigstore/bundle";
import { X509Certificate } from "@sigstore/core";
import dedent from "dedent";

import type { SerializedBundle } from "@sigstore/bundle";

import type { GitHubRepo } from "../types.ts";
import { ProvenanceError } from "../util/provenance-error.ts";
import {
  GITHUB_ACTIONS_ISSUER,
  OID_ISSUER_V1,
  OID_ISSUER_V2,
  OID_SOURCE_REPO_URI,
} from "./constants.ts";

/**
 * Extract string value from X509 extension.
 * Handles both v1 (raw ASCII) and v2 (DER-encoded UTF8String).
 */
export function getExtensionValue(cert: X509Certificate, oid: string): string | null {
  const ext = cert.extension(oid);
  if (!ext) return null;

  const sub = ext.valueObj.subs?.[0];
  if (sub) {
    return sub.value.toString("utf8");
  }
  return ext.value.toString("ascii");
}

/**
 * Verify Fulcio certificate OIDs (X.509 Object Identifiers)
 * match expected identity. createVerifier enforces issuer via
 * its policy, but we double-check both issuer and source repo
 * manually for defense-in-depth against sigstore library bugs.
 */
export function verifyCertificateOIDs(cert: X509Certificate, repo: GitHubRepo): void {
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
  // GitHub treats repository names as case-insensitive
  const repoURI = `https://github.com/${repo}`;

  if (sourceRepoURI?.toLowerCase() !== repoURI.toLowerCase()) {
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
export function extractCertFromBundle(bundle: SerializedBundle): X509Certificate {
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
        Report this issue to the package maintainer.
      `,
    );
  }

  return X509Certificate.parse(Buffer.from(certBytes));
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

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

  describe("getExtensionValue (null)", () => {
    it("returns null when extension OID is absent", ({ expect }) => {
      const mockCert = {
        extension: () => null,
      } as unknown as X509Certificate;
      expect(getExtensionValue(mockCert, "1.2.3.4")).toBeNull();
    });
  });

  describe("verifyCertificateOIDs", () => {
    it("falls back to V1 issuer OID when V2 is absent", ({ expect }) => {
      const expectedRepo = "owner/repo";
      const mockCert = {
        extension: (oid: string) => {
          if (oid === OID_ISSUER_V2) return null;
          if (oid === OID_ISSUER_V1)
            return {
              valueObj: {},
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
}
