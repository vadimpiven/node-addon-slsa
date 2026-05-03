// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Workspace-internal primitives for {@link https://www.npmjs.com/package/node-addon-slsa node-addon-slsa}
 * and its bundled GitHub Actions (`attest-addon`, `verify-addons`).
 * Not a stable public API — shapes change between minor versions.
 *
 * Published consumers should import from `node-addon-slsa` instead.
 *
 * Surface (grouped):
 *   - Verification API:      verifyPackage, verifyPackageAt, verifyAttestation,
 *                            verifyAttestationFromBundle, loadTrustMaterial,
 *                            createBundleVerifier
 *   - Schemas / manifest:    SlsaManifestSchemaV1, AddonInventorySchema,
 *                            AddonDescriptorSchema, AddonEntrySchema,
 *                            AddonArtifactUrlSchema, HttpsUrlSchema,
 *                            Sha256HexSchema, PlatformSchema, ArchSchema,
 *                            buildAddonInventory, PublishedSchemas
 *   - Trust-anchor builders: buildAttestSignerPattern,
 *                            buildToolkitAttestSignerPattern,
 *                            getDefaultAttestSignerPattern
 *   - HTTP / FS / hashing:   createHttpClient, withRetry, HttpError,
 *                            assertWithinDir, isEnoent, isEnotdir,
 *                            safeUnlink, tempDir, fetchAndHashAddon,
 *                            createHashPassthrough, hashFileSha256
 *   - Action helpers:        requireEnv, readPositiveIntInput,
 *                            normalizeHttpsPrefix
 *   - Misc:                  ProvenanceError, evalTemplate, log, warn,
 *                            errorMessage, readPackageJson,
 *                            extractExpectedRepo
 */

// Public-facing symbols re-exported by node-addon-slsa
export {
  ProvenanceError,
  isProvenanceError,
  type ProvenanceErrorKind,
} from "./util/provenance-error.ts";
export {
  verifyPackage,
  verifyPackageAt,
  verifyAttestation,
  verifyAttestationFromBundle,
  loadTrustMaterial,
  createBundleVerifier,
} from "./verify/verify.ts";
export type {
  PackageProvenance,
  VerifyPackageOptions,
  VerifyPackageAtOptions,
  VerifyAttestationOptions,
  VerifyAttestationFromBundleOptions,
} from "./verify/verify.ts";
export type { BundleVerifier, TrustMaterial, VerifyOptions, Sha256Hex } from "./types.ts";
export type { SerializedBundle } from "@sigstore/bundle";

// Package.json parsing
export { readPackageJson, extractExpectedRepo } from "./package.ts";

// Manifest construction and schemas
export {
  SLSA_MANIFEST_V1_SCHEMA_URL,
  SlsaManifestSchemaV1,
  AddonInventorySchema,
  PublishedSchemas,
  buildAddonInventory,
} from "./verify/manifest.ts";
export type { SlsaManifest, AddonInventory } from "./verify/manifest.ts";
export {
  AddonArtifactUrlSchema,
  AddonDescriptorSchema,
  AddonEntrySchema,
  ArchSchema,
  HttpsUrlSchema,
  PlatformSchema,
  Sha256HexSchema,
} from "./verify/descriptor.ts";
export type { AddonDescriptor, AddonEntry, Arch, Platform } from "./verify/descriptor.ts";

// Defaults / builders
export {
  buildAttestSignerPattern,
  buildToolkitAttestSignerPattern,
  getDefaultAttestSignerPattern,
  DEFAULT_MAX_BINARY_BYTES,
  DEFAULT_MAX_BINARY_SECONDS,
} from "./verify/constants.ts";
export type { BuildAttestSignerPatternOptions } from "./verify/constants.ts";

// Low-level helpers
export { createHttpClient, withRetry, HttpError } from "./http.ts";
export type {
  HttpClient,
  HttpResult,
  HttpRequestOptions,
  HttpErrorKind,
  RetryDecision,
  CreateHttpClientOptions,
  WithRetryOptions,
} from "./http.ts";
export { assertWithinDir, isEnoent, isEnotdir, safeUnlink, tempDir } from "./util/fs.ts";
export type { AssertWithinDirOptions } from "./util/fs.ts";
export { fetchAndHashAddon } from "./util/addon-fetch.ts";
export type { FetchAndHashAddonOptions } from "./util/addon-fetch.ts";
export { createHashPassthrough, hashFileSha256 } from "./util/hash.ts";
export type { HashFileSha256Options } from "./util/hash.ts";
export { evalTemplate } from "./util/template.ts";
export { log, warn } from "./util/log.ts";
export { errorMessage } from "./util/error.ts";
export { normalizeHttpsPrefix, readPositiveIntInput, requireEnv } from "./util/inputs.ts";
