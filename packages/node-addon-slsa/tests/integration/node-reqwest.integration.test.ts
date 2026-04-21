// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Live integration test against a real published package-with-addon.
 *
 * Target: `node-reqwest@0.0.18`, published from
 * `vadimpiven/node_reqwest` via its own release workflow. The prebuilt
 * `.node.gz` assets live as GitHub release artifacts; sigstore Fulcio
 * certs for them are indexed in the public Rekor log.
 *
 * Run with `SLSA_LIVE_INTEGRATION=1`. Skipped by default: talks to
 * `github.com`, `rekor.sigstore.dev`, and the sigstore TUF CDN, so it
 * isn't deterministic enough for ordinary CI.
 *
 * This test currently asserts *fail-closed* behavior against a release
 * produced by a workflow other than this toolkit's own `publish.yaml`.
 * The Build Signer URI OID pin (`DEFAULT_ATTEST_SIGNER_PATTERN`) refuses
 * any cert whose `job_workflow_ref` doesn't point at vadimpiven's
 * reusable workflow at a 40-hex commit SHA, so verification correctly
 * rejects a package that wasn't published via this toolkit. When a
 * compatible test package is published, flip the assertion to `resolves`.
 */

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Agent, fetch as undiciFetch } from "undici";
import { describe, it } from "vitest";

import {
  ProvenanceError,
  tempDir,
  verifyAttestation,
  verifyPackageAt,
} from "@node-addon-slsa/internal";

const LIVE = process.env["SLSA_LIVE_INTEGRATION"] === "1";

// Pinned target. Re-derive via:
//   gh release view v0.0.18 -R vadimpiven/node_reqwest --json assets
//   gh api /repos/vadimpiven/node_reqwest/git/refs/tags/v0.0.18
//   gh api "/repos/vadimpiven/node_reqwest/actions/runs?head_sha=<tag-sha>"
const TARGET = {
  repo: "vadimpiven/node_reqwest",
  packageName: "node-reqwest",
  version: "0.0.18",
  sourceRef: "refs/tags/v0.0.18",
  sourceCommit: "129dbc1c2abf7f293e85e2a53bb44624aa0784b5",
  runInvocationURI:
    "https://github.com/vadimpiven/node_reqwest/actions/runs/22809456834/attempts/1",
  // Smallest asset — keeps the test quick.
  addon: {
    url: "https://github.com/vadimpiven/node_reqwest/releases/download/v0.0.18/node_reqwest-v0.0.18-darwin-arm64.node.gz",
    expectedSha256: "4fb5429caf78a8300ee4344bd263889fe6cda8678b000bd1b1639ba4a5b944e2",
    platform: "darwin",
    arch: "arm64",
  },
} as const;

/**
 * Download with a scoped `Agent` so connection pools close when we're done.
 * The global dispatcher would hold sockets open past the test and trip
 * `detectAsyncLeaks`.
 */
async function downloadAndHash(url: string, signal: AbortSignal): Promise<string> {
  const agent = new Agent({ keepAliveTimeout: 1, keepAliveMaxTimeout: 1 });
  try {
    const res = await undiciFetch(url, { redirect: "follow", signal, dispatcher: agent });
    if (!res.ok) {
      throw new Error(`download ${url} failed: HTTP ${res.status}`);
    }
    const hash = createHash("sha256");
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error(`download ${url}: empty body`);
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
    }
    return hash.digest("hex");
  } finally {
    await agent.close();
  }
}

describe.skipIf(!LIVE)("node-reqwest@0.0.18 live integration", () => {
  it("verifyAttestation: completes the Rekor + Fulcio chain against a real binary", async ({
    expect,
  }) => {
    const ac = new AbortController();
    const sha256 = await downloadAndHash(TARGET.addon.url, ac.signal);
    expect(sha256).toBe(TARGET.addon.expectedSha256);

    await expect(
      verifyAttestation({
        sha256,
        repo: TARGET.repo,
        runInvocationURI: TARGET.runInvocationURI,
        sourceCommit: TARGET.sourceCommit,
        sourceRef: TARGET.sourceRef,
        signal: ac.signal,
      }),
    ).rejects.toThrow(ProvenanceError);
  }, 60_000);

  it("verifyPackageAt: refuses a synthesized manifest pointing at incompatible attestations", async ({
    expect,
  }) => {
    await using tmp = await tempDir("slsa-integ-");

    const sha256 = await downloadAndHash(TARGET.addon.url, AbortSignal.timeout(60_000));
    expect(sha256).toBe(TARGET.addon.expectedSha256);

    await writeFile(
      join(tmp.path, "package.json"),
      JSON.stringify({
        name: TARGET.packageName,
        version: TARGET.version,
        addon: { path: "./dist/node_reqwest.node" },
      }),
    );
    await writeFile(
      join(tmp.path, "slsa-manifest.json"),
      JSON.stringify({
        $schema: "https://vadimpiven.github.io/node-addon-slsa/schema/slsa-manifest.v1.json",
        packageName: TARGET.packageName,
        runInvocationURI: TARGET.runInvocationURI,
        sourceRepo: TARGET.repo,
        sourceCommit: TARGET.sourceCommit,
        sourceRef: TARGET.sourceRef,
        addons: {
          [TARGET.addon.platform]: {
            [TARGET.addon.arch]: { url: TARGET.addon.url, sha256 },
          },
        },
      }),
    );

    const provenance = await verifyPackageAt(tmp.path, {
      repo: TARGET.repo,
    });
    await expect(provenance.verifyAddonBySha256(sha256)).rejects.toThrow(ProvenanceError);
  }, 60_000);
});
