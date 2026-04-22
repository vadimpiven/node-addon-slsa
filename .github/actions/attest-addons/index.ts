// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Reference composition of the internal primitives for the attest step
 * of the reusable `publish.yaml` workflow.
 *
 * Flow: fetch each declared addon URL (with CDN-propagation-aware
 * retries), SHA-256 the body under a size cap, mint one sigstore bundle
 * covering all subjects on the public-good Sigstore instance, then
 * serialize the bundle to disk at a predictable path so the caller's
 * workflow can upload it as a sidecar release asset. Output `bundles` is
 * a JSON array mapping each subject to its chosen `bundleUrl` and the
 * on-disk path — the upload step consumes it.
 *
 * Running inside the reusable workflow pins the Fulcio cert's Build
 * Signer URI to this workflow (via `DEFAULT_ATTEST_SIGNER_PATTERN`).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

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
 * addon, mints one aggregated sigstore bundle, writes it to disk so the
 * calling workflow can upload each copy to its configured `bundleUrl`.
 */
export async function main(): Promise<void> {
  const addonsRaw = getInput("addons", { required: true });
  const token = getInput("github-token", { required: true });
  const bundleDir = getInput("bundle-dir", { required: true });
  const maxBinaryBytes = readNumberInput("max-binary-bytes", DEFAULT_MAX_BINARY_BYTES);
  const maxBinaryMs = readNumberInput("max-binary-seconds", DEFAULT_MAX_BINARY_SECONDS) * 1000;
  const retryCount = readNumberInput("retry-count", 10);

  const addons = AddonUrlMapSchema.parse(JSON.parse(addonsRaw));
  const entries = flattenAddonUrlMap(addons);
  if (entries.length === 0) {
    throw new Error("addons input has no URLs; expected at least one platform/arch leaf");
  }

  const http = createHttpClient({ dispatcher: getGlobalDispatcher() });

  const hashed = await Promise.all(
    entries.map(async ({ platform, arch, url, bundleUrl }) => {
      const sha256 = await fetchAndHashAddon(http, url, {
        maxBinaryBytes,
        maxBinaryMs,
        label: `${platform}/${arch}`,
        retryCount,
        retryOn404: true,
      });
      return { platform, arch, url, bundleUrl, sha256 };
    }),
  );

  // One multi-subject attestation — single Fulcio + Rekor round-trip regardless
  // of how many addons the release declares.
  const subjects: Subject[] = hashed.map(({ url, sha256 }) => ({
    name: url,
    digest: { sha256 },
  }));
  const result = await attestProvenance({ subjects, token, sigstore: "public-good" });

  // Persist the bundle per-addon. The bundle JSON is identical across
  // subjects (single multi-subject attestation); we write one copy per
  // sidecar destination, named by the final path segment of `bundleUrl`
  // so the caller's upload step (`gh release upload <path>`) drops the
  // asset at the filename the URL promises.
  await mkdir(bundleDir, { recursive: true });
  const bundleJson = JSON.stringify(result.bundle);
  const records = await Promise.all(
    hashed.map(async ({ platform, arch, url, bundleUrl, sha256 }) => {
      const filename = basename(new URL(bundleUrl).pathname);
      const path = join(bundleDir, filename);
      await writeFile(path, bundleJson);
      return { platform, arch, url, bundleUrl, sha256, path };
    }),
  );

  setOutput("attestation-id", result.attestationID);
  setOutput("bundles", JSON.stringify(records));
}

// Auto-run unless imported by a test harness (vitest sets VITEST=true).
if (!process.env["VITEST"]) {
  try {
    await main();
  } catch (error: unknown) {
    setFailed(errorMessage(error));
  }
}
