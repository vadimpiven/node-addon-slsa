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

  // Happy paths (https + trailing-slash, http rejection, default-label
  // rejection, positive-int parsing, missing/required env) are exercised
  // through the attest-addon and verify-addons action e2e tests. Keep only
  // the branches those e2e flows do not reach: the domain-specific label
  // for normalizeHttpsPrefix and the non-numeric edge cases for
  // readPositiveIntInput (zero, negative, fractional, whitespace).

  describe("normalizeHttpsPrefix", () => {
    it("rejects non-https using a domain-specific label", ({ expect }) => {
      expect(() => normalizeHttpsPrefix("http://e.com/", { label: "release-base-url" })).toThrow(
        /^release-base-url must start with https:\/\//,
      );
    });
  });

  describe("readPositiveIntInput", () => {
    const KEY = "INPUT_FOOBAR";
    it("returns defaultValue when input is whitespace", ({ expect }) => {
      process.env[KEY] = "   ";
      try {
        expect(readPositiveIntInput("foobar", 7)).toBe(7);
      } finally {
        delete process.env[KEY];
      }
    });
    it("rejects zero, negative, and fractional values", ({ expect }) => {
      for (const v of ["0", "-5", "1.5"]) {
        process.env[KEY] = v;
        try {
          expect(() => readPositiveIntInput("foobar", 1), `value=${v}`).toThrow(/positive integer/);
        } finally {
          delete process.env[KEY];
        }
      }
    });
  });
}
