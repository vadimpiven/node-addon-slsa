// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Asserts that `requireAddon` walks up from any starting `from` (file://
 * URL, absolute path, real file) to the nearest `package.json`, invokes
 * the wget short-circuit for version `0.0.0` (no network), and only then
 * reaches `require(binaryPath)`. Assertions key on the concrete error
 * kind the final require produces — ENOENT / module-not-found / native-
 * loader error — which pinpoints which step was actually reached.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { tempDir } from "@node-addon-slsa/internal";

import { requireAddon } from "../src/loader.ts";
import { writeTestPkg } from "./fixtures.ts";

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

  it("skips wget when the binary already exists on disk, reaches require()", async () => {
    // Stage a file at addon.path so stat() succeeds → findPackageDir worked,
    // stat() returned OK, and wget is correctly skipped. The subsequent
    // require() on a non-.node-formatted file must fail with a native-loader
    // error (not ENOENT, not a manifest error), proving we actually reached
    // the require step. This is the happy "binary present" branch.
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "1.2.3");
    const binaryDir = join(tmp.path, "dist");
    await mkdir(binaryDir, { recursive: true });
    await writeFile(join(binaryDir, "node_reqwest.node"), Buffer.from("not a real .node"));

    let err: unknown;
    try {
      await requireAddon({ from: tmp.path });
    } catch (e: unknown) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    // Must not be ENOENT (would mean stat failed) nor a manifest error
    // (would mean wget was entered despite the binary being present).
    expect(msg).not.toMatch(/ENOENT/);
    expect(msg).not.toMatch(/manifest/i);
    expect(msg).not.toMatch(/could not determine expected repository/);
  });

  it("throws the 'not found' error when walking hits root without a package.json", async () => {
    // tempDir() lands under os.tmpdir(); neither /var/folders/... nor /var
    // nor / typically has a package.json, so findPackageDir walks to the
    // filesystem root (parent === dir) and hits the explicit throw.
    await using tmp = await tempDir();
    await expect(requireAddon({ from: tmp.path })).rejects.toThrow(
      /package\.json not found walking up/,
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
