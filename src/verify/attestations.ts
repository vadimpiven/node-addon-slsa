// SPDX-License-Identifier: Apache-2.0 OR MIT

import process from "node:process";

import { snappyUncompress } from "hysnappy";
import dedent from "dedent";

import type { SerializedBundle } from "@sigstore/bundle";

import { fetchWithTimeout, readJsonBounded } from "../download.ts";
import type { GitHubRepo, SemVerString, Sha256Hex } from "../types.ts";
import { log } from "../util/log.ts";
import { ProvenanceError } from "../util/provenance-error.ts";
import { evalTemplate } from "../util/template.ts";
import type { ResolvedConfig } from "./config.ts";
import { GITHUB_ATTESTATIONS_URL, MAX_BUNDLE_BYTES, NPM_ATTESTATIONS_URL } from "./constants.ts";
import { BundleSchema, GitHubAttestationsApiSchema, NpmAttestationsSchema } from "./schemas.ts";

import type { GitHubAttestations, NpmAttestations } from "./schemas.ts";

/**
 * Like Promise.allSettled but limits the number of concurrent tasks.
 * N workers drain a shared queue; each worker shifts one index,
 * awaits the task, then shifts the next.
 */
async function mapSettled<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = Array.from({ length: items.length });
  const queue = items.map((_, i) => i);
  const worker = async () => {
    let i: number | undefined;
    while ((i = queue.shift()) != null) {
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]!) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/**
 * Reads the uncompressed length from the start of a Snappy-compressed block.
 *
 * Snappy prepends the uncompressed length as a little-endian base-128 varint
 * (same encoding as protobuf). Each byte stores 7 data bits in [6:0] and a
 * continuation flag in bit 7. At most 5 bytes (35 bits) are consumed.
 *
 * hysnappy requires this length upfront for WASM memory pre-allocation.
 *
 * @see https://github.com/google/snappy/blob/main/format_description.txt
 * @see https://en.wikipedia.org/wiki/LEB128
 * @throws {Error} if the uncompressed length exceeds MAX_BUNDLE_BYTES.
 * @throws {Error} if the varint header is truncated or malformed.
 */
export function readSnappyUncompressedLength(
  data: Uint8Array,
  maxBytes: number = MAX_BUNDLE_BYTES,
): number {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < Math.min(data.length, 5); i++) {
    const byte = data[i]!;
    result |= (byte & 0x7f) << shift; // accumulate 7 data bits
    if ((byte & 0x80) === 0) {
      result >>>= 0; // coerce to unsigned 32-bit
      if (result > maxBytes) {
        throw new Error(dedent`
          attestation bundle too large:
          ${result} bytes exceeds ${maxBytes} byte limit
        `);
      }
      return result; // no continuation flag → done
    }
    shift += 7;
  }
  throw new Error(dedent`
    failed to decompress attestation bundle: the data appears corrupt.
    This may be a transient issue — try again.
    If it persists, report it to the package maintainer.
  `);
}

/**
 * Fetch npm package attestations from the npm registry.
 *
 * @throws {ProvenanceError} if no attestation exists (HTTP 404).
 * @throws {Error} if the HTTP request fails for other reasons.
 */
export async function fetchNpmAttestations(
  { packageName, version }: { packageName: string; version: SemVerString },
  config: ResolvedConfig,
): Promise<NpmAttestations> {
  const url = evalTemplate(NPM_ATTESTATIONS_URL, {
    name: encodeURIComponent(packageName),
    version: encodeURIComponent(version),
  });
  log(`npm attestations: ${url}`);
  const response = await fetchWithTimeout(url, undefined, config);
  if (response.status === 404) {
    await response.body?.cancel();
    throw new ProvenanceError(
      dedent`
        No provenance attestation found on npm for ${packageName}@${version}.
        The package may have been published without provenance or tampered with.
      `,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(dedent`
      failed to fetch npm attestations: ${response.status} ${response.statusText}.
      Check your network connection and verify that ${packageName}@${version} exists on npm.
    `);
  }
  return NpmAttestationsSchema.parse(await readJsonBounded(response, config.maxJsonResponseBytes));
}

/**
 * Fetch attestation bundles from the GitHub Attestations API.
 * Returns full sigstore SerializedBundle objects created by
 * actions/attest-build-provenance, suitable for cryptographic
 * verification via createVerifier.
 *
 * Public repos do not require authentication.
 *
 * @throws {ProvenanceError} if no attestation is found for the artifact hash.
 * @throws {Error} on rate limiting, authentication failure, or other HTTP errors.
 */
export async function fetchGitHubAttestations(
  { repo, sha256 }: { repo: GitHubRepo; sha256: Sha256Hex },
  config: ResolvedConfig,
): Promise<GitHubAttestations> {
  const url = evalTemplate(GITHUB_ATTESTATIONS_URL, {
    repo,
    hash: sha256,
  });
  log(`GitHub attestations: ${url}`);
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env["GITHUB_TOKEN"];
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const response = await fetchWithTimeout(url, { headers }, config);

  // Rate-limit: 403 with exhausted quota, or 429
  if (
    (response.status === 403 && response.headers.get("X-RateLimit-Remaining") === "0") ||
    response.status === 429
  ) {
    await response.body?.cancel();
    const hint = token
      ? `rate limit exhausted — wait and retry`
      : `set GITHUB_TOKEN to increase rate limits`;
    throw new Error(`GitHub API rate limit exceeded: ${hint}`);
  }

  const noAttestationMsg = dedent`
    No provenance attestation found on GitHub for artifact hash ${sha256}.
    The artifact may have been tampered with.
  `;

  if (response.status === 404) {
    await response.body?.cancel();
    const msg = token
      ? noAttestationMsg
      : dedent`
          ${noAttestationMsg}
          If this is a private repository, set GITHUB_TOKEN for authenticated access.
        `;
    throw new ProvenanceError(msg);
  }
  if (response.status === 401) {
    await response.body?.cancel();
    throw new Error(`GitHub API authentication failed — check that GITHUB_TOKEN is valid`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(dedent`
      failed to fetch GitHub attestations: ${response.status} ${response.statusText}.
      If this persists, verify the repository field in package.json and try again.
    `);
  }

  const apiResponse = GitHubAttestationsApiSchema.parse(
    await readJsonBounded(response, config.maxJsonResponseBytes),
  );

  if (apiResponse.attestations.length === 0) {
    throw new ProvenanceError(noAttestationMsg);
  }

  // Resolve all attestations in parallel: use inline bundle if present,
  // otherwise fetch from bundle_url (Snappy-compressed protobuf-JSON).
  const { maxBundleBytes, resolveConcurrency } = config;
  const resolveBundle = async (
    attestation: (typeof apiResponse.attestations)[number],
  ): Promise<SerializedBundle> => {
    if (attestation.bundle) return attestation.bundle;
    const response = await fetchWithTimeout(attestation.bundle_url!, undefined, config);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(dedent`
        failed to fetch attestation bundle from ${attestation.bundle_url}:
        ${response.status} ${response.statusText}
      `);
    }
    const clHeader = response.headers.get("Content-Length");
    if (clHeader != null) {
      const contentLength = Number(clHeader);
      if (contentLength > maxBundleBytes) {
        await response.body?.cancel();
        throw new Error(dedent`
          attestation bundle too large:
          ${contentLength} bytes exceeds ${maxBundleBytes} byte limit
        `);
      }
    }
    const compressed = new Uint8Array(await response.arrayBuffer());
    if (compressed.byteLength > maxBundleBytes) {
      throw new Error(dedent`
        attestation bundle too large:
        ${compressed.byteLength} bytes exceeds ${maxBundleBytes} byte limit
      `);
    }
    const uncompressedLen = readSnappyUncompressedLength(compressed, maxBundleBytes);
    const decompressed = snappyUncompress(compressed, uncompressedLen);
    const json = new TextDecoder().decode(decompressed);
    return BundleSchema.parse(JSON.parse(json));
  };

  const results = await mapSettled(apiResponse.attestations, resolveBundle, resolveConcurrency);
  const resolved: GitHubAttestations = { attestations: [] };
  for (const result of results) {
    if (result.status === "fulfilled") {
      resolved.attestations.push({ bundle: result.value });
    } else {
      log(`failed to resolve attestation bundle: ${result.reason}`);
    }
  }

  if (resolved.attestations.length === 0) {
    throw new ProvenanceError(noAttestationMsg);
  }

  log(`resolved ${resolved.attestations.length} attestation bundle(s)`);
  return resolved;
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

  describe("readSnappyUncompressedLength", () => {
    it("parses single-byte varint", ({ expect }) => {
      expect(readSnappyUncompressedLength(new Uint8Array([0x0a]))).toBe(10);
    });

    it("parses multi-byte varint", ({ expect }) => {
      // 300 = 0b100101100 → varint bytes: 0xAC 0x02
      expect(readSnappyUncompressedLength(new Uint8Array([0xac, 0x02]))).toBe(300);
    });

    it("throws on truncated varint", ({ expect }) => {
      // 5 continuation bytes with no termination
      expect(() =>
        readSnappyUncompressedLength(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80])),
      ).toThrow("data appears corrupt");
    });
  });

  describe("mapSettled", () => {
    it("limits concurrency to the specified cap", async ({ expect }) => {
      let peak = 0;
      let running = 0;
      const results = await mapSettled(
        [1, 2, 3, 4, 5],
        async (n) => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((r) => globalThis.setTimeout(r, 10));
          running--;
          return n * 2;
        },
        2,
      );
      expect(peak).toBeLessThanOrEqual(2);
      expect(results.map((r) => (r as PromiseFulfilledResult<number>).value)).toEqual([
        2, 4, 6, 8, 10,
      ]);
    });

    it("captures rejections without aborting other tasks", async ({ expect }) => {
      const results = await mapSettled(
        [1, 2, 3],
        async (n) => {
          if (n === 2) throw new Error("fail");
          return n;
        },
        3,
      );
      expect(results[0]!.status).toBe("fulfilled");
      expect(results[1]!.status).toBe("rejected");
      expect(results[2]!.status).toBe("fulfilled");
    });
  });
}
