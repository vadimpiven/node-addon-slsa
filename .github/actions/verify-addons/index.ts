// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Reference composition of the internal primitives for the verify step
 * of the reusable `publish.yaml` workflow.
 *
 * Trust-critical: for each declared addon URL, fetch the binary under a
 * size cap, hash it, then fetch the sidecar sigstore bundle at the
 * declared `bundleUrl`, run the full `@sigstore/verify` chain against
 * TUF-backed trust material, and check the Fulcio cert's OIDs against
 * this run's commit / ref / run-invocation-URI and a Build Signer
 * pattern derived from `GITHUB_REPOSITORY` + `attest-workflow`. Emits
 * the SLSA manifest as a JSON string; the enclosing workflow writes it
 * into the tarball.
 */

import { getInput, info, setFailed, setOutput } from "@actions/core";
import { getGlobalDispatcher } from "undici";

import {
  AddonUrlMapSchema,
  DEFAULT_MAX_BINARY_BYTES,
  DEFAULT_MAX_BINARY_SECONDS,
  SLSA_MANIFEST_V1_SCHEMA_URL,
  buildAddonInventory,
  buildAttestSignerPattern,
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
 * runs the full sigstore bundle verification for every declared addon,
 * and emits the SLSA manifest JSON via the `manifest` output.
 */
export async function main(): Promise<void> {
  const packageName = getInput("package-name", { required: true });
  const addonsRaw = getInput("addons", { required: true });
  const attestWorkflow = getInput("attest-workflow", { required: true });
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

  info(`Verifying ${entries.length} addon binary(ies) for ${packageName}.`);
  info(`  repo:    ${repo}`);
  info(`  ref:     ${ref}`);
  info(`  commit:  ${commit}`);
  info(`  signer:  .github/workflows/${attestWorkflow}`);

  info(`[1/2] Loading Sigstore trust material (TUF root)…`);
  const trustMaterial = await loadTrustMaterial();
  info(`  ✓ loaded`);
  // One HttpClient for addon fetches + bundle fetches; `verifyAttestation`
  // builds its own from the passed `dispatcher`.
  const http = createHttpClient({ dispatcher: getGlobalDispatcher() });
  const attestSignerPattern = buildAttestSignerPattern({ repo, workflow: attestWorkflow });

  info(`[2/2] Downloading and verifying each binary's signature chain (parallel)…`);
  const verified = await Promise.all(
    entries.map(async ({ platform, arch, url, bundleUrl }) => {
      info(`  → ${platform}/${arch}  ${url}`);
      const sha256 = await fetchAndHashAddon(http, url, {
        maxBinaryBytes,
        maxBinaryMs,
        label: `${platform}/${arch}`,
      });
      await verifyAttestation({
        sha256,
        bundleUrl,
        repo,
        runInvocationURI: runURI,
        sourceCommit: commit,
        sourceRef: ref,
        attestSignerPattern,
        trustMaterial,
        dispatcher: getGlobalDispatcher(),
      });
      info(`  ✓ ${platform}/${arch}  sha256=${sha256}`);
      return { platform, arch, entry: { url, bundleUrl, sha256 } satisfies AddonEntry };
    }),
  );
  info(`Done: ${verified.length} binary(ies) verified.`);

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
