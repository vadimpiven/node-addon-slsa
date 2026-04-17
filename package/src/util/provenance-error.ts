// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Security error type for provenance verification failures.
 * Messages are prefixed with "SECURITY:" and include remediation advice.
 * Use {@link isProvenanceError} in catch blocks to distinguish from transient errors.
 */

import dedent from "dedent";

const SECURITY_ADVICE = `Do not use this package version. Report this issue to the maintainer.`;

const BRAND = Symbol.for("node-addon-slsa.ProvenanceError");

/**
 * Thrown when provenance verification detects a security issue.
 * The message is prefixed with `SECURITY:` and includes remediation advice.
 */
export class ProvenanceError extends Error {
  readonly [BRAND] = true as const;

  constructor(message: string, options?: ErrorOptions) {
    const msg = dedent`
      SECURITY: ${message}
      ${SECURITY_ADVICE}
    `;
    super(msg, options);
    this.name = "ProvenanceError";
  }
}

/**
 * Type guard for {@link ProvenanceError}. Use in catch blocks to distinguish
 * security failures from transient errors.
 */
export function isProvenanceError(err: unknown): err is ProvenanceError {
  return (
    typeof err === "object" && err !== null && (err as Record<symbol, unknown>)[BRAND] === true
  );
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

  describe("ProvenanceError", () => {
    it("sets name to ProvenanceError", ({ expect }) => {
      const err = new ProvenanceError("msg");
      expect(err.name).toBe("ProvenanceError");
    });

    it("prepends SECURITY: and appends advice", ({ expect }) => {
      const err = new ProvenanceError("compromise detected");
      expect(err.message).toContain("SECURITY: compromise detected");
      expect(err.message).toContain("Do not use this package version");
    });
  });

  describe("ProvenanceError cause chaining", () => {
    it("preserves cause when provided", ({ expect }) => {
      const cause = new Error("original");
      const err = new ProvenanceError("test", { cause });
      expect(err.cause).toBe(cause);
    });

    it("has undefined cause when omitted", ({ expect }) => {
      const err = new ProvenanceError("test");
      expect(err.cause).toBeUndefined();
    });
  });

  describe("isProvenanceError", () => {
    it("distinguishes ProvenanceError from other errors", ({ expect }) => {
      expect(isProvenanceError(new ProvenanceError("test"))).toBe(true);
      expect(isProvenanceError(new Error("test"))).toBe(false);
    });

    it("rejects plain objects and primitives", ({ expect }) => {
      expect(isProvenanceError(null)).toBe(false);
      expect(isProvenanceError(undefined)).toBe(false);
      expect(isProvenanceError("ProvenanceError")).toBe(false);
      expect(isProvenanceError({ name: "ProvenanceError" })).toBe(false);
    });

    it("matches by brand when instanceof fails (e.g. dual packages)", ({ expect }) => {
      const fake = Object.assign(new Error("test"), {
        [Symbol.for("node-addon-slsa.ProvenanceError")]: true,
      });
      expect(isProvenanceError(fake)).toBe(true);
    });
  });
}
