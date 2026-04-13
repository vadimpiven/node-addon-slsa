// SPDX-License-Identifier: Apache-2.0 OR MIT

/** Barrel re-export of the public verification API from verify.ts. */

export {
  type PackageProvenance,
  verifyPackageProvenance,
  verifyAddonProvenance,
  loadTrustMaterial,
} from "./verify.ts";
