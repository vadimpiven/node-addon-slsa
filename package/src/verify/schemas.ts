// SPDX-License-Identifier: Apache-2.0 OR MIT

import { bundleFromJSON, bundleToJSON } from "@sigstore/bundle";
import { z } from "zod/v4";

/**
 * Validate and normalize via the official sigstore parser.
 * Round-trips through bundleFromJSON/bundleToJSON to produce
 * a canonical SerializedBundle with consistent field casing.
 */
export const BundleSchema = z.looseObject({}).transform((val) => bundleToJSON(bundleFromJSON(val)));

export const NpmAttestationsSchema = z.object({
  attestations: z.array(
    z.object({
      predicateType: z.string(),
      bundle: BundleSchema,
    }),
  ),
});

export type NpmAttestations = z.infer<typeof NpmAttestationsSchema>;

/** Raw GitHub API response — bundle may be inline or referenced via URL. */
export const GitHubAttestationsApiSchema = z.object({
  attestations: z.array(
    z
      .object({
        bundle: BundleSchema.nullable(),
        bundle_url: z.url().optional(),
      })
      .refine((attestation) => attestation.bundle != null || attestation.bundle_url != null, {
        message: `attestation has neither bundle nor bundle_url`,
      }),
  ),
});

/** Resolved form — all bundle_url entries fetched into bundles. */
export type GitHubAttestations = {
  attestations: Array<{ bundle: z.infer<typeof BundleSchema> }>;
};
