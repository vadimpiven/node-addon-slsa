// SPDX-License-Identifier: Apache-2.0 OR MIT

/** Barrel re-export of the public verification API. */

export {
  verifyPackage,
  verifyPackageAt,
  verifyAttestation,
  loadTrustMaterial,
  type PackageProvenance,
  type VerifyPackageOptions,
  type VerifyAttestationOptions,
} from "./verify.ts";
