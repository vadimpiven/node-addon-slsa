// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Public API barrel for `node-addon-slsa`. Consumers import from here;
 * everything re-exported is covered by semver.
 *
 * Two entry points, picked by integration style:
 * - {@link verifyPackage} — verify an already-installed package, then call
 *   `verifyAddonFromFile` on each binary the host is about to load.
 * - {@link requireAddon} — one-call loader: verifies, downloads if missing,
 *   and `require()`s the `.node` binary. Use when postinstall scripts are
 *   blocked (e.g. pnpm ≥ 10 default config).
 *
 * ```typescript
 * import { verifyPackage, requireAddon } from "node-addon-slsa";
 *
 * // Host-orchestrated flow:
 * const p = await verifyPackage({ packageName: "my-addon", repo: "owner/repo" });
 * await p.verifyAddonFromFile("/path/to/addon.node.gz");
 *
 * // Consuming-package flow (called from inside the addon package):
 * const addon = await requireAddon<MyAddon>();
 * ```
 *
 * Workspace-internal primitives (branded-type constructors, manifest shapes,
 * low-level HTTP/FS helpers) live under `@node-addon-slsa/internal` and are
 * not covered by semver.
 */

export { ProvenanceError, isProvenanceError } from "@node-addon-slsa/internal";

export { verifyPackage } from "@node-addon-slsa/internal";
export type { VerifyPackageOptions, PackageProvenance } from "@node-addon-slsa/internal";

export { requireAddon } from "./loader.ts";
export type { RequireAddonOptions } from "./loader.ts";

export type { VerifyOptions } from "@node-addon-slsa/internal";
export type { Dispatcher } from "undici";

/**
 * Escape hatches for heavy callers verifying many packages in one process.
 * Load trust material once, wrap it in a verifier, and pass it as
 * `options.verifier` to each `verifyPackage` call — saves a TUF round-trip
 * per call and lets callers tune sigstore thresholds via the underlying
 * `@sigstore/verify.Verifier`.
 */
export { loadTrustMaterial, createBundleVerifier } from "@node-addon-slsa/internal";
export type { BundleVerifier, TrustMaterial } from "@node-addon-slsa/internal";
