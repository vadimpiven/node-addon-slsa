// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Reference composition of the internal primitives for the attest step
 * of the reusable `publish.yaml` workflow. Fork authors can copy this
 * shape to build a custom publisher.
 *
 * Flow: fetch each declared addon URL (with CDN-propagation-aware
 * retries), SHA-256 the body under a size cap, then mint a single
 * build-provenance attestation on the public-good Sigstore instance.
 * Running inside the reusable workflow pins the Fulcio cert's Build
 * Signer URI to this repo's `publish.yaml`, which `verifyPackage`
 * enforces via `DEFAULT_ATTEST_SIGNER_PATTERN`.
 */

import { attestProvenance, type Subject } from "@actions/attest";
import { getInput, setFailed, setOutput } from "@actions/core";
import { getGlobalDispatcher } from "undici";

import {
  AddonUrlMapSchema,
  DEFAULT_MAX_BINARY_BYTES,
  DEFAULT_MAX_BINARY_SECONDS,
  createHttpClient,
  errorMessage,
  fetchAndHashAddon,
  flattenAddonUrlMap,
} from "@node-addon-slsa/internal";

/** Treat empty-string `getInput` results as "not provided" so `"0"` survives. */
function readNumberInput(name: string, fallback: number): number {
  const raw = getInput(name);
  return raw === "" ? fallback : Number(raw);
}

/**
 * Entry point invoked by the action runner. Reads inputs, hashes every
 * addon, calls `attestProvenance`, and emits the attestation id.
 */
export async function main(): Promise<void> {
  const addonsRaw = getInput("addons", { required: true });
  const token = getInput("github-token", { required: true });
  const maxBinaryBytes = readNumberInput("max-binary-bytes", DEFAULT_MAX_BINARY_BYTES);
  const maxBinaryMs = readNumberInput("max-binary-seconds", DEFAULT_MAX_BINARY_SECONDS) * 1000;
  const retryCount = readNumberInput("retry-count", 10);

  const addons = AddonUrlMapSchema.parse(JSON.parse(addonsRaw));
  const entries = flattenAddonUrlMap(addons);
  if (entries.length === 0) {
    throw new Error("addons input has no URLs; expected at least one platform/arch leaf");
  }

  const http = createHttpClient({ dispatcher: getGlobalDispatcher() });

  const subjects: Subject[] = await Promise.all(
    entries.map(async ({ platform, arch, url }) => {
      const sha256 = await fetchAndHashAddon(http, url, {
        maxBinaryBytes,
        maxBinaryMs,
        label: `${platform}/${arch}`,
        retryCount,
        retryOn404: true,
      });
      return { name: url, digest: { sha256 } } satisfies Subject;
    }),
  );

  const result = await attestProvenance({ subjects, token, sigstore: "public-good" });
  setOutput("attestation-id", result.attestationID);
}

// Auto-run unless imported by a test harness (vitest sets VITEST=true).
if (!process.env["VITEST"]) {
  try {
    await main();
  } catch (error: unknown) {
    setFailed(errorMessage(error));
  }
}
