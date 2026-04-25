// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Shared test fixtures: synthetic `node-reqwest` package.json, matching
 * SLSA manifest, and a fake-binary buffer. Used by the commands / loader
 * / bin test suites to avoid repeating the same setup.
 */

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";

import { SLSA_MANIFEST_V1_SCHEMA_URL } from "@node-addon-slsa/internal";

export const FAKE_BINARY = Buffer.from("fake native addon binary content");

export const FAKE_URL =
  "https://github.com/vadimpiven/node_reqwest/releases/download/v1.0.0/node_reqwest.node.gz";

/** package.json written to test fixtures. `repository` is extracted by wget. */
export type TestPackageJson = {
  readonly name: string;
  readonly version: string;
  readonly addon: {
    readonly path: string;
    readonly manifest: string;
    readonly attestWorkflow: string;
  };
  readonly repository: { readonly url: string };
};

export function testPkg(version: string): TestPackageJson {
  return {
    name: "node-reqwest",
    version,
    addon: {
      path: "./dist/node_reqwest.node",
      manifest: "./slsa-manifest.json",
      attestWorkflow: "release.yaml",
    },
    repository: { url: "git+https://github.com/vadimpiven/node_reqwest.git" },
  };
}

export async function writeTestPkg(dir: string, version: string): Promise<void> {
  await writeFile(join(dir, "package.json"), JSON.stringify(testPkg(version)));
}

/** Manifest matching the test package; binary sha256 is of the gzipped payload. */
export function testManifest(version: string, gzBytes: Buffer): unknown {
  const sha256 = createHash("sha256").update(gzBytes).digest("hex");
  const platform = process.platform;
  const arch = process.arch;
  return {
    $schema: SLSA_MANIFEST_V1_SCHEMA_URL,
    packageName: "node-reqwest",
    runInvocationURI: "https://github.com/vadimpiven/node_reqwest/actions/runs/1/attempts/1",
    sourceRepo: "vadimpiven/node_reqwest",
    sourceCommit: "a".repeat(40),
    sourceRef: `refs/tags/v${version}`,
    addons: {
      [platform]: {
        [arch]: { url: FAKE_URL, bundleUrl: `${FAKE_URL}.sigstore`, sha256 },
      },
    },
  };
}

export async function writeTestManifest(dir: string, version: string): Promise<Buffer> {
  const gz = gzipSync(FAKE_BINARY);
  await writeFile(join(dir, "slsa-manifest.json"), JSON.stringify(testManifest(version, gz)));
  return gz;
}
