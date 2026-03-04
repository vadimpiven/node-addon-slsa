// SPDX-License-Identifier: Apache-2.0 OR MIT

/** @internal CLI entry point, consumed by `bin/slsa.mjs`. */
export { runSlsa } from "./cli.ts";

/** Public API. */
export { SecurityError, isSecurityError } from "./util/security-error.ts";
export { verifyNpmProvenance, verifyBinaryProvenance } from "./verify.ts";
