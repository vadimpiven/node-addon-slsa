// SPDX-License-Identifier: Apache-2.0 OR MIT

import { createReadStream } from "node:fs";
import { glob, stat, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";

import { DefaultArtifactClient } from "@actions/artifact";
import { attestProvenance } from "@actions/attest";
import { getInput, info, setFailed, setOutput } from "@actions/core";

import {
  AddonArtifactUrlSchema,
  AddonDescriptorSchema,
  ArchSchema,
  PlatformSchema,
  createHashPassthrough,
  errorMessage,
  type AddonDescriptor,
} from "@node-addon-slsa/internal";

function readPositiveIntInput(name: string, fallback: number): number {
  const raw = getInput(name);
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`input '${name}' must be a positive integer, got: ${raw}`);
  }
  return n;
}

async function resolveSingleBinary(pattern: string): Promise<string> {
  const matches = await Array.fromAsync(glob(pattern));
  if (matches.length === 0) throw new Error(`binary glob '${pattern}' matched no files`);
  if (matches.length > 1) {
    throw new Error(
      `binary glob '${pattern}' matched ${matches.length} files; require exactly one`,
    );
  }
  return matches[0]!;
}

async function streamHashWithCap(
  path: string,
  cap: number,
): Promise<{ sha256: string; size: number }> {
  const { size } = await stat(path);
  if (size > cap) throw new Error(`binary ${path} is ${size} bytes, exceeds cap ${cap}`);
  const { stream, digest } = createHashPassthrough();
  await pipeline(
    createReadStream(path),
    stream,
    new Writable({
      write(_c, _e, cb) {
        cb();
      },
    }),
  );
  return { sha256: digest(), size };
}

export async function main(): Promise<void> {
  const binaryGlob = getInput("binary", { required: true });
  const urlPrefix = getInput("url-prefix", { required: true });
  const token = getInput("github-token", { required: true });
  const maxBinaryBytes = readPositiveIntInput("max-binary-bytes", 268_435_456);
  const retentionDays = readPositiveIntInput("descriptor-retention-days", 14);

  if (!urlPrefix.startsWith("https://")) {
    throw new Error(`url-prefix must start with https://, got: ${urlPrefix}`);
  }
  const normalizedPrefix = urlPrefix.endsWith("/") ? urlPrefix : `${urlPrefix}/`;

  const platformParsed = PlatformSchema.safeParse(process.platform);
  if (!platformParsed.success) {
    throw new Error(
      `unsupported process.platform '${process.platform}'; supported: darwin, linux, win32`,
    );
  }
  const archParsed = ArchSchema.safeParse(process.arch);
  if (!archParsed.success) {
    throw new Error(`unsupported process.arch '${process.arch}'; supported: x64, arm64, arm, ia32`);
  }
  const platform = platformParsed.data;
  const arch = archParsed.data;

  const binaryPath = await resolveSingleBinary(binaryGlob);
  info(`Resolved binary: ${binaryPath}`);

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

  const { sha256, size } = await streamHashWithCap(binaryPath, maxBinaryBytes);
  info(`Hashed ${size} bytes: sha256=${sha256}`);

  info(`Minting sigstore bundle for ${url} on public-good Sigstore...`);
  const result = await attestProvenance({
    subjects: [{ name: url, digest: { sha256 } }],
    token,
    sigstore: "public-good",
  });
  info(`Attestation id: ${result.attestationID ?? "(unknown)"}`);

  // Pretty-print the sigstore bundle so auditors can diff sidecars by eye.
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
  await artifactClient.uploadArtifact(artifactName, [descriptorPath], dirname(descriptorPath), {
    retentionDays,
  });
  info(`Uploaded descriptor artifact '${artifactName}' (retention ${retentionDays}d).`);

  setOutput("platform", platform);
  setOutput("arch", arch);
  setOutput("binary-path", binaryPath);
  setOutput("bundle-path", bundlePath);
  setOutput("descriptor-path", descriptorPath);
  setOutput("url", url);
  setOutput("bundle-url", bundleUrl);
  setOutput("sha256", sha256);
}

if (!process.env["VITEST"]) {
  try {
    await main();
  } catch (error) {
    setFailed(errorMessage(error));
  }
}
