// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Runtime loader for consuming packages whose install hook is blocked
 * (pnpm ≥ 10 by default, Yarn OnP, Bun, etc.). On first call, walks up
 * from the caller to find its `package.json`, invokes {@link wget} if
 * the binary is missing, and `require()`s it. Subsequent calls hit the
 * binary directly.
 *
 * Owns one export: {@link requireAddon}. Lives in the block-facing
 * package (not `@node-addon-slsa/internal`) so consumers stay on one
 * dependency for both the CLI and the runtime loader.
 */

import { access, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCallSites } from "node:util";

import dedent from "dedent";

import {
  assertWithinDir,
  isEnoent,
  isEnotdir,
  readPackageJson,
  type VerifyOptions,
} from "@node-addon-slsa/internal";

import { wget } from "./commands.ts";

/**
 * Options for {@link requireAddon}. Extends {@link VerifyOptions} with a
 * single extra field identifying which package's addon to load.
 */
export type RequireAddonOptions = VerifyOptions & {
  /**
   * Path or `file://` URL inside the consuming package, used to locate
   * its `package.json` by walking up. Defaults to the caller's own
   * source file captured via `util.getCallSites()`. Pass explicitly
   * (typically `import.meta.url`) when the caller is not inside the
   * consuming package — e.g. a re-export wrapper in another module.
   */
  readonly from?: string | undefined;
};

async function findPackageDir(startDir: string): Promise<string> {
  let dir = resolve(startDir);
  while (true) {
    try {
      await access(join(dir, "package.json"));
      return dir;
    } catch (err: unknown) {
      // ENOTDIR arises when `dir` itself is a file path (e.g. the caller
      // passed `import.meta.url` pointing to a real module file): joining
      // `"package.json"` produces `/…/file.ts/package.json`, which fails
      // with ENOTDIR rather than ENOENT. Treat both as "keep walking up".
      if (!isEnoent(err) && !isEnotdir(err)) throw err;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(dedent`
        package.json not found walking up from ${startDir}:
        pass { from: import.meta.url } pointing to a file inside the package
      `);
    }
    dir = parent;
  }
}

/**
 * Returns the native addon, running the `slsa wget` flow (verify +
 * download) first when the binary is missing on disk.
 *
 * With no arguments, the caller's source file is captured via
 * `util.getCallSites()` and the enclosing `package.json` is discovered
 * by walking up directories. Pass `{ from: import.meta.url }` when the
 * caller is not inside the consuming package.
 *
 * `T` defaults to `unknown`; supply the addon's type at the call site
 * to avoid narrowing each access.
 *
 * ```typescript
 * // inside the consuming package, e.g. packages/my-addon/src/index.ts
 * import { requireAddon } from "node-addon-slsa";
 *
 * type MyAddon = { add(a: number, b: number): number };
 * const addon = await requireAddon<MyAddon>();
 * addon.add(1, 2);
 * ```
 *
 * @throws {ProvenanceError} on provenance or sha256 verification failure.
 * @throws {Error} on `package.json` discovery, download, decompression,
 *   or `require()` failure.
 */
export async function requireAddon<T = unknown>(options?: RequireAddonOptions): Promise<T> {
  // Frame 0 is `requireAddon` itself, frame 1 is the caller.
  const from = options?.from ?? getCallSites(2)[1]?.scriptName;
  if (!from) {
    throw new Error(dedent`
      could not determine caller file from call stack:
      pass { from: import.meta.url } to requireAddon() explicitly
    `);
  }

  const startPath = from.startsWith("file://") ? fileURLToPath(from) : from;
  const packageDir = await findPackageDir(startPath);

  const { addon } = await readPackageJson(packageDir);
  const binaryPath = join(packageDir, addon.path);
  assertWithinDir({ baseDir: packageDir, target: binaryPath, label: "addon.path" });

  try {
    await stat(binaryPath);
  } catch (err: unknown) {
    if (!isEnoent(err)) throw err;
    const { from: _, ...verifyOptions } = options ?? {};
    await wget(packageDir, verifyOptions);
  }

  const require = createRequire(import.meta.url);
  return require(binaryPath) as T;
}
