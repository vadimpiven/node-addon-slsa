// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Runtime loader that downloads and provenance-verifies the native
 * addon on demand, then `require()`s it. Intended for consumers whose
 * package manager blocks the `slsa wget` postinstall script (pnpm ≥ 10).
 */

import { access, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCallSites } from "node:util";

import dedent from "dedent";

import { wget } from "./commands.ts";
import { readPackageJson } from "./package.ts";
import type { VerifyOptions } from "./types.ts";
import { assertWithinDir, isEnoent } from "./util/fs.ts";

export type RequireAddonOptions = VerifyOptions & {
  /**
   * Path or `file://` URL inside the consuming package. Defaults to the
   * caller's own source file, captured via `util.getCallSites()`. Supply
   * explicitly when the caller is not inside the consuming package
   * (e.g. a re-export wrapper in another module).
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
      if (!isEnoent(err)) throw err;
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
 * Returns the native addon, running {@link wget} first when the binary
 * is missing on disk.
 *
 * With no arguments, the caller's source file is captured via
 * `util.getCallSites()` and the enclosing `package.json` is discovered
 * by walking up directories. Pass `{ from: import.meta.url }` when the
 * caller is not inside the consuming package.
 *
 * `T` defaults to `unknown`; supply the addon's type at the call site
 * to avoid narrowing each access.
 *
 * @throws {ProvenanceError} if provenance verification fails.
 * @throws {Error} if the download, decompression, or require fails.
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
