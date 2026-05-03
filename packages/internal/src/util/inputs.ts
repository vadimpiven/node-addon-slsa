// SPDX-License-Identifier: Apache-2.0 OR MIT

/** Input/env helpers shared by the bundled GitHub Actions. */

/**
 * Read `process.env[name]` and throw if unset/empty. Includes a hint that
 * the variable is normally provided by the GitHub Actions runner.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `required env var ${name} is not set — this variable is provided by the GitHub Actions runner.`,
    );
  }
  return value;
}

// Mirrors @actions/core.getInput's env-var convention without taking the dep.
function readActionInput(name: string): string {
  const key = `INPUT_${name.replaceAll(" ", "_").toUpperCase()}`;
  return (process.env[key] ?? "").trim();
}

/**
 * Read action input `INPUT_<name>` as a positive integer. Returns
 * `defaultValue` for empty inputs. Throws on non-positive-int input.
 */
export function readPositiveIntInput(name: string, defaultValue: number): number {
  const raw = readActionInput(name);
  if (raw === "") return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`input '${name}' must be a positive integer, got: ${raw}`);
  }
  return n;
}

/** Options for {@link normalizeHttpsPrefix}. */
export type NormalizeHttpsPrefixOptions = {
  /** Domain-specific label for the error message (e.g. `release-base-url`). */
  readonly label?: string;
};

/**
 * Validate that `url` uses `https://` and return it with a trailing slash
 * appended if missing. Throws on non-https inputs; the optional `label`
 * names the input in the error so call sites don't need their own guard.
 */
export function normalizeHttpsPrefix(
  url: string,
  options: NormalizeHttpsPrefixOptions = {},
): string {
  if (!url.startsWith("https://")) {
    const subject = options.label ?? "url";
    throw new Error(`${subject} must start with https://, got: ${url}`);
  }
  return url.endsWith("/") ? url : `${url}/`;
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

  describe("normalizeHttpsPrefix", () => {
    it("appends trailing slash when missing", ({ expect }) => {
      expect(normalizeHttpsPrefix("https://e.com/v1")).toBe("https://e.com/v1/");
    });
    it("preserves existing trailing slash", ({ expect }) => {
      expect(normalizeHttpsPrefix("https://e.com/v1/")).toBe("https://e.com/v1/");
    });
    it("rejects non-https with default label", ({ expect }) => {
      expect(() => normalizeHttpsPrefix("http://e.com/")).toThrow(
        /^url must start with https:\/\//,
      );
    });
    it("rejects non-https using a domain-specific label", ({ expect }) => {
      expect(() => normalizeHttpsPrefix("http://e.com/", { label: "release-base-url" })).toThrow(
        /^release-base-url must start with https:\/\//,
      );
    });
  });

  describe("readPositiveIntInput", () => {
    const KEY = "INPUT_FOOBAR";
    it("returns defaultValue when input is empty", ({ expect }) => {
      delete process.env[KEY];
      expect(readPositiveIntInput("foobar", 42)).toBe(42);
    });
    it("returns defaultValue when input is whitespace", ({ expect }) => {
      process.env[KEY] = "   ";
      try {
        expect(readPositiveIntInput("foobar", 7)).toBe(7);
      } finally {
        delete process.env[KEY];
      }
    });
    it("parses a positive integer", ({ expect }) => {
      process.env[KEY] = "123";
      try {
        expect(readPositiveIntInput("foobar", 1)).toBe(123);
      } finally {
        delete process.env[KEY];
      }
    });
    it("rejects zero", ({ expect }) => {
      process.env[KEY] = "0";
      try {
        expect(() => readPositiveIntInput("foobar", 1)).toThrow(/positive integer/);
      } finally {
        delete process.env[KEY];
      }
    });
    it("rejects negative", ({ expect }) => {
      process.env[KEY] = "-5";
      try {
        expect(() => readPositiveIntInput("foobar", 1)).toThrow(/positive integer/);
      } finally {
        delete process.env[KEY];
      }
    });
    it("rejects non-integer", ({ expect }) => {
      process.env[KEY] = "1.5";
      try {
        expect(() => readPositiveIntInput("foobar", 1)).toThrow(/positive integer/);
      } finally {
        delete process.env[KEY];
      }
    });
    it("rejects non-numeric", ({ expect }) => {
      process.env[KEY] = "abc";
      try {
        expect(() => readPositiveIntInput("foobar", 1)).toThrow(/positive integer/);
      } finally {
        delete process.env[KEY];
      }
    });
  });

  describe("requireEnv", () => {
    it("returns set values", ({ expect }) => {
      const k = "REQUIRE_ENV_TEST_K";
      process.env[k] = "v";
      try {
        expect(requireEnv(k)).toBe("v");
      } finally {
        delete process.env[k];
      }
    });
    it("throws on missing", ({ expect }) => {
      expect(() => requireEnv("DEFINITELY_NOT_SET_ENV_VAR_XYZ")).toThrow(/is not set/);
    });
  });
}
