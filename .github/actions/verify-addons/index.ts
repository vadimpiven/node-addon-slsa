// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Reference composition of the internal primitives for the verify step
 * of the reusable `publish.yaml` workflow. Fork authors can copy this
 * shape to build a custom verifier.
 *
 * Trust-critical: for each declared addon URL, fetch under a size cap,
 * hash, and `verifyAttestation` against Rekor with the Build Signer URI
 * pinned to this workflow (via `DEFAULT_ATTEST_SIGNER_PATTERN`). Emits
 * the SLSA manifest as a JSON string; the enclosing workflow resolves
 * the target path and writes the file. Pure in/out — no filesystem
 * reads or writes — so auditors can reason about the crypto-critical
 * code in isolation and tests don't need a temp dir.
 */

import { getInput, setFailed, setOutput } from "@actions/core";
import { getGlobalDispatcher } from "undici";

import {
  AddonUrlMapSchema,
  DEFAULT_MAX_BINARY_BYTES,
  DEFAULT_MAX_BINARY_SECONDS,
  SLSA_MANIFEST_V1_SCHEMA_URL,
  buildAddonInventory,
  createHttpClient,
  errorMessage,
  fetchAndHashAddon,
  flattenAddonUrlMap,
  loadTrustMaterial,
  verifyAttestation,
  type AddonEntry,
  type SlsaManifest,
} from "@node-addon-slsa/internal";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`required env var ${name} is not set`);
  return value;
}

/** Treat empty-string `getInput` results as "not provided" so `"0"` survives. */
function readNumberInput(name: string, fallback: number): number {
  const raw = getInput(name);
  return raw === "" ? fallback : Number(raw);
}

/**
 * Entry point invoked by the action runner. Reads inputs and env,
 * verifies every addon against Rekor, and emits the SLSA manifest JSON
 * via the `manifest` output.
 */
export async function main(): Promise<void> {
  const packageName = getInput("package-name", { required: true });
  const addonsRaw = getInput("addons", { required: true });
  const maxBinaryBytes = readNumberInput("max-binary-bytes", DEFAULT_MAX_BINARY_BYTES);
  const maxBinaryMs = readNumberInput("max-binary-seconds", DEFAULT_MAX_BINARY_SECONDS) * 1000;

  const addons = AddonUrlMapSchema.parse(JSON.parse(addonsRaw));

  const repo = requireEnv("GITHUB_REPOSITORY");
  const commit = requireEnv("GITHUB_SHA");
  const ref = requireEnv("GITHUB_REF");
  const runId = requireEnv("GITHUB_RUN_ID");
  const runAttempt = requireEnv("GITHUB_RUN_ATTEMPT");
  const runURI = `https://github.com/${repo}/actions/runs/${runId}/attempts/${runAttempt}`;

  // Fail fast on malformed env before we start downloading binaries. The
  // same rules are re-enforced inside `verifyAttestation`; doing it here
  // surfaces misconfiguration without wasting a network round-trip per addon.
  if (!ref.startsWith("refs/tags/")) {
    throw new Error(`GITHUB_REF must start with refs/tags/, got: ${ref}`);
  }

  const entries = flattenAddonUrlMap(addons);
  if (entries.length === 0) {
    throw new Error("addons input has no URLs; expected at least one platform/arch leaf");
  }

  const trustMaterial = await loadTrustMaterial();
  // One HttpClient for addon fetches and Rekor calls. Operators who set
  // a proxy/mTLS agent via `setGlobalDispatcher` pick it up here; tests
  // pass an `httpClient` option directly instead.
  const http = createHttpClient({ dispatcher: getGlobalDispatcher() });

  const verified = await Promise.all(
    entries.map(async ({ platform, arch, url }) => {
      const sha256 = await fetchAndHashAddon(http, url, {
        maxBinaryBytes,
        maxBinaryMs,
        label: `${platform}/${arch}`,
      });
      await verifyAttestation({
        sha256,
        repo,
        runInvocationURI: runURI,
        sourceCommit: commit,
        sourceRef: ref,
        trustMaterial,
        httpClient: http,
      });
      return { platform, arch, entry: { url, sha256 } satisfies AddonEntry };
    }),
  );

  const manifest: SlsaManifest = {
    $schema: SLSA_MANIFEST_V1_SCHEMA_URL,
    packageName,
    runInvocationURI: runURI,
    sourceRepo: repo,
    sourceCommit: commit,
    sourceRef: ref,
    addons: buildAddonInventory(verified),
  };

  setOutput("manifest", JSON.stringify(manifest, null, 2));
}

// Auto-run unless imported by a test harness (vitest sets VITEST=true).
if (!process.env["VITEST"]) {
  try {
    await main();
  } catch (error: unknown) {
    setFailed(errorMessage(error));
  }
}
