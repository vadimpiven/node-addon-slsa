// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Publish-side verifier for `publish.yaml`. Runs the sigstore chain on
 * in-memory `(descriptor, bundle)` pairs from a sibling matrix job's
 * artifact, then HEAD-checks each release asset. Emits the SLSA manifest
 * JSON for the workflow to embed in the tarball.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { getInput, info, setFailed, setOutput } from "@actions/core";
import { getGlobalDispatcher } from "undici";

import {
  AddonDescriptorSchema,
  SLSA_MANIFEST_V1_SCHEMA_URL,
  buildAddonInventory,
  errorMessage,
  getDefaultAttestSignerPattern,
  isEnoent,
  loadTrustMaterial,
  normalizeHttpsPrefix,
  requireEnv,
  verifyAttestationFromBundle,
  type AddonDescriptor,
  type AddonEntry,
  type SerializedBundle,
  type SlsaManifest,
} from "@node-addon-slsa/internal";

type LoadedDescriptor = {
  readonly descriptor: AddonDescriptor;
  readonly bundle: SerializedBundle;
  readonly descriptorPath: string;
};

async function loadDescriptors(dir: string): Promise<LoadedDescriptor[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const descriptorFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".slsa.json"))
    .map((e) => join(e.parentPath, e.name));
  if (descriptorFiles.length === 0) {
    throw new Error(
      `no *.slsa.json descriptor files found under ${dir} — make sure ` +
        `'attest-addon.yaml' ran for at least one matrix cell and that the ` +
        `publish step downloaded 'slsa-addons-*' artifacts with merge-multiple: true.`,
    );
  }
  const loaded: LoadedDescriptor[] = [];
  for (const descriptorPath of descriptorFiles) {
    const descriptorRaw = await readFile(descriptorPath, "utf8");
    const descriptor = AddonDescriptorSchema.parse(JSON.parse(descriptorRaw));
    const bundlePath = descriptorPath.slice(0, -".slsa.json".length);
    let bundleRaw: string;
    try {
      bundleRaw = await readFile(bundlePath, "utf8");
    } catch (err) {
      if (isEnoent(err)) {
        throw new Error(
          `descriptor ${basename(descriptorPath)} has no sibling bundle at ` +
            `${basename(bundlePath)} — the matching '.sigstore' file was not ` +
            `present in the downloaded artifact.`,
        );
      }
      throw new Error(
        `failed to read sibling bundle for ${basename(descriptorPath)} at ` +
          `${basename(bundlePath)}: ${errorMessage(err)}`,
      );
    }
    const bundle = JSON.parse(bundleRaw) as SerializedBundle;
    loaded.push({ descriptor, bundle, descriptorPath });
  }
  return loaded;
}

function assertUrlsUnderPrefix(descriptor: AddonDescriptor, normalizedPrefix: string): void {
  for (const [field, value] of [
    ["url", descriptor.url],
    ["bundleUrl", descriptor.bundleUrl],
  ] as const) {
    if (!value.startsWith(normalizedPrefix)) {
      throw new Error(
        `descriptor ${descriptor.platform}/${descriptor.arch} ${field} '${value}' ` +
          `does not start with release-base-url '${normalizedPrefix}'`,
      );
    }
  }
}

// Silent overwrite would mask a poisoned descriptor.
function assertNoDuplicates(loaded: ReadonlyArray<LoadedDescriptor>): void {
  const seen = new Set<string>();
  for (const { descriptor } of loaded) {
    const key = `${descriptor.platform}/${descriptor.arch}`;
    if (seen.has(key)) throw new Error(`duplicate descriptor for ${key}`);
    seen.add(key);
  }
}

// `fetch` follows redirects by default — required to chase the GH
// releases → S3 signed URL.
async function checkUrlReachable(url: string, label: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { method: "HEAD" });
  } catch (err) {
    throw new Error(`${label}: release asset not reachable at ${url}: ${errorMessage(err)}`);
  }
  if (res.ok) return;
  if (res.status === 403) {
    throw new Error(
      `${label}: release asset not reachable at ${url}: HEAD returned 403 — ` +
        `asset exists but is inaccessible (private repo, expired URL, or upload still finalizing).`,
    );
  }
  if (res.status === 404) {
    throw new Error(
      `${label}: release asset not reachable at ${url}: HEAD returned 404 — ` +
        `asset was not uploaded (the release-upload step in attest-addon.yaml may have failed).`,
    );
  }
  throw new Error(`${label}: release asset not reachable at ${url}: HEAD returned ${res.status}`);
}

export async function main(): Promise<void> {
  const packageName = getInput("package-name", { required: true });
  const descriptorsDir = getInput("descriptors-dir", { required: true });
  const releaseBaseUrl = getInput("release-base-url", { required: true });

  if (!releaseBaseUrl.startsWith("https://")) {
    throw new Error(`release-base-url must start with https://, got: ${releaseBaseUrl}`);
  }
  const normalizedPrefix = normalizeHttpsPrefix(releaseBaseUrl);

  const repo = requireEnv("GITHUB_REPOSITORY");
  const commit = requireEnv("GITHUB_SHA");
  const ref = requireEnv("GITHUB_REF");
  const runId = requireEnv("GITHUB_RUN_ID");
  const runAttempt = requireEnv("GITHUB_RUN_ATTEMPT");
  const runURI = `https://github.com/${repo}/actions/runs/${runId}/attempts/${runAttempt}`;

  if (!ref.startsWith("refs/tags/")) {
    throw new Error(`GITHUB_REF must start with refs/tags/, got: ${ref}`);
  }

  info(`Loading descriptors from ${descriptorsDir}…`);
  const loaded = await loadDescriptors(descriptorsDir);
  for (const item of loaded) assertUrlsUnderPrefix(item.descriptor, normalizedPrefix);
  assertNoDuplicates(loaded);

  info(`Verifying ${loaded.length} addon binary(ies) for ${packageName}.`);
  info(`  repo:    ${repo}`);
  info(`  ref:     ${ref}`);
  info(`  commit:  ${commit}`);
  info(`  signer:  toolkit reusable workflow attest-addon.yaml`);

  info(`[1/3] Loading Sigstore trust material (TUF root)…`);
  const trustMaterial = await loadTrustMaterial();
  info(`  ✓ loaded`);

  const attestSignerPattern = getDefaultAttestSignerPattern();

  info(`[2/3] Verifying each binary's signature chain (parallel, in-memory)…`);
  const verified = await Promise.all(
    loaded.map(async ({ descriptor, bundle }) => {
      const { platform, arch, url, bundleUrl, sha256 } = descriptor;
      info(`  → ${platform}/${arch}  ${url}`);
      await verifyAttestationFromBundle({
        sha256,
        bundle,
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

  info(`[3/3] HEAD reachability smoke check on each release asset…`);
  await Promise.all(
    loaded.flatMap(({ descriptor }) => [
      checkUrlReachable(descriptor.url, `${descriptor.platform}/${descriptor.arch} url`),
      checkUrlReachable(
        descriptor.bundleUrl,
        `${descriptor.platform}/${descriptor.arch} bundleUrl`,
      ),
    ]),
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

if (!process.env["VITEST"]) {
  try {
    await main();
  } catch (error: unknown) {
    setFailed(errorMessage(error));
  }
}
