// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Per-binary descriptor schemas: the trust contract between
 * `attest-addon` (writer) and `verify-addons` (reader).
 *
 * `AddonDescriptor` extends `AddonEntry` with the `(platform, arch)` pair
 * so the publish-side verifier can group descriptors without trusting the
 * artifact filename.
 */

import { z } from "zod/v4";

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

/** Lowercase 64-hex SHA-256 string. Single source of truth for the regex. */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Bare https URL alias — used as the building block for stricter URL schemas. */
export const HttpsUrlSchema = z
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
export const AddonArtifactUrlSchema = HttpsUrlSchema.refine(
  (s) => {
    try {
      return new URL(s).pathname.toLowerCase().endsWith(".node.gz");
    } catch {
      return false;
    }
  },
  { message: "addon url path must end with .node.gz" },
);

export const AddonEntrySchema = z.object({
  url: AddonArtifactUrlSchema,
  bundleUrl: HttpsUrlSchema,
  sha256: Sha256HexSchema,
});
export type AddonEntry = z.infer<typeof AddonEntrySchema>;

/**
 * Per-binary descriptor written by `attest-addon` and consumed by
 * `verify-addons` (paired with its sibling sigstore bundle). Composed
 * from {@link AddonEntrySchema} so the trust contract can't drift.
 */
export const AddonDescriptorSchema = AddonEntrySchema.extend({
  platform: PlatformSchema,
  arch: ArchSchema,
});
export type AddonDescriptor = z.infer<typeof AddonDescriptorSchema>;

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

  describe("AddonDescriptorSchema", () => {
    const VALID_DESCRIPTOR: AddonDescriptor = {
      platform: "linux",
      arch: "x64",
      url: "https://e.com/a.node.gz",
      bundleUrl: "https://e.com/a.node.gz.sigstore",
      sha256: "a".repeat(64),
    };

    it("round-trips a valid descriptor", ({ expect }) => {
      expect(AddonDescriptorSchema.parse(VALID_DESCRIPTOR)).toEqual(VALID_DESCRIPTOR);
    });

    it("rejects unknown platform", ({ expect }) => {
      expect(() =>
        AddonDescriptorSchema.parse({ ...VALID_DESCRIPTOR, platform: "freebsd" }),
      ).toThrow();
    });

    it("rejects non-.node.gz url", ({ expect }) => {
      expect(() =>
        AddonDescriptorSchema.parse({ ...VALID_DESCRIPTOR, url: "https://e.com/a.node" }),
      ).toThrow();
    });

    it("rejects non-hex sha256", ({ expect }) => {
      expect(() =>
        AddonDescriptorSchema.parse({ ...VALID_DESCRIPTOR, sha256: "not-hex" }),
      ).toThrow();
    });
  });
}
