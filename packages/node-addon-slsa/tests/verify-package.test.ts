// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Asserts that `verifyPackage` / `verifyPackageAt` walk the full pipeline
 * down to the sidecar bundle fetch. A `BundleVerifier` stub is injected
 * via `VerifyOptions.verifier` to skip the sigstore crypto chain (no
 * TUF round-trip, no real Fulcio cert); assertions key on the bundle
 * URL the MockAgent observed — which proves the hash / URL derivation
 * flowed through correctly.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { afterEach, beforeEach, describe, it } from "vitest";

import {
  SLSA_MANIFEST_V1_SCHEMA_URL,
  tempDir,
  verifyPackage,
  verifyPackageAt,
  type BundleVerifier,
} from "@node-addon-slsa/internal";

/**
 * Noop verifier: skips the sigstore chain, so tests don't depend on real
 * TUF trust material, Fulcio certs, or Rekor witnesses. The cert-OID check
 * in `verifyCertificateOIDs` still runs against whatever cert the fetched
 * bundle carries.
 */
const passVerifier: BundleVerifier = { verify: () => undefined };

const ADDON_URL = "https://cdn.example.com/v1.0.0/my.node.gz";
const BUNDLE_URL = "https://cdn.example.com/v1.0.0/my.node.gz.sigstore";
const ADDON_SHA = "b".repeat(64);

const BASE_MANIFEST = {
  $schema: SLSA_MANIFEST_V1_SCHEMA_URL,
  packageName: "my-pkg",
  runInvocationURI: "https://github.com/owner/repo/actions/runs/1/attempts/1",
  sourceRepo: "owner/repo",
  sourceCommit: "a".repeat(40),
  sourceRef: "refs/tags/v1.2.3",
  addons: {
    linux: { x64: { url: ADDON_URL, bundleUrl: BUNDLE_URL, sha256: ADDON_SHA } },
  },
} as const;

async function makePackage(): Promise<{ path: string } & AsyncDisposable> {
  const tmp = await tempDir();
  await writeFile(
    join(tmp.path, "package.json"),
    JSON.stringify({
      name: "my-pkg",
      version: "1.2.3",
      addon: {
        path: "./dist/my.node",
        manifest: "./slsa-manifest.json",
        attestWorkflow: "release.yaml",
      },
    }),
  );
  await writeFile(join(tmp.path, "slsa-manifest.json"), JSON.stringify(BASE_MANIFEST));
  return tmp;
}

let previousDispatcher: Dispatcher;
let agent: MockAgent;

beforeEach(() => {
  previousDispatcher = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  await agent.close();
  setGlobalDispatcher(previousDispatcher);
});

function interceptBundle(bundleJson: string): void {
  // Intercept the bundle sidecar GET. The handler returns the canned bundle
  // bytes; `verifyAddonBundle` will subject-bind, call the pass-verifier,
  // then run the real Fulcio OID check — which will fail against fabricated
  // bundle data, giving us a predictable ProvenanceError to assert on.
  agent
    .get("https://cdn.example.com")
    .intercept({ path: /\/my\.node\.gz\.sigstore$/ })
    .reply(200, bundleJson, { headers: { "content-type": "application/json" } });
}

function minimalBundleForSha(sha: string): string {
  // Fabricated bundle shape: enough to pass the subject-digest binding
  // (InTotoStatementSchema + our `bindSubjectDigest`); the pass-verifier
  // skips sigstore crypto; the Fulcio cert OID check then fails because
  // the cert is synthetic — that's the expected terminal ProvenanceError.
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "addon", digest: { sha256: sha } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {},
  };
  const envelope = {
    payloadType: "application/vnd.in-toto+json",
    payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
    signatures: [{ sig: Buffer.from("fake").toString("base64"), keyid: "" }],
  };
  const bundle = {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    dsseEnvelope: envelope,
    verificationMaterial: {
      // Missing certificate → certFromBundle throws. That's the assertion
      // surface: the pipeline reached verify, tried to read the cert, and
      // surfaced a clear error — which proves end-to-end wiring.
      certificate: undefined,
    },
  };
  return JSON.stringify(bundle);
}

describe("verifyPackageAt → PackageProvenance addon handle", () => {
  it("verifyAddonBySha256 fetches the sidecar bundle at the manifest's bundleUrl", async ({
    expect,
  }) => {
    interceptBundle(minimalBundleForSha(ADDON_SHA));
    await using tmp = await makePackage();
    const p = await verifyPackageAt(tmp.path, {
      repo: "owner/repo",
      verifier: passVerifier,
      dispatcher: agent,
    });
    // Expects a ProvenanceError because our fabricated bundle has no cert,
    // but reaching that error proves the sha → bundleUrl → fetch path.
    await expect(p.verifyAddonBySha256(ADDON_SHA)).rejects.toThrow(
      /Bundle is missing verificationMaterial/,
    );
  });

  it("verifyAddonBySha256 rejects an sha not present in the manifest", async ({ expect }) => {
    await using tmp = await makePackage();
    const p = await verifyPackageAt(tmp.path, {
      repo: "owner/repo",
      verifier: passVerifier,
      dispatcher: agent,
    });
    await expect(p.verifyAddonBySha256("c".repeat(64))).rejects.toThrow(/not found in manifest/);
  });

  it("verifyAddonFromFile hashes the file and finds the entry by sha", async ({ expect }) => {
    await using tmp = await makePackage();
    const fakeBinary = join(tmp.path, "fake.gz");
    await mkdir(join(tmp.path, "dist"), { recursive: true });
    await writeFile(fakeBinary, Buffer.from("arbitrary-bytes"));
    const p = await verifyPackageAt(tmp.path, {
      repo: "owner/repo",
      verifier: passVerifier,
      dispatcher: agent,
    });
    // sha of "arbitrary-bytes" is not the manifest's declared sha256 → caught
    // by `findAddonEntryBySha`, proving the hash-first path runs.
    await expect(p.verifyAddonFromFile(fakeBinary)).rejects.toThrow(/not found in manifest/);
  });
});

describe("verifyPackage (top-level)", () => {
  it("resolves packageName via createRequire from cwd, then walks the full flow", async ({
    expect,
  }) => {
    interceptBundle(minimalBundleForSha(ADDON_SHA));
    await using tmpRoot = await tempDir();
    const nm = join(tmpRoot.path, "node_modules", "my-pkg");
    await mkdir(nm, { recursive: true });
    await writeFile(
      join(nm, "package.json"),
      JSON.stringify({
        name: "my-pkg",
        version: "1.2.3",
        addon: {
          path: "./dist/my.node",
          manifest: "./slsa-manifest.json",
          attestWorkflow: "release.yaml",
        },
      }),
    );
    await writeFile(join(nm, "slsa-manifest.json"), JSON.stringify(BASE_MANIFEST));
    const p = await verifyPackage({
      packageName: "my-pkg",
      repo: "owner/repo",
      cwd: tmpRoot.path,
      verifier: passVerifier,
      dispatcher: agent,
    });
    await expect(p.verifyAddonBySha256(ADDON_SHA)).rejects.toThrow(
      /Bundle is missing verificationMaterial/,
    );
  });
});
