// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Zod schemas: SLSA manifest (source of truth for the JSON Schema published
 * to GitHub Pages) and the in-toto Statement decoded from sigstore bundles.
 */

import { z } from "zod/v4";

import { GITHUB_REPO_RE } from "../types.ts";

/** URL embedded in every manifest's `$schema` field; compared by exact string equality. */
export const SLSA_MANIFEST_V1_SCHEMA_URL =
  "https://vadimpiven.github.io/node-addon-slsa/schema/slsa-manifest.v1.json";

/** Closed set of Node.js `process.platform` values supported by prebuilt addons. */
export const PlatformSchema = z.enum(["darwin", "linux", "win32"]);
/**
 * Closed set of Node.js `process.arch` values. Electron reports `arm` for
 * armv7l; `ia32` covers 32-bit Windows. Other `process.arch` values
 * (e.g. `riscv64`, `mips`) are rejected.
 */
export const ArchSchema = z.enum(["x64", "arm64", "arm", "ia32"]);
export type Platform = z.infer<typeof PlatformSchema>;
export type Arch = z.infer<typeof ArchSchema>;

const HttpsUrlSchema = z
  .string()
  .url()
  .refine((s) => s.startsWith("https://"), { message: "url must use https://" });

/**
 * Addon URLs must point at a gzip-compressed `.node` binary. The consumer's
 * download pipeline unconditionally pipes through `createGunzip()`; a URL
 * that served a plain `.node` would fail obscurely at gunzip. The sha256
 * pinned in the manifest is computed over the *compressed* bytes, so the
 * extension also locks the wire format that hash applies to.
 *
 * The check keys on the URL's pathname (not the raw string) so query
 * strings / fragments don't bypass it.
 */
const AddonArtifactUrlSchema = HttpsUrlSchema.refine(
  (s) => {
    try {
      return new URL(s).pathname.toLowerCase().endsWith(".node.gz");
    } catch {
      return false;
    }
  },
  { message: "addon url path must end with .node.gz" },
);

/** Sidecar bundle URL — the sigstore bundle companion to the addon. */
const AddonBundleUrlSchema = HttpsUrlSchema;

export const AddonEntrySchema = z.object({
  url: AddonArtifactUrlSchema,
  bundleUrl: AddonBundleUrlSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AddonEntry = z.infer<typeof AddonEntrySchema>;

export const AddonInventorySchema = z.partialRecord(
  PlatformSchema,
  z.partialRecord(ArchSchema, AddonEntrySchema),
);
export type AddonInventory = z.infer<typeof AddonInventorySchema>;

/** Leaf shape accepted by `verify-addons` / `attest-addons`: binary URL + sidecar bundle URL. */
const AddonUrlLeafSchema = z.object({
  url: AddonArtifactUrlSchema,
  bundleUrl: AddonBundleUrlSchema,
});
export type AddonUrlLeaf = z.infer<typeof AddonUrlLeafSchema>;

/**
 * Declared-URLs shape accepted by `verify-addons` / `attest-addons`: nested
 * `{ [platform]: { [arch]: { url, bundleUrl } } }`. Both URLs are mandatory:
 * sigstore bundles are fetched as sidecar artifacts at `bundleUrl` (not from
 * the Attestations API, which requires auth for private source repos).
 */
export const AddonUrlMapSchema = z.partialRecord(
  PlatformSchema,
  z.partialRecord(ArchSchema, AddonUrlLeafSchema),
);
export type AddonUrlMap = z.infer<typeof AddonUrlMapSchema>;

/**
 * Flatten a nested {@link AddonUrlMap} into ordered `{ platform, arch, url, bundleUrl }`
 * tuples. Centralises the `Object.entries(...).flatMap(...)` idiom used by
 * both publish-side actions so key typing is consistent.
 */
export function flattenAddonUrlMap(
  map: AddonUrlMap,
): Array<{ platform: Platform; arch: Arch; url: string; bundleUrl: string }> {
  return Object.entries(map).flatMap(([platform, byArch]) =>
    Object.entries(byArch ?? {}).map(([arch, leaf]) => ({
      platform: platform as Platform,
      arch: arch as Arch,
      url: leaf.url,
      bundleUrl: leaf.bundleUrl,
    })),
  );
}

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

/**
 * Minimal in-toto Statement shape, as decoded from a sigstore bundle's
 * `dsseEnvelope.payload`. Only `subject` is used for the addon-digest
 * binding; `predicateType` and `predicate` are carried through unread.
 */
export const InTotoStatementSchema = z.object({
  _type: z.string(),
  subject: z
    .array(
      z.object({
        name: z.string().optional(),
        digest: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
      }),
    )
    .min(1),
  predicateType: z.string(),
});

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

  describe("flattenAddonUrlMap", () => {
    it("flattens nested map into ordered tuples", ({ expect }) => {
      const map: AddonUrlMap = {
        linux: {
          x64: { url: "https://e.com/a.node.gz", bundleUrl: "https://e.com/a.node.gz.sigstore" },
          arm64: { url: "https://e.com/b.node.gz", bundleUrl: "https://e.com/b.node.gz.sigstore" },
        },
        darwin: {
          arm64: { url: "https://e.com/c.node.gz", bundleUrl: "https://e.com/c.node.gz.sigstore" },
        },
      };
      const flat = flattenAddonUrlMap(map);
      expect(flat).toEqual([
        {
          platform: "linux",
          arch: "x64",
          url: "https://e.com/a.node.gz",
          bundleUrl: "https://e.com/a.node.gz.sigstore",
        },
        {
          platform: "linux",
          arch: "arm64",
          url: "https://e.com/b.node.gz",
          bundleUrl: "https://e.com/b.node.gz.sigstore",
        },
        {
          platform: "darwin",
          arch: "arm64",
          url: "https://e.com/c.node.gz",
          bundleUrl: "https://e.com/c.node.gz.sigstore",
        },
      ]);
    });

    it("treats a platform with no arches as empty", ({ expect }) => {
      const map: AddonUrlMap = { linux: {} };
      expect(flattenAddonUrlMap(map)).toEqual([]);
    });
  });

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
