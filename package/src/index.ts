// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Public API of node-addon-slsa.
 *
 * Common usage:
 * ```typescript
 * import { verifyPackageProvenance, semVerString, githubRepo } from "node-addon-slsa";
 * const p = await verifyPackageProvenance({ packageName: "pkg", version: semVerString("1.0.0"), repo: githubRepo("owner/repo") });
 * await p.verifyAddon({ sha256: sha256Hex(hash) });
 * ```
 *
 * All options have sensible defaults. Advanced parameters (timeouts,
 * retries, trust material, dispatcher) are available when needed.
 */

/** Error handling. */
export { ProvenanceError, isProvenanceError } from "./util/provenance-error.ts";

/** Verification. */
export {
  verifyPackageProvenance,
  verifyAddonProvenance,
  loadTrustMaterial,
} from "./verify/index.ts";

/** Runtime addon loader. */
export { requireAddon } from "./loader.ts";
export type { RequireAddonOptions } from "./loader.ts";

/** Type constructors. */
export { sha256Hex, semVerString, githubRepo, runInvocationURI } from "./types.ts";

/** Types. */
export type { PackageProvenance } from "./verify/index.ts";
export type {
  BundleVerifier,
  FetchOptions,
  GitHubRepo,
  RunInvocationURI,
  SemVerString,
  Sha256Hex,
  TrustMaterial,
  VerifyOptions,
} from "./types.ts";
export type { Dispatcher } from "undici";
