// SPDX-License-Identifier: Apache-2.0 OR MIT

/** Error handling. */
export { ProvenanceError, isProvenanceError } from "./util/provenance-error.ts";

/** Verification. */
export { verifyPackageProvenance, verifyAddonProvenance } from "./verify/index.ts";

/** Type constructors. */
export { sha256Hex, semVerString, githubRepo, runInvocationURI } from "./types.ts";

/** Types. */
export type { PackageProvenance } from "./verify/index.ts";
export type {
  GitHubRepo,
  RunInvocationURI,
  SemVerString,
  Sha256Hex,
  VerifyOptions,
} from "./types.ts";
