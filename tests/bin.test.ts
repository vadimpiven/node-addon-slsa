// SPDX-License-Identifier: Apache-2.0 OR MIT

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { describe, it } from "vitest";

import { tempDir } from "../src/util/fs.ts";
import { FAKE_BINARY, writeTestPkg } from "./fixtures.ts";

const gunzipAsync = promisify(gunzip);

const slsaBin = resolve("bin/slsa.mjs");

function run(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("node", [slsaBin, ...args], { cwd }, (error, stdout, stderr) => {
      resolve({
        code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
        stdout,
        stderr,
      });
    });
  });
}

describe("slsa bin", () => {
  it("wget skips verification for development version", async ({ expect }) => {
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "0.0.0");

    const { code } = await run(["wget"], tmp.path);
    expect(code).toBe(0);
  });

  it("pack compresses binary and produces valid archive", async ({ expect }) => {
    await using tmp = await tempDir();
    const distDir = join(tmp.path, "dist");
    await mkdir(distDir, { recursive: true });

    await writeFile(join(distDir, "node_reqwest.node"), FAKE_BINARY);

    await writeTestPkg(tmp.path, "1.0.0");

    const { code } = await run(["pack"], tmp.path);
    expect(code).toBe(0);

    const platform = process.platform;
    const arch = process.arch;
    const packedPath = join(distDir, `node_reqwest-v1.0.0-${platform}-${arch}.node.gz`);
    const compressed = await readFile(packedPath);
    const decompressed = await gunzipAsync(compressed);
    expect(decompressed).toEqual(FAKE_BINARY);
  });

  it("--help prints usage and exits 0", async ({ expect }) => {
    await using tmp = await tempDir();
    const { code, stdout } = await run(["--help"], tmp.path);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  it("no command prints usage and exits 0", async ({ expect }) => {
    await using tmp = await tempDir();
    const { code, stdout } = await run([], tmp.path);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  it("-h short flag prints usage and exits 0", async ({ expect }) => {
    await using tmp = await tempDir();
    const { code, stdout } = await run(["-h"], tmp.path);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  it("unknown flag causes error exit", async ({ expect }) => {
    await using tmp = await tempDir();
    const { code } = await run(["wget", "--unknown-flag"], tmp.path);
    expect(code).toBe(1);
  });

  it("exits with error for unknown command", async ({ expect }) => {
    await using tmp = await tempDir();
    await writeFile(join(tmp.path, "package.json"), "{}");
    const { code, stderr } = await run(["unknown"], tmp.path);
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown command");
  });
});
