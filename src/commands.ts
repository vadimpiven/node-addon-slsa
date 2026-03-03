// SPDX-License-Identifier: Apache-2.0 OR MIT

import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

import process from "node:process";

import { extractExpectedRepo, readPackageJson } from "./config.ts";
import { createHashPassthrough, fetchStream } from "./download.ts";
import { assertWithinDir, isEnoent } from "./util/fs.ts";
import { evalTemplate } from "./util/template.ts";
import { verifyBinaryProvenance, verifyNpmProvenance } from "./verify.ts";

function createTemplateVars(version: string): Record<string, string> {
  return { version, platform: process.platform, arch: process.arch };
}

/**
 * Download, verify, and install the native binary.
 */
export async function wget(packageDir: string): Promise<void> {
  const { name, version, addon, repository } = await readPackageJson(packageDir);

  const expectedRepo = extractExpectedRepo(repository);
  if (!expectedRepo) {
    throw new Error("Could not determine expected repository from package.json");
  }

  const resolvedPkgDir = resolve(packageDir);
  const binaryPath = join(resolvedPkgDir, addon.path);
  assertWithinDir(resolvedPkgDir, binaryPath, "addon.path");
  const addonDir = dirname(binaryPath);
  const downloadUrl = evalTemplate(addon.url, createTemplateVars(version));

  await mkdir(addonDir, { recursive: true });

  // Skip download for development version
  if (version === "0.0.0") return;

  const runInvocationURI = await verifyNpmProvenance(name, version, expectedRepo);

  // Stream: download → hash compressed bytes → decompress → write temp file.
  // The hash is computed over the compressed bytes because
  // actions/attest-build-provenance attests the .gz artifact
  // (the GitHub release asset), not the decompressed binary.
  // flags: "wx" (O_EXCL) fails if file exists, preventing symlink attacks.
  const tmpPath = join(addonDir, `.tmp-${randomBytes(8).toString("hex")}.node`);
  const { stream: hashStream, digest } = createHashPassthrough();

  try {
    await pipeline(
      await fetchStream(downloadUrl),
      hashStream,
      createGunzip(),
      createWriteStream(tmpPath, { mode: 0o700, flags: "wx" }),
    );

    await verifyBinaryProvenance(digest(), runInvocationURI, expectedRepo);

    await rename(tmpPath, binaryPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch (unlinkErr) {
      if (!isEnoent(unlinkErr)) {
        console.error("Failed to clean up temp file:", unlinkErr);
      }
    }
    throw err;
  }
}

/**
 * Gzip compress the native binary for distribution.
 */
export async function pack(packageDir: string): Promise<void> {
  const { version, addon } = await readPackageJson(packageDir);

  const resolvedPkgDir = resolve(packageDir);
  const binaryPath = join(resolvedPkgDir, addon.path);
  assertWithinDir(resolvedPkgDir, binaryPath, "addon.path");
  const addonDir = dirname(binaryPath);
  const packedName = basename(evalTemplate(addon.url, createTemplateVars(version)));
  const packedFile = join(addonDir, packedName);
  assertWithinDir(resolvedPkgDir, packedFile, "packed output");

  await pipeline(
    createReadStream(binaryPath),
    createGzip({ level: 9 }),
    createWriteStream(packedFile),
  );
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

  describe("wget", () => {
    it("skips verification for version 0.0.0", async ({ expect }) => {
      const { access } = await import("node:fs/promises");
      const { tempDir } = await import("./util/fs.ts");

      const { writeTestPkg } = await import("../tests/fixtures.ts");
      await using tmp = await tempDir();
      await writeTestPkg(tmp.path, "0.0.0");

      await wget(tmp.path);

      // dist/ created but no binary downloaded
      await expect(access(join(tmp.path, "dist"))).resolves.toBeUndefined();
      await expect(access(join(tmp.path, "dist", "node_reqwest.node"))).rejects.toThrow();
    });
  });

  describe("pack", () => {
    it("gzip compresses binary and produces valid archive", async ({ expect }) => {
      const { readFile, writeFile } = await import("node:fs/promises");
      const { promisify } = await import("node:util");
      const { gunzip } = await import("node:zlib");
      const gunzipAsync = promisify(gunzip);
      const { tempDir } = await import("./util/fs.ts");

      const { FAKE_BINARY, writeTestPkg } = await import("../tests/fixtures.ts");
      await using tmp = await tempDir();
      const distDir = join(tmp.path, "dist");
      await mkdir(distDir, { recursive: true });

      await writeFile(join(distDir, "node_reqwest.node"), FAKE_BINARY);

      await writeTestPkg(tmp.path, "1.0.0");

      await pack(tmp.path);

      const platform = process.platform;
      const arch = process.arch;
      const packedPath = join(distDir, `node_reqwest-v1.0.0-${platform}-${arch}.node.gz`);
      const compressed = await readFile(packedPath);
      const decompressed = await gunzipAsync(compressed);

      expect(decompressed).toEqual(FAKE_BINARY);
    });
  });
}
