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
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { SLSA_DEBUG: _, ...baseEnv } = process.env;
  return new Promise((resolve) => {
    execFile(
      "node",
      [slsaBin, ...args],
      { cwd, env: { ...baseEnv, ...env } },
      (error, stdout, stderr) => {
        resolve({
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

describe("dist bundle isolation", () => {
  it("types have no external package imports", async ({ expect }) => {
    const dts = await readFile(resolve("dist/index.d.ts"), "utf8");
    const imports = dts.match(/^import\s.+from\s+['"].+['"]/gm) ?? [];
    expect(imports).toEqual([]);
  });

  it("runtime imports only node: builtins and local chunks", async ({ expect }) => {
    const js = await readFile(resolve("dist/index.js"), "utf8");
    const imports = js.match(/^import\s.+from\s+['"](.+?)['"]/gm) ?? [];
    const external = imports.filter((line) => {
      const specifier = line.match(/from\s+['"](.*?)['"]/)?.[1] ?? "";
      return !specifier.startsWith("node:") && !specifier.startsWith("./");
    });
    expect(external).toEqual([]);
  });
});

describe("slsa bin", () => {
  it("wget skips verification for development version and warns", async ({ expect }) => {
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "0.0.0");

    const { code, stderr } = await run(["wget"], tmp.path);
    expect(code).toBe(0);
    expect(stderr).toContain("0.0.0");
    expect(stderr).toContain("skipping provenance verification");
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

  it("unknown flag causes error exit", async ({ expect }) => {
    await using tmp = await tempDir();
    const { code } = await run(["wget", "--unknown-flag"], tmp.path);
    expect(code).toBe(1);
  });

  it("SLSA_DEBUG=1 produces [slsa] output on stderr", async ({ expect }) => {
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "0.0.0");

    const { code, stderr } = await run(["wget"], tmp.path, { SLSA_DEBUG: "1" });
    expect(code).toBe(0);
    expect(stderr).toContain("[slsa] version 0.0.0 detected");
  });

  it("debug output is suppressed by default", async ({ expect }) => {
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "0.0.0");

    const { code, stderr } = await run(["wget"], tmp.path);
    expect(code).toBe(0);
    expect(stderr).not.toContain("[slsa] package:");
  });

  it("pack with SLSA_DEBUG=1 produces [slsa] output on stderr", async ({ expect }) => {
    await using tmp = await tempDir();
    const distDir = join(tmp.path, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "node_reqwest.node"), FAKE_BINARY);
    await writeTestPkg(tmp.path, "1.0.0");

    const { code, stderr } = await run(["pack"], tmp.path, { SLSA_DEBUG: "1" });
    expect(code).toBe(0);
    expect(stderr).toContain("[slsa]");
  });

  it("error output includes SLSA_DEBUG hint", async ({ expect }) => {
    await using tmp = await tempDir();
    await writeFile(join(tmp.path, "package.json"), "{}");
    const { code, stderr } = await run(["wget"], tmp.path);
    expect(code).toBe(1);
    expect(stderr).toContain("SLSA_DEBUG=1");
  });

  it("exits with error for unknown command", async ({ expect }) => {
    await using tmp = await tempDir();
    await writeFile(join(tmp.path, "package.json"), "{}");
    const { code, stderr } = await run(["unknown"], tmp.path);
    expect(code).toBe(1);
    expect(stderr).toContain("Usage:");
  });
});
