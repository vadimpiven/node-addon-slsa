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
  const { describe, it, afterEach } = import.meta.vitest;

  // Codecov's per-package patch coverage cannot attribute e2e coverage
  // produced by `node-addon-slsa`'s action tests back to internal-package
  // files, so happy paths are duplicated here.

  describe("normalizeHttpsPrefix", () => {
    it("appends trailing slash when missing", ({ expect }) => {
      expect(normalizeHttpsPrefix("https://e.com")).toBe("https://e.com/");
    });
    it("preserves existing trailing slash", ({ expect }) => {
      expect(normalizeHttpsPrefix("https://e.com/")).toBe("https://e.com/");
    });
    it("rejects non-https with default label", ({ expect }) => {
      expect(() => normalizeHttpsPrefix("http://e.com/")).toThrow(
        /^url must start with https:\/\//,
      );
    });
    it("rejects non-https with domain-specific label", ({ expect }) => {
      expect(() => normalizeHttpsPrefix("http://e.com/", { label: "release-base-url" })).toThrow(
        /^release-base-url must start with https:\/\//,
      );
    });
  });

  describe("readPositiveIntInput", () => {
    const KEY = "INPUT_FOOBAR";
    afterEach(() => {
      delete process.env[KEY];
    });
    it("returns the parsed integer for a valid input", ({ expect }) => {
      process.env[KEY] = "42";
      expect(readPositiveIntInput("foobar", 1)).toBe(42);
    });
    it("returns defaultValue when input is empty", ({ expect }) => {
      delete process.env[KEY];
      expect(readPositiveIntInput("foobar", 7)).toBe(7);
    });
    it("returns defaultValue when input is whitespace", ({ expect }) => {
      process.env[KEY] = "   ";
      expect(readPositiveIntInput("foobar", 7)).toBe(7);
    });
    it("rejects zero, negative, fractional, and non-numeric values", ({ expect }) => {
      for (const v of ["0", "-5", "1.5", "abc"]) {
        process.env[KEY] = v;
        expect(() => readPositiveIntInput("foobar", 1), `value=${v}`).toThrow(/positive integer/);
      }
    });
    it("normalises action-input names with spaces and casing", ({ expect }) => {
      process.env["INPUT_MY_INPUT"] = "5";
      try {
        expect(readPositiveIntInput("my input", 1)).toBe(5);
      } finally {
        delete process.env["INPUT_MY_INPUT"];
      }
    });
  });

  describe("requireEnv", () => {
    const KEY = "VITEST_REQUIRE_ENV_FIXTURE";
    afterEach(() => {
      delete process.env[KEY];
    });
    it("returns the value when set", ({ expect }) => {
      process.env[KEY] = "hello";
      expect(requireEnv(KEY)).toBe("hello");
    });
    it("throws when unset", ({ expect }) => {
      delete process.env[KEY];
      expect(() => requireEnv(KEY)).toThrow(/required env var/);
    });
    it("throws when empty", ({ expect }) => {
      process.env[KEY] = "";
      expect(() => requireEnv(KEY)).toThrow(/required env var/);
    });
  });
}
