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

// findAddonEntryBySha is fully exercised by verify-package.test.ts
// (verifyAddonBySha256 happy path + the "sha not in manifest" rejection
// + verifyAddonFromFile's hash-then-lookup), so no in-source unit tests
// are kept here.
