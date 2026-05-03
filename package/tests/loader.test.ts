// SPDX-License-Identifier: Apache-2.0 OR MIT

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { requireAddon } from "../src/loader.ts";
import { tempDir } from "../src/util/fs.ts";
import { writeTestPkg } from "./fixtures.ts";

// Uses version 0.0.0 so wget's short-circuit path runs end-to-end without
// any network access or mocks. The final `require(binaryPath)` then fails
// because wget (legitimately) did not install anything — we assert on
// that concrete require failure to prove findPackageDir + stat + wget
// ran against the expected package.

describe("requireAddon end-to-end", () => {
  it("walks up from a `file://` URL to the enclosing package.json", async () => {
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "0.0.0");

    const nested = join(tmp.path, "src", "lib", "index.js");
    await mkdir(dirname(nested), { recursive: true });

    // If findPackageDir returned the wrong dir, the thrown error would
    // complain about a missing addon/version field instead of ENOENT on
    // dist/node_reqwest.node.
    await expect(requireAddon({ from: pathToFileURL(nested).href })).rejects.toThrow(
      /node_reqwest\.node|ENOENT|Cannot find module/,
    );
  });

  it("accepts a plain absolute filesystem path as `from`", async () => {
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "0.0.0");

    await expect(requireAddon({ from: tmp.path })).rejects.toThrow(
      /node_reqwest\.node|ENOENT|Cannot find module/,
    );
  });

  it("walks up from a real file path (ENOTDIR on `file.ts/package.json`)", async () => {
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "0.0.0");

    // Create a real file so that join(file, "package.json") errors with
    // ENOTDIR rather than ENOENT. Regression test: the walker used to
    // rethrow ENOTDIR instead of continuing upward.
    const realFile = join(tmp.path, "src", "lib", "index.js");
    await mkdir(dirname(realFile), { recursive: true });
    await writeFile(realFile, "// empty");

    await expect(requireAddon({ from: pathToFileURL(realFile).href })).rejects.toThrow(
      /node_reqwest\.node|ENOENT|Cannot find module/,
    );
  });

  it("walks up to the nearest package.json, not a distant ancestor", async () => {
    await using tmp = await tempDir();

    // Bogus outer package.json — if it were read, Zod would complain
    // about the missing `addon`/`version`/`repository` fields.
    await writeFile(join(tmp.path, "package.json"), JSON.stringify({ name: "outer" }));

    const inner = join(tmp.path, "inner");
    await mkdir(inner, { recursive: true });
    await writeTestPkg(inner, "0.0.0");

    const nested = join(inner, "src", "lib", "index.js");
    await mkdir(dirname(nested), { recursive: true });

    // A node_reqwest.node / ENOENT error proves inner's package.json was
    // picked, not the bogus outer one.
    await expect(requireAddon({ from: pathToFileURL(nested).href })).rejects.toThrow(
      /node_reqwest\.node|ENOENT|Cannot find module/,
    );
  });

  it("does not URL-parse a `from` that starts with `file:` but lacks `//`", async () => {
    // Before tightening the prefix check to "file://", this string hit
    // fileURLToPath and produced a cryptic ERR_INVALID_URL. The fix
    // treats it as a plain path — any failure now comes from walking up
    // / reading package.json, not from URL parsing.
    let err: unknown;
    try {
      await requireAddon({ from: "file:relative/does/not/exist" });
    } catch (e: unknown) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/Invalid URL|ERR_INVALID_URL/);
  });
});
