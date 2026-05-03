// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Exports `verifyAddonBundle` (fetch + verify) and `verifyBundleSerialized`
 * (verify in-memory) — the subject-bind + sigstore-chain + Fulcio-OID-pin
 * pipeline shared by the CLI install path and the publish-side verifier.
 *
 * Sidecar bundle, not Rekor REST: Rekor's `dsse` type stores only payload
 * hashes (sigstore/rekor#1487), so the full DSSE envelope must live with
 * the artifact. The `<addon-url>.sigstore` sidecar inherits the binary's
 * auth model — no install-time token required.
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
import { InTotoStatementSchema } from "./intoto.ts";

// Without this binding, a bundle correctly signing a *different* artifact's
// Statement would still pass cryptographic verification.
function bindSubjectDigest(bundle: SerializedBundle, expectedSha256: Sha256Hex): void {
  const dsse = bundle.dsseEnvelope;
  if (!dsse) {
    throw new ProvenanceError(
      "Bundle is missing dsseEnvelope; only DSSE-kind bundles are supported. " +
        "public-good sigstore via @actions/attest produces DSSE bundles; " +
        "this bundle was minted differently.",
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

// Bundle v0.3: `certificate.rawBytes` is base64 DER.
function certFromBundle(bundle: SerializedBundle): X509Certificate {
  const rawBytes = bundle.verificationMaterial.certificate?.rawBytes;
  if (!rawBytes) {
    throw new ProvenanceError(
      "Bundle is missing verificationMaterial.certificate.rawBytes; " +
        "public-good sigstore via @actions/attest issues a Fulcio short-lived " +
        "cert and embeds it here — this bundle was minted differently.",
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

/** Options for {@link verifyBundleSerialized}. */
export type VerifyBundleSerializedOptions = {
  readonly sha256: Sha256Hex;
  readonly bundle: SerializedBundle;
  readonly repo: GitHubRepo;
  readonly expect: CertificateOIDExpectations;
  readonly verifier: BundleVerifier;
};

/** Subject-bind, cryptographic verify, OID pin — for an in-memory bundle. */
export function verifyBundleSerialized(options: VerifyBundleSerializedOptions): void {
  const { sha256, bundle, repo, expect, verifier } = options;
  bindSubjectDigest(bundle, sha256);
  verifier.verify(bundle);
  const cert = certFromBundle(bundle);
  verifyCertificateOIDs(cert, { repo, expect });
}

/** Options for {@link verifyAddonBundle}. */
export type VerifyAddonBundleOptions = {
  readonly sha256: Sha256Hex;
  readonly bundleUrl: string;
  readonly repo: GitHubRepo;
  readonly expect: CertificateOIDExpectations;
  readonly http: HttpClient;
  readonly verifier: BundleVerifier;
};

/** Fetch, subject-bind, cryptographic verify, OID pin — for a sidecar URL. */
export async function verifyAddonBundle(options: VerifyAddonBundleOptions): Promise<void> {
  const { sha256, bundleUrl, repo, expect, http, verifier } = options;
  const bundle = await fetchBundle(http, bundleUrl);
  verifyBundleSerialized({ sha256, bundle, repo, expect, verifier });
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { sha256Hex, runInvocationURI, sourceRef, sourceCommitSha } = await import("../types.ts");
  const { buildAttestSignerPattern } = await import("./constants.ts");
  // The real published fixture was minted by the pre-v0.10 centralized
  // publish workflow, so its Build Signer URI points at node-addon-slsa's
  // own publish.yaml — match that here so fixture assertions stay real.
  const attestSignerPattern = buildAttestSignerPattern({
    repo: "vadimpiven/node-addon-slsa",
    workflow: "publish.yaml",
  });

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
          attestSignerPattern,
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
            attestSignerPattern,
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
            attestSignerPattern,
          },
          http,
          verifier: passVerifier,
        }),
      ).rejects.toThrow(/Source commit mismatch/);
    });
  });
}
