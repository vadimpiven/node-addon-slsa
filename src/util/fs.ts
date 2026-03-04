// SPDX-License-Identifier: Apache-2.0 OR MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import dedent from "dedent";

import { ProvenanceError } from "./provenance-error.ts";

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
 * @throws {ProvenanceError} if the resolved path escapes the base directory.
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
    throw new ProvenanceError(
      dedent`
        ${label} escapes the package directory.
        Base: ${base}
        Resolved: ${resolved}
      `,
    );
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
      ).toThrow(ProvenanceError);
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
}
