// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Escape hatches for heavy callers verifying many packages in one process.
 * Load trust material once, wrap it in a verifier, and pass it as
 * `options.verifier` to each `verifyPackage` call — saves a TUF round-trip
 * per call and lets callers tune sigstore thresholds via the underlying
 * `@sigstore/verify.Verifier`.
 *
 * Kept in a separate subpath (`node-addon-slsa/advanced`) rather than the
 * main entry point: the common case (`verifyPackage` + `requireAddon`)
 * should not force consumers to reason about sigstore trust material,
 * and the separation makes the semver-covered public surface obvious.
 *
 * ```typescript
 * import { verifyPackage } from "node-addon-slsa";
 * import { loadTrustMaterial, createBundleVerifier } from "node-addon-slsa/advanced";
 *
 * const verifier = createBundleVerifier(await loadTrustMaterial());
 * for (const name of ["addon-a", "addon-b", "addon-c"]) {
 *   const p = await verifyPackage({ packageName: name, repo: "owner/repo", verifier });
 *   await p.verifyAddonFromFile(`/path/to/${name}/dist/addon.node.gz`);
 * }
 * ```
 */

/**
 * Build a Fulcio Build Signer URI pattern (OID 1.3.6.1.4.1.57264.1.9) for
 * an arbitrary `(repo, workflow)` pair, SHA-anchored. Pass to
 * `verifyPackage({ attestSignerPattern })` to override the default.
 */
export { buildAttestSignerPattern } from "@node-addon-slsa/internal";

/**
 * The toolkit's reusable-workflow Build Signer URI pin —
 * `attest-addon.yaml` in `vadimpiven/node-addon-slsa`, SHA-anchored.
 * Used as the default trust anchor when no `attestSignerPattern` is given.
 */
export { buildToolkitAttestSignerPattern } from "@node-addon-slsa/internal";

export { createBundleVerifier, loadTrustMaterial } from "@node-addon-slsa/internal";
export type { BundleVerifier, TrustMaterial } from "@node-addon-slsa/internal";
export type { Dispatcher } from "undici";
