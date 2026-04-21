// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Sidecar-bundle verification: fetch a sigstore Bundle from its distribution
 * URL, cryptographically verify it via `@sigstore/verify` (TUF-backed trust,
 * Rekor inclusion proof carried inside the bundle), bind the envelope's
 * in-toto Statement subject to the expected artifact sha256, and pin the
 * Fulcio cert's OIDs to the expected workflow identity.
 *
 * Why a sidecar, not Rekor's REST API: Rekor's `dsse` pluggable type stores
 * only envelope/payload hashes (PR #1487 in sigstore/rekor, explicit
 * design). The full DSSE envelope never comes back from
 * `GET /api/v1/log/entries/{uuid}` — it must live somewhere durable that the
 * publisher controls. GitHub's Attestations API is such a store, but it
 * requires auth for private repos; the sidecar at `<addon-url>.sigstore`
 * inherits the same auth model as the binary (always reachable by consumers
 * who can fetch the binary itself), which removes any install-time token
 * requirement.
 */

import type { SerializedBundle } from "@sigstore/bundle";
import { X509Certificate } from "@sigstore/core";

import type { HttpClient } from "../http.ts";
import type { BundleVerifier, GitHubRepo, Sha256Hex } from "../types.ts";
import { readJsonBounded } from "../util/json.ts";
import { log } from "../util/log.ts";
import { ProvenanceError } from "../util/provenance-error.ts";
import { verifyCertificateOIDs, type CertificateOIDExpectations } from "./certificates.ts";
import { MAX_JSON_RESPONSE_BYTES } from "./constants.ts";
import { InTotoStatementSchema } from "./schemas.ts";

/**
 * Decode and validate the DSSE envelope payload from a sigstore bundle,
 * and enforce that the in-toto Statement attests the artifact we hashed.
 * Without this binding, a bundle that correctly signs a different
 * artifact's Statement would still pass cryptographic verification.
 */
function bindSubjectDigest(bundle: SerializedBundle, expectedSha256: Sha256Hex): void {
  const dsse = bundle.dsseEnvelope;
  if (!dsse) {
    throw new ProvenanceError(
      "Bundle is missing dsseEnvelope; only DSSE-kind bundles are supported.",
    );
  }
  const payloadJson = JSON.parse(Buffer.from(dsse.payload, "base64").toString("utf8"));
  const statement = InTotoStatementSchema.parse(payloadJson);
  const want = expectedSha256.toLowerCase();
  if (!statement.subject.some((s) => s.digest.sha256.toLowerCase() === want)) {
    const seen = statement.subject.map((s) => s.digest.sha256).join(", ");
    throw new ProvenanceError(
      `Bundle's in-toto Statement does not attest the requested artifact: ` +
        `want=${want} subject.digest.sha256=[${seen}]`,
    );
  }
}

/**
 * Read the Fulcio cert out of a bundle's verification material. Per the
 * v0.3 bundle format, `certificate.rawBytes` is base64 DER.
 */
function certFromBundle(bundle: SerializedBundle): X509Certificate {
  const rawBytes = bundle.verificationMaterial.certificate?.rawBytes;
  if (!rawBytes) {
    throw new ProvenanceError(
      "Bundle is missing verificationMaterial.certificate.rawBytes; " +
        "public-good Sigstore uses Fulcio-issued short-lived certs.",
    );
  }
  // X509Certificate.parse accepts DER bytes or PEM string; we hand it DER.
  return X509Certificate.parse(Buffer.from(rawBytes, "base64"));
}

/** Fetch a bundle JSON from its sidecar URL. */
export async function fetchBundle(http: HttpClient, url: string): Promise<SerializedBundle> {
  log(`fetching bundle ${url}`);
  const result = await http.request(url);
  const parsed = await readJsonBounded(result.body, MAX_JSON_RESPONSE_BYTES);
  // Trust `@sigstore/verify`'s own schema enforcement via `bundleFromJSON` /
  // `Verifier.verify`; a bad shape surfaces there with a precise error.
  return parsed as SerializedBundle;
}

/**
 * Verify an addon's sidecar sigstore bundle end-to-end: fetch, subject-bind,
 * cryptographic verify, OID pin. All four must pass; any failure throws
 * `ProvenanceError`. Returns on success.
 */
export async function verifyAddonBundle(options: {
  readonly sha256: Sha256Hex;
  readonly bundleUrl: string;
  readonly repo: GitHubRepo;
  readonly expect: CertificateOIDExpectations;
  readonly http: HttpClient;
  readonly verifier: BundleVerifier;
}): Promise<void> {
  const { sha256, bundleUrl, repo, expect, http, verifier } = options;

  const bundle = await fetchBundle(http, bundleUrl);
  bindSubjectDigest(bundle, sha256);
  verifier.verify(bundle);
  const cert = certFromBundle(bundle);
  verifyCertificateOIDs(cert, repo, expect);
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { sha256Hex, runInvocationURI, sourceRef, sourceCommitSha } = await import("../types.ts");
  const { DEFAULT_ATTEST_SIGNER_PATTERN } = await import("./constants.ts");

  /** In-memory HttpClient that returns canned bytes for a URL. */
  const { Readable } = await import("node:stream");
  function fakeHttp(url: string, body: Buffer): HttpClient {
    return {
      async request(requested) {
        if (requested !== url) throw new Error(`unexpected URL: ${requested}`);
        return {
          status: 200,
          headers: { "content-length": String(body.length), "content-type": "application/json" },
          body: Readable.from([body]) as never,
        };
      },
    };
  }

  /** Stub verifier that skips sigstore chain (TUF, Rekor inclusion proof). */
  const passVerifier: BundleVerifier = { verify: () => {} };

  const FIXTURE_PATH = join(
    new URL(".", import.meta.url).pathname,
    "..",
    "..",
    "tests",
    "fixtures",
    "node-reqwest-v0.0.27.bundle.json",
  );

  describe("verifyAddonBundle (against a real published bundle)", () => {
    it("passes for a subject present in the Statement (linux-x64)", async () => {
      const bundleBytes = await readFile(FIXTURE_PATH);
      const http = fakeHttp("https://example.invalid/bundle.sigstore", bundleBytes);

      await verifyAddonBundle({
        sha256: sha256Hex("217358cf5d7c23c687cd39ec9ff50c760374fffcd338aaceb5b2a290e0a304e5"),
        bundleUrl: "https://example.invalid/bundle.sigstore",
        repo: "vadimpiven/node_reqwest" as GitHubRepo,
        expect: {
          sourceCommit: sourceCommitSha("7492facdbdb163499e82c8b0f0cbcca0dd4f3a20"),
          sourceRef: sourceRef("refs/tags/v0.0.27"),
          runInvocationURI: runInvocationURI(
            "https://github.com/vadimpiven/node_reqwest/actions/runs/24739695502/attempts/1",
          ),
          attestSignerPattern: DEFAULT_ATTEST_SIGNER_PATTERN,
        },
        http,
        verifier: passVerifier,
      });
    });

    it("rejects when the requested sha256 is not among the Statement subjects", async ({
      expect,
    }) => {
      const bundleBytes = await readFile(FIXTURE_PATH);
      const http = fakeHttp("https://example.invalid/bundle.sigstore", bundleBytes);

      await expect(
        verifyAddonBundle({
          sha256: sha256Hex("0".repeat(64)),
          bundleUrl: "https://example.invalid/bundle.sigstore",
          repo: "vadimpiven/node_reqwest" as GitHubRepo,
          expect: {
            sourceCommit: sourceCommitSha("7492facdbdb163499e82c8b0f0cbcca0dd4f3a20"),
            sourceRef: sourceRef("refs/tags/v0.0.27"),
            runInvocationURI: runInvocationURI(
              "https://github.com/vadimpiven/node_reqwest/actions/runs/24739695502/attempts/1",
            ),
            attestSignerPattern: DEFAULT_ATTEST_SIGNER_PATTERN,
          },
          http,
          verifier: passVerifier,
        }),
      ).rejects.toThrow(/does not attest the requested artifact/);
    });

    it("rejects when the cert's SourceCommit OID doesn't match the manifest's expectation", async ({
      expect,
    }) => {
      const bundleBytes = await readFile(FIXTURE_PATH);
      const http = fakeHttp("https://example.invalid/bundle.sigstore", bundleBytes);

      await expect(
        verifyAddonBundle({
          sha256: sha256Hex("217358cf5d7c23c687cd39ec9ff50c760374fffcd338aaceb5b2a290e0a304e5"),
          bundleUrl: "https://example.invalid/bundle.sigstore",
          repo: "vadimpiven/node_reqwest" as GitHubRepo,
          expect: {
            sourceCommit: sourceCommitSha("0".repeat(40)),
            sourceRef: sourceRef("refs/tags/v0.0.27"),
            runInvocationURI: runInvocationURI(
              "https://github.com/vadimpiven/node_reqwest/actions/runs/24739695502/attempts/1",
            ),
            attestSignerPattern: DEFAULT_ATTEST_SIGNER_PATTERN,
          },
          http,
          verifier: passVerifier,
        }),
      ).rejects.toThrow(/Source commit mismatch/);
    });
  });
}
