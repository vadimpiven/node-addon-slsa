// SPDX-License-Identifier: Apache-2.0 OR MIT

/** npm registry attestation fetch — used by verify.ts for package provenance. */

import dedent from "dedent";

import { fetchWithRetry } from "../http.ts";
import type { SemVerString } from "../types.ts";
import { readJsonBounded } from "../util/json.ts";
import { ProvenanceError } from "../util/provenance-error.ts";
import { evalTemplate } from "../util/template.ts";
import type { ResolvedConfig } from "./config.ts";
import { NPM_ATTESTATIONS_URL } from "./constants.ts";
import { NpmAttestationsSchema, type NpmAttestations } from "./schemas.ts";

/**
 * Fetch npm package attestations from the npm registry.
 *
 * @throws {ProvenanceError} if no attestation exists (HTTP 404).
 * @throws {Error} if the HTTP request fails for other reasons.
 */
export async function fetchNpmAttestations(
  { packageName, version }: { packageName: string; version: SemVerString },
  config: ResolvedConfig,
): Promise<NpmAttestations> {
  const url = evalTemplate(NPM_ATTESTATIONS_URL, {
    name: encodeURIComponent(packageName),
    version: encodeURIComponent(version),
  });

  const response = await fetchWithRetry(url, config);

  if (response.statusCode === 404) {
    await response.body.dump();
    throw new ProvenanceError(
      dedent`
        No provenance attestation found on npm for ${packageName}@${version}.
        The package may have been published without provenance or tampered with.
      `,
    );
  }

  if (response.statusCode >= 400) {
    await response.body.dump();
    throw new Error(dedent`
      failed to fetch npm attestations: ${response.statusCode}.
      Check your network connection and verify that ${packageName}@${version} exists on npm.
    `);
  }

  return NpmAttestationsSchema.parse(
    await readJsonBounded(response.body, config.maxJsonResponseBytes),
  );
}
