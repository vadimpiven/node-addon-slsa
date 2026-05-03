// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Manifest reading + addon-entry lookup. Used by `verifyPackageAt` to
 * resolve a hashed binary back to its manifest entry.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import dedent from "dedent";

import { errorMessage } from "../util/error.ts";
import { assertWithinDir } from "../util/fs.ts";
import { ProvenanceError } from "../util/provenance-error.ts";
import type { AddonEntry } from "./descriptor.ts";
import { SlsaManifestSchemaV1, type SlsaManifest } from "./manifest.ts";

export async function readManifest(
  packageRoot: string,
  manifestRel: string,
): Promise<SlsaManifest> {
  const resolvedRoot = resolve(packageRoot);
  const manifestAbs = resolve(resolvedRoot, manifestRel);
  assertWithinDir({ baseDir: resolvedRoot, target: manifestAbs, label: "addon.manifest" });
  let raw: string;
  try {
    raw = await readFile(manifestAbs, "utf8");
  } catch {
    throw new ProvenanceError(dedent`
      manifest not found at ${manifestRel}.
      The package was not published with node-addon-slsa, or the
      "addon.manifest" field in package.json points to a missing file.
    `);
  }
  try {
    return SlsaManifestSchemaV1.parse(JSON.parse(raw));
  } catch (err) {
    throw new ProvenanceError(dedent`
      manifest at ${manifestRel} failed schema validation.
      ${errorMessage(err)}
    `);
  }
}

/** Locate the manifest addon entry whose sha256 matches the hashed binary. */
export function findAddonEntryBySha(manifest: SlsaManifest, sha256: string): AddonEntry {
  for (const byArch of Object.values(manifest.addons)) {
    for (const entry of Object.values(byArch ?? {})) {
      if (entry && entry.sha256.toLowerCase() === sha256.toLowerCase()) {
        return entry;
      }
    }
  }
  throw new ProvenanceError(
    `sha256 ${sha256} not found in manifest's addon inventory — the binary does not match any declared addon.`,
  );
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;
  const { SLSA_MANIFEST_V1_SCHEMA_URL } = await import("./manifest.ts");

  const baseEntry = (sha: string) => ({
    url: "https://e.com/a.node.gz",
    bundleUrl: "https://e.com/a.node.gz.sigstore",
    sha256: sha,
  });

  const manifest = SlsaManifestSchemaV1.parse({
    $schema: SLSA_MANIFEST_V1_SCHEMA_URL,
    packageName: "p",
    runInvocationURI: "https://github.com/o/r/actions/runs/1/attempts/1",
    sourceRepo: "o/r",
    sourceCommit: "a".repeat(40),
    sourceRef: "refs/tags/v1",
    addons: {
      linux: { x64: baseEntry("a".repeat(64)), arm64: baseEntry("b".repeat(64)) },
      darwin: { arm64: baseEntry("c".repeat(64)) },
    },
  });

  describe("findAddonEntryBySha", () => {
    it("finds an entry by exact sha256", ({ expect }) => {
      expect(findAddonEntryBySha(manifest, "b".repeat(64)).sha256).toBe("b".repeat(64));
    });
    it("matches case-insensitively", ({ expect }) => {
      expect(findAddonEntryBySha(manifest, "C".repeat(64)).sha256).toBe("c".repeat(64));
    });
    it("throws ProvenanceError when sha is not present", ({ expect }) => {
      expect(() => findAddonEntryBySha(manifest, "0".repeat(64))).toThrow(/not found in manifest/);
    });
    it("handles platforms with no entries", ({ expect }) => {
      // Sparse partial-record: the schema allows missing platform/arch keys.
      const sparse = SlsaManifestSchemaV1.parse({
        $schema: SLSA_MANIFEST_V1_SCHEMA_URL,
        packageName: "p",
        runInvocationURI: "https://github.com/o/r/actions/runs/1/attempts/1",
        sourceRepo: "o/r",
        sourceCommit: "a".repeat(40),
        sourceRef: "refs/tags/v1",
        addons: { linux: {} },
      });
      expect(() => findAddonEntryBySha(sparse, "a".repeat(64))).toThrow(/not found in manifest/);
    });
  });
}
