// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Implementations of the two `slsa` subcommands, also reused by
 * {@link requireAddon}:
 * - {@link wget} — install-side. Reads `package.json` + manifest, verifies
 *   provenance, streams the platform-specific addon with size and
 *   zip-bomb guards, matches sha256, then renames into place.
 * - {@link pack} — publish-side. Gzips the built `.node` binary next to
 *   itself so the release workflow can upload `{addon.path}.gz`.
 *
 * Both commands operate on a `packageDir` (cwd for the CLI) and never
 * touch `process` directly — cancellation comes through `options.signal`.
 */

import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

import process from "node:process";

import dedent from "dedent";

import {
  ArchSchema,
  assertWithinDir,
  createHashPassthrough,
  DEFAULT_MANIFEST_PATH,
  DEFAULT_MAX_BINARY_BYTES,
  DEFAULT_MAX_BINARY_SECONDS,
  extractExpectedRepo,
  fetchWithRetry,
  log,
  PlatformSchema,
  readPackageJson,
  safeUnlink,
  SlsaManifestSchemaV1,
  verifyPackageAt,
  warn,
  type SlsaManifest,
  type VerifyOptions,
} from "@node-addon-slsa/internal";

/** Options for {@link pack}. */
export type PackOptions = {
  /** Cancellation for the gzip pipeline. Partial output is cleaned up on abort. */
  readonly signal?: AbortSignal | undefined;
};

async function readManifestFile(packageDir: string, manifestRel: string): Promise<SlsaManifest> {
  const raw = await readFile(resolve(packageDir, manifestRel), "utf8");
  return SlsaManifestSchemaV1.parse(JSON.parse(raw));
}

function resolveAddonEntry(manifest: SlsaManifest): { url: string; sha256: string } {
  const platform = PlatformSchema.safeParse(process.platform);
  const arch = ArchSchema.safeParse(process.arch);
  if (!platform.success || !arch.success) {
    throw new Error(`unsupported platform/arch: ${process.platform}/${process.arch}`);
  }
  const entry = manifest.addons[platform.data]?.[arch.data];
  if (!entry) {
    throw new Error(`manifest.addons has no entry for ${platform.data}/${arch.data}`);
  }
  return entry;
}

/**
 * Install-side flow for a published package. Steps, in order:
 * 1. Read `package.json`; skip entirely for the `0.0.0` local-dev sentinel.
 * 2. Derive the expected source repo from `package.json#repository`.
 * 3. Run {@link verifyPackageAt} to load and validate the SLSA manifest.
 * 4. Pick the `platform/arch` entry from `manifest.addons`.
 * 5. Stream the gzipped binary under wire- and decompressed-size caps.
 * 6. Compare the wire sha256 against the manifest, then verify Rekor.
 * 7. Atomically rename the temp file over `addon.path`.
 *
 * @throws {ProvenanceError} when manifest or Rekor verification fails.
 * @throws {Error} on malformed `package.json`, unsupported platform/arch,
 *   download / HTTP / decompression failure, or sha256 mismatch.
 */
export async function wget(packageDir: string, options?: VerifyOptions): Promise<void> {
  const { name, version, addon, repository } = await readPackageJson(packageDir);

  if (version === "0.0.0") {
    warn(dedent`
      version 0.0.0 detected — skipping provenance verification.
      Never publish 0.0.0 to the npm registry.
    `);
    return;
  }

  const expectedRepo = extractExpectedRepo(repository);
  if (!expectedRepo) {
    throw new Error(dedent`
      could not determine expected repository from package.json:
      set "repository" to a github.com URL (e.g. "https://github.com/owner/repo").
    `);
  }

  const provenance = await verifyPackageAt(packageDir, {
    repo: expectedRepo,
    ...options,
  });

  const manifest = await readManifestFile(packageDir, addon.manifest ?? DEFAULT_MANIFEST_PATH);
  const entry = resolveAddonEntry(manifest);

  const resolvedPkgDir = resolve(packageDir);
  const binaryPath = join(resolvedPkgDir, addon.path);
  assertWithinDir({ baseDir: resolvedPkgDir, target: binaryPath, label: "addon.path" });

  const addonDir = dirname(binaryPath);
  await mkdir(addonDir, { recursive: true });
  log(`package: ${name}@${version}`);
  log(`download: ${entry.url}`);

  const maxBytes = options?.maxBinaryBytes ?? DEFAULT_MAX_BINARY_BYTES;
  const maxSeconds = options?.maxBinarySeconds ?? DEFAULT_MAX_BINARY_SECONDS;
  const maxMs = maxSeconds * 1000;

  const tmpPath = join(addonDir, `.tmp-${randomBytes(8).toString("hex")}.node`);
  const { stream: hashStream, digest } = createHashPassthrough();

  try {
    const response = await fetchWithRetry(entry.url, {
      ...options,
      timeoutMs: maxMs,
      stallTimeoutMs: maxMs,
    });
    if (response.statusCode >= 400) {
      await response.body.dump();
      throw new Error(`download failed: ${entry.url}: ${response.statusCode}`);
    }
    const declared = Number(response.headers["content-length"] ?? 0);
    if (declared > maxBytes) {
      await response.body.dump();
      throw new Error(`download exceeds size cap: Content-Length=${declared} cap=${maxBytes}`);
    }

    // Compressed-bytes cap. Bounds the wire payload regardless of
    // Content-Length honesty, and also serves as the upper bound on what
    // feeds into the sha256 (which is computed over the gzip bytes).
    let seenWire = 0;
    // Decompressed-bytes cap. Defense against a hostile CDN serving a
    // zip-bomb: a 10 MB gzip can inflate to 100 GB, OOMing or filling the
    // user's disk before the sha256 mismatch fires. Cap decompressed
    // output at `maxBytes * DECOMPRESSION_RATIO_LIMIT` — native-addon
    // binaries don't compress much better than ~4× in practice.
    const DECOMPRESSION_RATIO_LIMIT = 8;
    const maxDecompressedBytes = maxBytes * DECOMPRESSION_RATIO_LIMIT;
    let seenPlain = 0;
    await pipeline(
      response.body,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          seenWire += chunk.length;
          if (seenWire > maxBytes) {
            throw new Error(`download exceeds size cap: seen=${seenWire} cap=${maxBytes}`);
          }
          yield chunk;
        }
      },
      hashStream,
      createGunzip(),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          seenPlain += chunk.length;
          if (seenPlain > maxDecompressedBytes) {
            throw new Error(
              `decompressed payload exceeds cap: seen=${seenPlain} cap=${maxDecompressedBytes}` +
                ` (possible zip-bomb; compressed=${seenWire})`,
            );
          }
          yield chunk;
        }
      },
      createWriteStream(tmpPath, { mode: 0o755, flags: "wx" }),
      options?.signal ? { signal: options.signal } : {},
    );

    const sha = digest();
    if (sha !== entry.sha256) {
      throw new Error(`download sha256 mismatch: manifest=${entry.sha256} actual=${sha}`);
    }

    await provenance.verifyAddonBySha256(sha);
    log(`verification passed for ${name}@${version}`);

    await rename(tmpPath, binaryPath);
  } catch (err: unknown) {
    await safeUnlink(tmpPath, "temp file");
    throw err;
  }
}

/**
 * Publish-side helper. Gzip-compresses `addon.path` from `package.json`
 * into `{addon.path}.gz`, overwriting any previous output. The release
 * workflow uploads the `.gz` and records its sha256 in the manifest.
 *
 * Filenames are not covered by provenance — download URLs are authored
 * by the publish workflow and verified via the manifest's sha256.
 *
 * @throws {Error} when `addon.path` escapes `packageDir`, the source
 *   cannot be read, or the gzip pipeline fails. Partial output is
 *   removed on failure.
 */
export async function pack(packageDir: string, options?: PackOptions): Promise<void> {
  const { version, addon } = await readPackageJson(packageDir);
  log(`packing addon v${version}`);

  const resolvedPkgDir = resolve(packageDir);
  const binaryPath = join(resolvedPkgDir, addon.path);
  assertWithinDir({ baseDir: resolvedPkgDir, target: binaryPath, label: "addon.path" });

  const packedFile = join(dirname(binaryPath), `${basename(binaryPath)}.gz`);
  assertWithinDir({ baseDir: resolvedPkgDir, target: packedFile, label: "packed output" });

  try {
    await pipeline(
      createReadStream(binaryPath),
      createGzip({ level: 9 }),
      createWriteStream(packedFile),
      options?.signal ? { signal: options.signal } : {},
    );
  } catch (err: unknown) {
    await safeUnlink(packedFile, "partial output");
    throw err;
  }
}
