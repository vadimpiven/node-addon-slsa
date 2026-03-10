// SPDX-License-Identifier: Apache-2.0 OR MIT

import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import dedent from "dedent";

import { warn } from "./log.ts";

/** Check whether an error is a Node.js `ENOENT` (file not found) error. */
export function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

/**
 * Creates a temporary directory that is automatically removed on dispose.
 */
export async function tempDir(): Promise<{ path: string } & AsyncDisposable> {
  const path = await mkdtemp(join(tmpdir(), "slsa-test-"));
  return {
    path,
    [Symbol.asyncDispose]: () => rm(path, { recursive: true, force: true }),
  };
}

/**
 * Asserts that `target` is strictly within `baseDir` to prevent
 * path-traversal attacks through package.json fields.
 *
 * @throws {Error} if the resolved path escapes the base directory.
 */
export function assertWithinDir({
  baseDir,
  target,
  label,
}: {
  baseDir: string;
  target: string;
  label: string;
}): void {
  const base = resolve(baseDir);
  const resolved = resolve(target);
  if (!resolved.startsWith(base + sep)) {
    throw new Error(
      dedent`
        ${label} escapes the package directory — possible path traversal.
        Base: ${base}
        Resolved: ${resolved}
        Check the "${label}" field in package.json.
        If you did not author this package, report this to the maintainer.
      `,
    );
  }
}

/**
 * Remove a file, ignoring `ENOENT`. Logs a warning on other errors.
 */
export async function safeUnlink(path: string, label: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err: unknown) {
    if (!isEnoent(err)) {
      warn(`failed to clean up ${label}: ${err}`);
    }
  }
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

  describe("isEnoent", () => {
    it("recognizes ENOENT errors and rejects others", ({ expect }) => {
      expect(isEnoent(Object.assign(new Error("msg"), { code: "ENOENT" }))).toBe(true);
      expect(isEnoent(Object.assign(new Error("msg"), { code: "EACCES" }))).toBe(false);
      expect(isEnoent("not an error")).toBe(false);
    });
  });

  describe("assertWithinDir", () => {
    it("blocks path traversal attacks", async ({ expect }) => {
      await using tmp = await tempDir();
      expect(() =>
        assertWithinDir({
          baseDir: tmp.path,
          target: join(tmp.path, "dist", "..", "..", "etc", "passwd.node"),
          label: "addon.path",
        }),
      ).toThrow("escapes the package directory — possible path traversal");
    });

    it("allows paths within the base directory", async ({ expect }) => {
      await using tmp = await tempDir();
      expect(() =>
        assertWithinDir({
          baseDir: tmp.path,
          target: join(tmp.path, "dist", "file.node"),
          label: "addon.path",
        }),
      ).not.toThrow();
    });
  });

  describe("safeUnlink", () => {
    it("removes an existing file", async ({ expect }) => {
      const { writeFile, stat } = await import("node:fs/promises");
      await using tmp = await tempDir();
      const file = join(tmp.path, "test.txt");
      await writeFile(file, "data");
      await safeUnlink(file, "test");
      await expect(stat(file)).rejects.toThrow();
    });

    it("ignores ENOENT silently", async ({ expect }) => {
      await expect(safeUnlink("/nonexistent/file.txt", "test")).resolves.toBeUndefined();
    });
  });
}
