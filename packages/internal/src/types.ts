// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Branded types, runtime validators, and option interfaces.
 * Public surface takes plain strings; branded types live under `/internal`
 * for workspace code (verify-addons, CLI) and fork tooling.
 */

import type { SerializedBundle } from "@sigstore/bundle";
import type { TrustMaterial } from "@sigstore/verify";
import type { Dispatcher } from "undici";

/** Sigstore trust material (Fulcio CAs, Rekor public keys). Load via `loadTrustMaterial()`. */
export type { TrustMaterial };

/**
 * Structural type matching `sigstore.BundleVerifier`. Accepting any shape
 * with `verify(bundle)` makes the verifier trivially injectable for tests
 * and lets callers build a verifier once and reuse it across many calls.
 * Throws on verification failure; return value is not consumed.
 */
export type BundleVerifier = {
  verify(bundle: SerializedBundle): unknown;
};

/** GitHub `owner/repo` slug. */
export type GitHubRepo = `${string}/${string}`;

/**
 * Strict semver string (no `v` prefix). Template-literal type is wider than
 * the runtime check; `semVerString()` enforces the regex.
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

/** 40-hex commit SHA (`GITHUB_SHA`). */
declare const __sourceCommitShaBrand: unique symbol;
export type SourceCommitSha = string & { readonly [__sourceCommitShaBrand]: true };

/** Git tag ref under `refs/tags/` (`GITHUB_REF`). */
declare const __sourceRefBrand: unique symbol;
export type SourceRef = string & { readonly [__sourceRefBrand]: true };

/** Shared with other modules for Zod schema composition. */
export const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/;

/** Validate and brand a lowercase 64-hex SHA-256 string. */
export function sha256Hex(value: string): Sha256Hex {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`invalid SHA-256 hex digest: ${value}`);
  }
  return value as Sha256Hex;
}

/** Validate and brand a strict semver string (no `v` prefix). */
export function semVerString(value: string): SemVerString {
  if (!SEMVER_RE.test(value)) {
    throw new TypeError(`invalid semver string: ${value}`);
  }
  return value as SemVerString;
}

/** Validate and brand a GitHub `owner/repo` slug. */
export function githubRepo(value: string): GitHubRepo {
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(value)) {
    throw new TypeError(`invalid GitHub repo: ${value}`);
  }
  return value as GitHubRepo;
}

/** Validate and brand a GitHub Actions run invocation URI. */
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

/** Validate and brand a 40-hex commit SHA. */
export function sourceCommitSha(value: string): SourceCommitSha {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new TypeError(`invalid source commit SHA: ${value}`);
  }
  return value as SourceCommitSha;
}

/** Validate and brand a `refs/tags/` ref string. */
export function sourceRef(value: string): SourceRef {
  if (!value.startsWith("refs/tags/")) {
    throw new TypeError(`invalid source ref (must start with refs/tags/): ${value}`);
  }
  return value as SourceRef;
}

/** Forward-declared to keep types.ts free of import cycles into verify/. */
type RekorClient = import("./verify/rekor-client.ts").RekorClient;

/**
 * Consumer-side verification options. All fields optional — defaults apply
 * to the common case. Escape hatches are for heavy callers (reusing a
 * verifier across calls), slow networks (timeouts), and fork / private
 * Sigstore deployments (custom Rekor URLs).
 */
export type VerifyOptions = {
  /**
   * Pre-built sigstore bundle verifier. If omitted, one is built per call
   * from `trustMaterial` (or TUF). Supply a shared verifier to amortize
   * TUF trust-material loading across many calls, or tune
   * `tlogThreshold` / `ctLogThreshold` via `sigstore.createVerifier`.
   */
  readonly verifier?: BundleVerifier | undefined;
  /** Pre-loaded trust material. Loaded via `loadTrustMaterial()` if omitted. */
  readonly trustMaterial?: TrustMaterial | undefined;
  /**
   * undici dispatcher — proxy / mTLS / custom connector. Plumbed into
   * the default Rekor client when `rekorClient` isn't supplied.
   */
  readonly dispatcher?: Dispatcher | undefined;
  /**
   * Inject a custom Rekor client. Tests fake this directly; forks
   * pointing at a private Sigstore instance construct one and pass it.
   * Takes full precedence over `dispatcher`.
   */
  readonly rekorClient?: RekorClient | undefined;
  /** AbortSignal for the entire verify + download pipeline. */
  readonly signal?: AbortSignal | undefined;
  /** Per-binary download size cap, bytes. Default: 268435456 (256 MiB). */
  readonly maxBinaryBytes?: number | undefined;
  /** Per-binary fetch timeout, seconds. Default: 300. */
  readonly maxBinarySeconds?: number | undefined;
  /**
   * Max Rekor entries to check per artifact hash. Bounds a flood-attack's
   * impact from "accepts malicious entry" (already impossible) to "load
   * budget". Default: 100.
   */
  readonly maxRekorEntries?: number | undefined;
  /**
   * Override Rekor endpoints — fork / private Sigstore instance. Both
   * strings must be provided together when overriding. `entryUrl` is a
   * URL template with a `{uuid}` placeholder (e.g.
   * `https://rekor.example/api/v1/log/entries/{uuid}`).
   */
  readonly rekorSearchUrl?: string | undefined;
  readonly rekorEntryUrl?: string | undefined;
  /**
   * Delays in milliseconds between retries when Rekor hasn't yet indexed
   * a freshly published attestation (ingestion lag ~30s). Publish-side
   * only. Default: `[2000, 5000, 10000, 15000]`. Pass `[]` to disable.
   */
  readonly rekorIngestionRetryDelays?: readonly number[] | undefined;
  /** Per-request Rekor timeout, ms. Default: 30000. */
  readonly timeoutMs?: number | undefined;
};

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
    it("rejects wrong length", ({ expect }) => {
      expect(() => sha256Hex("a".repeat(63))).toThrow(TypeError);
      expect(() => sha256Hex("a".repeat(65))).toThrow(TypeError);
    });
  });

  describe("semVerString", () => {
    it("accepts valid semver", ({ expect }) => {
      expect(semVerString("1.2.3")).toBe("1.2.3");
      expect(semVerString("1.0.0-beta.1+build.123")).toBe("1.0.0-beta.1+build.123");
    });
    it("rejects v-prefixed", ({ expect }) => {
      expect(() => semVerString("v1.2.3")).toThrow(TypeError);
    });
  });

  describe("githubRepo", () => {
    it("accepts owner/repo", ({ expect }) => {
      expect(githubRepo("owner/repo")).toBe("owner/repo");
    });
    it("rejects nested path", ({ expect }) => {
      expect(() => githubRepo("owner/repo/extra")).toThrow(TypeError);
    });
  });

  describe("runInvocationURI", () => {
    it("accepts valid URI", ({ expect }) => {
      const uri = "https://github.com/owner/repo/actions/runs/123/attempts/1";
      expect(runInvocationURI(uri)).toBe(uri);
    });
    it("rejects missing attempts segment", ({ expect }) => {
      expect(() => runInvocationURI("https://github.com/owner/repo/actions/runs/123")).toThrow(
        TypeError,
      );
    });
  });

  describe("sourceCommitSha", () => {
    it("accepts 40-hex lowercase", ({ expect }) => {
      expect(sourceCommitSha("a".repeat(40))).toBe("a".repeat(40));
    });
    it("rejects wrong length / case", ({ expect }) => {
      expect(() => sourceCommitSha("a".repeat(39))).toThrow(TypeError);
      expect(() => sourceCommitSha("A".repeat(40))).toThrow(TypeError);
    });
  });

  describe("sourceRef", () => {
    it("accepts refs/tags/ prefix", ({ expect }) => {
      expect(sourceRef("refs/tags/v1.2.3")).toBe("refs/tags/v1.2.3");
    });
    it("rejects non-tag refs", ({ expect }) => {
      expect(() => sourceRef("refs/heads/main")).toThrow(TypeError);
    });
  });
}
