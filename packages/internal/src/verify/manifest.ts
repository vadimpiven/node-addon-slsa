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
  // Build via Map<Platform, Map<Arch, AddonEntry>> so the schema-validated
  // platform/arch keys never become computed-property writes on a
  // prototype-bearing object — keeps CodeQL's `js/prototype-polluting-assignment`
  // happy without changing the public shape.
  const grouped = new Map<Platform, Map<Arch, AddonEntry>>();
  for (const { platform, arch, entry } of entries) {
    let byArch = grouped.get(platform);
    if (!byArch) {
      byArch = new Map();
      grouped.set(platform, byArch);
    }
    byArch.set(arch, entry);
  }
  const inventory = Object.create(null) as Record<Platform, Record<Arch, AddonEntry>>;
  for (const [platform, byArch] of grouped) {
    inventory[platform] = Object.fromEntries(byArch) as Record<Arch, AddonEntry>;
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
  sourceRef: z.string().regex(/^refs\/tags\/[A-Za-z0-9._@+/-]+$/),
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

  // buildAddonInventory's reassembly + empty-input branches are exercised
  // by verify-addons.test.ts (which round-trips real descriptor files
  // through the action and asserts the resulting manifest shape), and
  // SlsaManifestSchemaV1's happy-path parse runs on every verify-package
  // test. Keep only the rejection branches and the new git-tag positive
  // case (covers `+build.N` / `@scope/pkg@v` tags) — none of which any
  // e2e flow can currently trigger.

  describe("SlsaManifestSchemaV1", () => {
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
        ["sourceRef", "refs/tags/v1 0"],
        ["sourceRepo", "no-slash"],
      ]) {
        const bad = { ...VALID, [field!]: value };
        expect(() => SlsaManifestSchemaV1.parse(bad), `field=${field}`).toThrow();
      }
    });

    it("accepts non-SemVer git tag characters (@, +)", ({ expect }) => {
      for (const sourceRef of ["refs/tags/v1.0.0+build.1", "refs/tags/@scope/pkg@1.0.0"]) {
        expect(SlsaManifestSchemaV1.parse({ ...VALID, sourceRef }).sourceRef).toBe(sourceRef);
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
