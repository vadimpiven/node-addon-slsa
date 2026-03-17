// SPDX-License-Identifier: Apache-2.0 OR MIT

import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

import process from "node:process";

import dedent from "dedent";

import { extractExpectedRepo, readPackageJson } from "./package.ts";
import { fetchWithRetry } from "./download.ts";
import { assertWithinDir, safeUnlink } from "./util/fs.ts";
import { log, warn } from "./util/log.ts";
import { evalTemplate } from "./util/template.ts";
import type { SemVerString, VerifyOptions } from "./types.ts";
import { createHashPassthrough } from "./util/hash.ts";
import { verifyPackageProvenance } from "./verify/index.ts";

/** Build the template variables available for `addon.url`: `{version}`, `{platform}`, `{arch}`. */
function createTemplateVars(version: SemVerString): Record<string, string> {
  return { version, platform: process.platform, arch: process.arch };
}

/**
 * Downloads, verifies, and installs the native addon.
 *
 * @throws {ProvenanceError} if provenance verification fails.
 * @throws {Error} if the download or decompression fails.
 */
export async function wget(
  packageDir: string,
  options?: VerifyOptions & { signal?: AbortSignal },
): Promise<void> {
  const { name, version, addon, repository } = await readPackageJson(packageDir);

  // 0.0.0 is treated as a local/development placeholder — skip download and verification
  if (version === "0.0.0") {
    warn(dedent`
      version 0.0.0 detected — skipping provenance verification.
      Never publish 0.0.0 to npm registry.
    `);
    return;
  }

  const expectedRepo = extractExpectedRepo(repository);
  if (!expectedRepo) {
    throw new Error(dedent`
      could not determine expected repository from package.json:
      set repository to a github.com URL (e.g. "https://github.com/owner/repo")
    `);
  }

  const provenance = await verifyPackageProvenance({
    packageName: name,
    version,
    repo: expectedRepo,
    ...options,
  });

  const resolvedPkgDir = resolve(packageDir);
  const binaryPath = join(resolvedPkgDir, addon.path);
  assertWithinDir({ baseDir: resolvedPkgDir, target: binaryPath, label: "addon.path" });

  const downloadUrl = evalTemplate(addon.url, createTemplateVars(version));
  const addonDir = dirname(binaryPath);
  await mkdir(addonDir, { recursive: true });
  log(`package: ${name}@${version}`);

  // Stream: download → hash compressed bytes → decompress → write temp file.
  // The hash is computed over the compressed bytes because
  // actions/attest-build-provenance attests the .gz artifact
  // (the GitHub release asset), not the decompressed binary.
  // flags: "wx" (O_EXCL) fails if file exists, preventing symlink attacks.
  const tmpPath = join(addonDir, `.tmp-${randomBytes(8).toString("hex")}.node`);
  const { stream: hashStream, digest } = createHashPassthrough();

  try {
    await pipeline(
      await fetchWithRetry(downloadUrl, options).then((r) => {
        if (!r.ok) {
          r.body?.cancel().catch(() => {});
          throw new Error(`download failed: ${downloadUrl}: ${r.status} ${r.statusText}`);
        }
        if (!r.body) {
          throw new Error(`download failed: ${downloadUrl}: response body is empty`);
        }
        return Readable.fromWeb(r.body);
      }),
      hashStream,
      createGunzip(),
      createWriteStream(tmpPath, { mode: 0o755, flags: "wx" }),
      { signal: options?.signal },
    );

    await provenance.verifyAddon({ sha256: digest() });
    log(`verification passed`);

    await rename(tmpPath, binaryPath);
  } catch (err: unknown) {
    await safeUnlink(tmpPath, "temp file");
    throw err;
  }
}

/**
 * Gzip-compresses the native addon for distribution.
 */
export async function pack(packageDir: string, options?: { signal?: AbortSignal }): Promise<void> {
  const { version, addon } = await readPackageJson(packageDir);
  log(`packing addon v${version}`);

  const resolvedPkgDir = resolve(packageDir);
  const binaryPath = join(resolvedPkgDir, addon.path);
  assertWithinDir({ baseDir: resolvedPkgDir, target: binaryPath, label: "addon.path" });

  const addonDir = dirname(binaryPath);
  const packedName = basename(evalTemplate(addon.url, createTemplateVars(version)));
  const packedFile = join(addonDir, packedName);
  assertWithinDir({ baseDir: resolvedPkgDir, target: packedFile, label: "packed output" });

  try {
    await pipeline(
      createReadStream(binaryPath),
      createGzip({ level: 9 }),
      createWriteStream(packedFile),
      { signal: options?.signal },
    );
  } catch (err: unknown) {
    await safeUnlink(packedFile, "partial output");
    throw err;
  }
}
