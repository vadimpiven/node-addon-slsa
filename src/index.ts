// SPDX-License-Identifier: Apache-2.0 OR MIT

/** @internal CLI entry point, consumed by `bin/slsa.mjs`. */
export { runSlsa } from "./cli.ts";

/** Public API. */
export { ProvenanceError, isProvenanceError } from "./util/provenance-error.ts";
export { verifyPackageProvenance, verifyAddonProvenance } from "./verify.ts";
export type { PackageProvenance, RunInvocationURI } from "./verify.ts";
