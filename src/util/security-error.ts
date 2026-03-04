// SPDX-License-Identifier: Apache-2.0 OR MIT

import dedent from "dedent";

const SECURITY_ADVICE = `Do not use this package version. Report this issue to the maintainer.`;

/**
 * Thrown when provenance verification detects a security issue.
 * The message is prefixed with `SECURITY:` and includes remediation advice.
 */
export class SecurityError extends Error {
  constructor(message: string) {
    super(
      dedent`
        SECURITY: ${message}
        ${SECURITY_ADVICE}
      `,
    );
    this.name = "SecurityError";
  }
}

/**
 * Type guard for {@link SecurityError}. Use in catch blocks to distinguish
 * security failures from transient errors.
 */
export function isSecurityError(err: unknown): err is SecurityError {
  return err instanceof SecurityError;
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

  describe("isSecurityError", () => {
    it("distinguishes SecurityError from other errors", ({ expect }) => {
      expect(isSecurityError(new SecurityError("test"))).toBe(true);
      expect(isSecurityError(new Error("test"))).toBe(false);
    });
  });
}
