// SPDX-License-Identifier: Apache-2.0 OR MIT

/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

  describe("errorMessage", () => {
    it("returns the message for Error instances", ({ expect }) => {
      expect(errorMessage(new Error("boom"))).toBe("boom");
    });

    it("returns the subclass message", ({ expect }) => {
      class Custom extends Error {}
      expect(errorMessage(new Custom("custom"))).toBe("custom");
    });

    it("stringifies non-Error values", ({ expect }) => {
      expect(errorMessage("plain string")).toBe("plain string");
      expect(errorMessage(42)).toBe("42");
      expect(errorMessage(null)).toBe("null");
      expect(errorMessage(undefined)).toBe("undefined");
      expect(errorMessage({ toString: () => "obj" })).toBe("obj");
    });
  });
}
