// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * SLSA manifest schemas — the JSON-Schema source of truth published to
 * GitHub Pages and embedded into installed packages.
 */

import { z } from "zod/v4";

import { GITHUB_REPO_RE } from "../types.ts";
import {
  AddonEntrySchema,
  ArchSchema,
  PlatformSchema,
  type AddonEntry,
  type Arch,
  type Platform,
} from "./descriptor.ts";

/** URL embedded in every manifest's `$schema` field; compared by exact string equality. */
export const SLSA_MANIFEST_V1_SCHEMA_URL =
  "https://vadimpiven.github.io/node-addon-slsa/schema/slsa-manifest.v1.json";

export const AddonInventorySchema = z.partialRecord(
  PlatformSchema,
  z.partialRecord(ArchSchema, AddonEntrySchema),
);
export type AddonInventory = z.infer<typeof AddonInventorySchema>;

/**
 * Reassemble flat `{ platform, arch, entry }` triples into an
 * {@link AddonInventory}. Type-safe counterpart to ad-hoc nested
 * dictionary building at call sites.
 */
export function buildAddonInventory(
  entries: ReadonlyArray<{
    readonly platform: Platform;
    readonly arch: Arch;
    readonly entry: AddonEntry;
  }>,
): AddonInventory {
  const inventory: AddonInventory = {};
  for (const { platform, arch, entry } of entries) {
    const byArch = (inventory[platform] ??= {});
    byArch[arch] = entry;
  }
  return inventory;
}

const PackageNameSchema = z.string().min(1);
const GitHubRepoSchema = z.string().regex(GITHUB_REPO_RE);
const RunInvocationURISchema = z
  .string()
  .regex(
    /^https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/actions\/runs\/\d+\/attempts\/\d+$/,
  );

export const SlsaManifestSchemaV1 = z.object({
  $schema: z.literal(SLSA_MANIFEST_V1_SCHEMA_URL),
  packageName: PackageNameSchema,
  runInvocationURI: RunInvocationURISchema,
  sourceRepo: GitHubRepoSchema,
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  sourceRef: z.string().regex(/^refs\/tags\/[A-Za-z0-9._/-]+$/),
  addons: AddonInventorySchema,
});
export type SlsaManifest = z.infer<typeof SlsaManifestSchemaV1>;

/** Registry of published manifest schemas; consumed by `scripts/generate-schemas.ts`. */
export const PublishedSchemas = {
  "slsa-manifest.v1.json": SlsaManifestSchemaV1,
} as const;

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

  const VALID: SlsaManifest = {
    $schema: SLSA_MANIFEST_V1_SCHEMA_URL,
    packageName: "@scope/my-native-addon",
    runInvocationURI: "https://github.com/owner/repo/actions/runs/123/attempts/1",
    sourceRepo: "owner/repo",
    sourceCommit: "a".repeat(40),
    sourceRef: "refs/tags/v1.2.3",
    addons: {
      linux: {
        x64: {
          url: "https://example.com/a.node.gz",
          bundleUrl: "https://example.com/a.node.gz.sigstore",
          sha256: "b".repeat(64),
        },
      },
    },
  };

  describe("buildAddonInventory", () => {
    it("reassembles triples into nested inventory", ({ expect }) => {
      const entry = (suffix: string): AddonEntry => ({
        url: `https://e.com/${suffix}.node.gz`,
        bundleUrl: `https://e.com/${suffix}.node.gz.sigstore`,
        sha256: suffix.repeat(64).slice(0, 64),
      });
      const inv = buildAddonInventory([
        { platform: "linux", arch: "x64", entry: entry("a") },
        { platform: "linux", arch: "arm64", entry: entry("b") },
        { platform: "darwin", arch: "arm64", entry: entry("c") },
      ]);
      expect(inv).toEqual({
        linux: { x64: entry("a"), arm64: entry("b") },
        darwin: { arm64: entry("c") },
      });
    });

    it("returns empty inventory for empty input", ({ expect }) => {
      expect(buildAddonInventory([])).toEqual({});
    });
  });

  describe("SlsaManifestSchemaV1", () => {
    it("parses valid manifest", ({ expect }) => {
      expect(SlsaManifestSchemaV1.parse(VALID)).toEqual(VALID);
    });

    it("rejects wrong $schema URL", ({ expect }) => {
      const bad = { ...VALID, $schema: "https://other.example/schema.json" };
      expect(() => SlsaManifestSchemaV1.parse(bad)).toThrow();
    });

    it("rejects missing $schema", ({ expect }) => {
      const { $schema: _drop, ...bad } = VALID;
      void _drop;
      expect(() => SlsaManifestSchemaV1.parse(bad)).toThrow();
    });

    it("rejects invalid fields", ({ expect }) => {
      for (const [field, value] of [
        ["packageName", ""],
        ["sourceCommit", "not-hex"],
        ["sourceRef", "refs/heads/main"],
        ["sourceRepo", "no-slash"],
      ]) {
        const bad = { ...VALID, [field!]: value };
        expect(() => SlsaManifestSchemaV1.parse(bad), `field=${field}`).toThrow();
      }
    });

    it("rejects unknown platform key", ({ expect }) => {
      const bad = {
        ...VALID,
        addons: {
          freebsd: {
            x64: {
              url: "https://e.com/a.node.gz",
              bundleUrl: "https://e.com/a.node.gz.sigstore",
              sha256: "c".repeat(64),
            },
          },
        },
      };
      expect(() => SlsaManifestSchemaV1.parse(bad)).toThrow();
    });

    it("rejects unknown arch key", ({ expect }) => {
      const bad = {
        ...VALID,
        addons: {
          linux: {
            riscv64: {
              url: "https://e.com/a.node.gz",
              bundleUrl: "https://e.com/a.node.gz.sigstore",
              sha256: "c".repeat(64),
            },
          },
        },
      };
      expect(() => SlsaManifestSchemaV1.parse(bad)).toThrow();
    });

    it("rejects non-https URL", ({ expect }) => {
      const bad = {
        ...VALID,
        addons: {
          linux: {
            x64: {
              url: "http://e.com/a.node.gz",
              bundleUrl: "https://e.com/a.node.gz.sigstore",
              sha256: "c".repeat(64),
            },
          },
        },
      };
      expect(() => SlsaManifestSchemaV1.parse(bad)).toThrow();
    });

    it("rejects non-hex sha256", ({ expect }) => {
      const bad = {
        ...VALID,
        addons: {
          linux: {
            x64: {
              url: "https://e.com/a.node.gz",
              bundleUrl: "https://e.com/a.node.gz.sigstore",
              sha256: "not-hex",
            },
          },
        },
      };
      expect(() => SlsaManifestSchemaV1.parse(bad)).toThrow();
    });

    it("rejects malformed runInvocationURI", ({ expect }) => {
      const bad = {
        ...VALID,
        runInvocationURI: "https://gitlab.com/owner/repo/actions/runs/1/attempts/1",
      };
      expect(() => SlsaManifestSchemaV1.parse(bad)).toThrow();
    });
  });
}
