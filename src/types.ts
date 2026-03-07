// SPDX-License-Identifier: Apache-2.0 OR MIT

import type { createVerifier } from "sigstore";

/** Sigstore bundle verifier created by `createVerifier()` from the `sigstore` package. */
export type BundleVerifier = Awaited<ReturnType<typeof createVerifier>>;

/** GitHub `owner/repo` slug. */
export type GitHubRepo = `${string}/${string}`;

/**
 * Strict semver string (no `v` prefix): `major.minor.patch[-pre][+build]`.
 * The template literal type is intentionally wider than the runtime check
 * in {@link semVerString} because TypeScript cannot express the full regex.
 */
export type SemVerString = `${number}.${number}.${number}${string}`;

/** Lowercase hex-encoded SHA-256 digest (64 characters). */
declare const __sha256HexBrand: unique symbol;
export type Sha256Hex = string & { readonly [__sha256HexBrand]: true };

/** GitHub Actions run invocation URL extracted from a Fulcio certificate. */
declare const __runInvocationURIBrand: unique symbol;
export type RunInvocationURI = string & {
  readonly [__runInvocationURIBrand]: true;
};

/** Shared with config.ts for Zod schema composition. */
export const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/;

/**
 * Validate and brand a lowercase hex-encoded SHA-256 digest.
 * @throws {TypeError} if the input is not exactly 64 hex characters.
 */
export function sha256Hex(value: string): Sha256Hex {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`invalid SHA-256 hex digest: ${value}`);
  }
  return value as Sha256Hex;
}

/**
 * Validate and narrow a semver string (no `v` prefix).
 * @throws {TypeError} if the input does not match `major.minor.patch[-pre][+build]`.
 */
export function semVerString(value: string): SemVerString {
  if (!SEMVER_RE.test(value)) {
    throw new TypeError(`invalid semver string: ${value}`);
  }
  return value as SemVerString;
}

/**
 * Validate and narrow a GitHub `owner/repo` slug.
 * @throws {TypeError} if the input is not in `owner/repo` format.
 */
export function githubRepo(value: string): GitHubRepo {
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(value)) {
    throw new TypeError(`invalid GitHub repo: ${value}`);
  }
  return value as GitHubRepo;
}

/**
 * Validate and brand a GitHub Actions run invocation URI.
 * @throws {TypeError} if the input does not match the expected URL format.
 */
export function runInvocationURI(value: string): RunInvocationURI {
  if (
    !/^https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/actions\/runs\/\d+\/attempts\/\d+$/.test(
      value,
    )
  ) {
    throw new TypeError(`invalid run invocation URI: ${value}`);
  }
  return value as RunInvocationURI;
}

/** Options for {@link fetchWithRetry}. */
export interface FetchOptions {
  /** Per-request timeout in ms. @default 30_000 */
  readonly timeoutMs?: number | undefined;
  /** Stall timeout: abort if no data for this long. @default 30_000 */
  readonly stallTimeoutMs?: number | undefined;
  /** Retries after initial attempt. @default 2 */
  readonly retryCount?: number | undefined;
  /** Base delay for exponential backoff in ms. @default 500 */
  readonly retryBaseMs?: number | undefined;
  /** AbortSignal for cooperative cancellation. */
  readonly signal?: AbortSignal | undefined;
  /** Custom HTTP headers for fetch requests. */
  readonly headers?: Record<string, string> | undefined;
}

/**
 * Optional per-call transport overrides.
 * All fields have sensible defaults — pass only what you need.
 */
export interface VerifyOptions extends FetchOptions {
  /** Upper bound for attestation bundle size in bytes. @default 52_428_800 (50 MB) */
  readonly maxBundleBytes?: number | undefined;
  /** Upper bound for JSON API response size in bytes. @default 52_428_800 (50 MB) */
  readonly maxJsonResponseBytes?: number | undefined;
  /** Max concurrent bundle_url fetches. @default 5 */
  readonly resolveConcurrency?: number | undefined;
  /** Pre-created sigstore verifier. Created automatically if not provided. */
  readonly verifier?: BundleVerifier | undefined;
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

  describe("sha256Hex", () => {
    it("accepts valid 64-char hex string", ({ expect }) => {
      const hash = "a".repeat(64);
      expect(sha256Hex(hash)).toBe(hash);
    });

    it("rejects uppercase hex", ({ expect }) => {
      expect(() => sha256Hex("A".repeat(64))).toThrow(TypeError);
    });

    it("rejects empty string", ({ expect }) => {
      expect(() => sha256Hex("")).toThrow(TypeError);
    });

    it("rejects 63-char hex (off-by-one short)", ({ expect }) => {
      expect(() => sha256Hex("a".repeat(63))).toThrow(TypeError);
    });

    it("rejects 65-char hex (off-by-one long)", ({ expect }) => {
      expect(() => sha256Hex("a".repeat(65))).toThrow(TypeError);
    });
  });

  describe("semVerString", () => {
    it("accepts valid semver", ({ expect }) => {
      expect(semVerString("1.2.3")).toBe("1.2.3");
    });

    it("accepts semver with prerelease", ({ expect }) => {
      expect(semVerString("1.0.0-beta.1")).toBe("1.0.0-beta.1");
    });

    it("accepts semver with build metadata", ({ expect }) => {
      expect(semVerString("1.0.0+build.123")).toBe("1.0.0+build.123");
    });

    it("accepts prerelease + build combined", ({ expect }) => {
      expect(semVerString("1.0.0-beta.1+build.123")).toBe("1.0.0-beta.1+build.123");
    });

    it("rejects v-prefixed version", ({ expect }) => {
      expect(() => semVerString("v1.2.3")).toThrow(TypeError);
    });

    it("rejects partial version", ({ expect }) => {
      expect(() => semVerString("1.2")).toThrow(TypeError);
    });
  });

  describe("githubRepo", () => {
    it("accepts valid owner/repo", ({ expect }) => {
      expect(githubRepo("owner/repo")).toBe("owner/repo");
    });

    it("accepts dots and hyphens", ({ expect }) => {
      expect(githubRepo("my-org/my.repo")).toBe("my-org/my.repo");
    });

    it("rejects missing owner", ({ expect }) => {
      expect(() => githubRepo("/repo")).toThrow(TypeError);
    });

    it("rejects nested path", ({ expect }) => {
      expect(() => githubRepo("owner/repo/extra")).toThrow(TypeError);
    });

    it("rejects empty string", ({ expect }) => {
      expect(() => githubRepo("")).toThrow(TypeError);
    });

    it("rejects missing repo name", ({ expect }) => {
      expect(() => githubRepo("owner/")).toThrow(TypeError);
    });
  });

  describe("runInvocationURI", () => {
    it("accepts valid GitHub Actions run URI", ({ expect }) => {
      const uri = "https://github.com/owner/repo/actions/runs/123/attempts/1";
      expect(runInvocationURI(uri)).toBe(uri);
    });

    it("rejects non-GitHub URL", ({ expect }) => {
      expect(() =>
        runInvocationURI("https://gitlab.com/owner/repo/actions/runs/1/attempts/1"),
      ).toThrow(TypeError);
    });

    it("rejects missing attempts segment", ({ expect }) => {
      expect(() => runInvocationURI("https://github.com/owner/repo/actions/runs/123")).toThrow(
        TypeError,
      );
    });

    it("rejects empty string", ({ expect }) => {
      expect(() => runInvocationURI("")).toThrow(TypeError);
    });
  });
}
