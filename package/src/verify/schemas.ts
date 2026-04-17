// SPDX-License-Identifier: Apache-2.0 OR MIT

/** Zod schemas for npm registry and Rekor API response validation. */

import { bundleFromJSON, bundleToJSON } from "@sigstore/bundle";
import { z } from "zod/v4";

/**
 * Validate and normalize via the official sigstore parser.
 * Round-trips through bundleFromJSON/bundleToJSON to produce
 * a canonical SerializedBundle with consistent field casing.
 */
export const BundleSchema = z.looseObject({}).transform((val) => bundleToJSON(bundleFromJSON(val)));

/** `GET /-/npm/v1/attestations/{pkg}@{version}` response schema. */
export const NpmAttestationsSchema = z.object({
  attestations: z.array(
    z.object({
      predicateType: z.string(),
      bundle: BundleSchema,
    }),
  ),
});

/** Decoded npm attestations response. */
export type NpmAttestations = z.infer<typeof NpmAttestationsSchema>;

/** Rekor search-by-hash response: hex entry UUIDs. */
export const RekorSearchResponseSchema = z.array(z.string().regex(/^[a-f0-9]+$/));

/** Single Rekor log entry (from REST API). */
const RekorLogEntryObject = z.object({
  body: z.string(),
  integratedTime: z.number(),
  logID: z.string(),
  logIndex: z.number(),
  verification: z.object({
    signedEntryTimestamp: z.string(),
    inclusionProof: z.object({
      checkpoint: z.string(),
      hashes: z.array(z.string()),
      logIndex: z.number(),
      rootHash: z.string(),
      treeSize: z.number(),
    }),
  }),
});

/** Decoded single Rekor log entry. */
export type RekorLogEntry = z.infer<typeof RekorLogEntryObject>;

/** Rekor GET /log/entries/{uuid}: { [uuid]: entry }. */
export const RekorLogEntrySchema = z.record(z.string(), RekorLogEntryObject);

/** Decoded Rekor DSSE entry body. */
export const RekorDsseBodySchema = z.object({
  apiVersion: z.string(),
  kind: z.literal("dsse"),
  spec: z.object({
    envelopeHash: z.object({
      algorithm: z.literal("sha256"),
      value: z.string(),
    }),
    payloadHash: z.object({
      algorithm: z.literal("sha256"),
      value: z.string(),
    }),
    signatures: z
      .array(
        z.object({
          signature: z.string(),
          verifier: z.string(),
        }),
      )
      .min(1),
  }),
});
