// SPDX-License-Identifier: Apache-2.0 OR MIT

import dedent from "dedent";

const SECURITY_ADVICE = `Do not use this package version. Report this issue to the maintainer.`;

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
