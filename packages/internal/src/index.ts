// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Workspace-internal primitives for {@link https://www.npmjs.com/package/node-addon-slsa node-addon-slsa}
 * and its bundled GitHub Actions (`attest-addons`, `verify-addons`).
 * Not a stable public API — shapes change between minor versions.
 *
 * Published consumers should import from `node-addon-slsa` instead.
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
  loadTrustMaterial,
  createBundleVerifier,
} from "./verify/verify.ts";
export type {
  PackageProvenance,
  VerifyPackageOptions,
  VerifyAttestationOptions,
} from "./verify/verify.ts";
export type { BundleVerifier, TrustMaterial, VerifyOptions } from "./types.ts";

// Package.json parsing
export { readPackageJson, extractExpectedRepo } from "./package.ts";

// Manifest construction and schemas
export {
  SLSA_MANIFEST_V1_SCHEMA_URL,
  SlsaManifestSchemaV1,
  AddonInventorySchema,
  AddonUrlMapSchema,
  PlatformSchema,
  ArchSchema,
  PublishedSchemas,
  buildAddonInventory,
  flattenAddonUrlMap,
} from "./verify/schemas.ts";
export type { SlsaManifest, AddonInventory, AddonEntry, Platform, Arch } from "./verify/schemas.ts";

// Branding / URLs. Exported so fork tooling can programmatically build
// their own signer pattern via buildSignerPatternFromPrefix.
export { BRAND_PAGES_BASE, BRAND_REPO, BRAND_PUBLISH_WORKFLOW_PATH } from "./verify/brand.ts";
export { buildSignerPatternFromPrefix } from "./verify/verify.ts";

// Defaults
export {
  DEFAULT_ATTEST_SIGNER_PATTERN,
  DEFAULT_MANIFEST_PATH,
  DEFAULT_MAX_BINARY_BYTES,
  DEFAULT_MAX_BINARY_SECONDS,
} from "./verify/constants.ts";

// Low-level helpers
export {
  createHttpClient,
  withRetry,
  HttpError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
} from "./http.ts";
export type {
  HttpClient,
  HttpResult,
  HttpRequestOptions,
  HttpErrorKind,
  RetryDecision,
} from "./http.ts";
export { createRekorClient, RekorError } from "./verify/rekor-client.ts";
export type { RekorClient, RekorClientOptions, RekorErrorKind } from "./verify/rekor-client.ts";
export { assertWithinDir, isEnoent, isEnotdir, safeUnlink, tempDir } from "./util/fs.ts";
export { fetchAndHashAddon } from "./util/addon-fetch.ts";
export type { FetchAndHashAddonOptions } from "./util/addon-fetch.ts";
export { createHashPassthrough } from "./util/hash.ts";
export { evalTemplate } from "./util/template.ts";
export { log, warn } from "./util/log.ts";
export { errorMessage } from "./util/error.ts";
