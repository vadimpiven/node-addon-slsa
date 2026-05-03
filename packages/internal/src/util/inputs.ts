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

/**
 * Validate that `url` uses `https://` and return it with a trailing slash
 * appended if missing. Throws on non-https inputs.
 */
export function normalizeHttpsPrefix(url: string): string {
  if (!url.startsWith("https://")) {
    throw new Error(`url must start with https://, got: ${url}`);
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
    it("rejects non-https", ({ expect }) => {
      expect(() => normalizeHttpsPrefix("http://e.com/")).toThrow(/https:\/\//);
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
