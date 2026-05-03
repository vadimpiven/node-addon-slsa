// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Hash one `.node.gz`, mint a public-good sigstore bundle, ship the
 * descriptor + bundle as `slsa-addons-<platform>-<arch>` for `publish.yaml`.
 */

import { writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { DefaultArtifactClient } from "@actions/artifact";
import { attestProvenance } from "@actions/attest";
import { getInput, info, setFailed, setOutput } from "@actions/core";

import {
  AddonArtifactUrlSchema,
  AddonDescriptorSchema,
  ArchSchema,
  PlatformSchema,
  errorMessage,
  hashFileSha256,
  normalizeHttpsPrefix,
  readPositiveIntInput,
  type AddonDescriptor,
} from "@node-addon-slsa/internal";

export async function main(): Promise<void> {
  const binaryPath = getInput("binary-path", { required: true });
  const urlPrefix = getInput("url-prefix", { required: true });
  const token = getInput("github-token", { required: true });
  const platformInput = getInput("platform", { required: true });
  const archInput = getInput("arch", { required: true });
  const maxBinaryBytes = readPositiveIntInput("max-binary-bytes", 268_435_456);
  const retentionDays = readPositiveIntInput("descriptor-retention-days", 14);

  const normalizedPrefix = normalizeHttpsPrefix(urlPrefix, { label: "url-prefix" });

  const platformParsed = PlatformSchema.safeParse(platformInput);
  if (!platformParsed.success) {
    throw new Error(
      `unsupported platform '${platformInput}'; supported: ${PlatformSchema.options.join(", ")}`,
    );
  }
  const archParsed = ArchSchema.safeParse(archInput);
  if (!archParsed.success) {
    throw new Error(`unsupported arch '${archInput}'; supported: ${ArchSchema.options.join(", ")}`);
  }
  const platform = platformParsed.data;
  const arch = archParsed.data;

  info(`Binary: ${binaryPath}`);
  info(`Target: ${platform}/${arch}`);

  const baseName = basename(binaryPath);
  const url = `${normalizedPrefix}${baseName}`;
  const bundlePath = `${binaryPath}.sigstore`;
  const bundleUrl = `${url}.sigstore`;
  const descriptorPath = `${bundlePath}.slsa.json`;

  const urlCheck = AddonArtifactUrlSchema.safeParse(url);
  if (!urlCheck.success) {
    throw new Error(
      `derived url '${url}' is not a valid addon artifact URL ` +
        `(must be https:// and end in .node.gz): ${urlCheck.error.message}`,
    );
  }

  const { sha256, size } = await hashFileSha256(binaryPath, { sizeCap: maxBinaryBytes });
  info(`Hashed ${size} bytes: sha256=${sha256}`);

  info(`Minting sigstore bundle for ${url} on public-good Sigstore…`);
  const result = await attestProvenance({
    subjects: [{ name: url, digest: { sha256 } }],
    token,
    sigstore: "public-good",
  });
  info(`  ✓ minted (attestation id: ${result.attestationID ?? "unknown"})`);

  // Pretty-print so auditors can diff sidecars by eye.
  await writeFile(bundlePath, JSON.stringify(result.bundle, null, 2));
  info(`Wrote bundle: ${bundlePath}`);

  const descriptor: AddonDescriptor = AddonDescriptorSchema.parse({
    platform,
    arch,
    url,
    bundleUrl,
    sha256,
  });
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  info(`Wrote descriptor: ${descriptorPath}`);

  const artifactName = `slsa-addons-${platform}-${arch}`;
  const artifactClient = new DefaultArtifactClient();
  info(`Uploading workflow artifact '${artifactName}'…`);
  await artifactClient.uploadArtifact(
    artifactName,
    [descriptorPath, bundlePath],
    dirname(descriptorPath),
    { retentionDays },
  );
  info(`  ✓ uploaded (retention ${retentionDays}d)`);

  setOutput("binary-path", binaryPath);
  setOutput("bundle-path", bundlePath);
}

if (!process.env["VITEST"]) {
  try {
    await main();
  } catch (error) {
    setFailed(errorMessage(error));
  }
}
