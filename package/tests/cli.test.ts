// SPDX-License-Identifier: Apache-2.0 OR MIT

import process from "node:process";
import { describe, it, vi, beforeEach } from "vitest";

import { runSlsaInner } from "../src/cli.ts";
import { tempDir } from "../src/util/fs.ts";
import { writeTestPkg } from "./fixtures.ts";
import { mockFetch } from "./helpers.ts";

beforeEach(() => {
  delete process.env["SLSA_DEBUG"];
});

describe("runSlsaInner", () => {
  it("returns exitCode 0 for --help", async ({ expect }) => {
    const origArgv = process.argv;
    process.argv = ["node", "slsa", "--help"];
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { exitCode } = await runSlsaInner();
      expect(exitCode).toBe(0);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    } finally {
      process.argv = origArgv;
      spy.mockRestore();
    }
  });

  it("returns exitCode 0 when no command given", async ({ expect }) => {
    const origArgv = process.argv;
    process.argv = ["node", "slsa"];
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { exitCode } = await runSlsaInner();
      expect(exitCode).toBe(0);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    } finally {
      process.argv = origArgv;
      spy.mockRestore();
    }
  });

  it("returns exitCode 1 for unknown command", async ({ expect }) => {
    const origArgv = process.argv;
    process.argv = ["node", "slsa", "unknown"];
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { exitCode } = await runSlsaInner();
      expect(exitCode).toBe(1);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    } finally {
      process.argv = origArgv;
      spy.mockRestore();
    }
  });

  it("returns exitCode 1 for unknown flag", async ({ expect }) => {
    const origArgv = process.argv;
    process.argv = ["node", "slsa", "--unknown-flag"];
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { exitCode } = await runSlsaInner();
      expect(exitCode).toBe(1);
    } finally {
      process.argv = origArgv;
      spy.mockRestore();
    }
  });

  it("pack with missing binary returns exitCode 1 with debug hint", async ({ expect }) => {
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "1.0.0");

    const origArgv = process.argv;
    const origCwd = process.cwd();
    process.argv = ["node", "slsa", "pack"];
    process.chdir(tmp.path);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { exitCode } = await runSlsaInner();
      expect(exitCode).toBe(1);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("SLSA_DEBUG=1"));
    } finally {
      process.argv = origArgv;
      process.chdir(origCwd);
      spy.mockRestore();
    }
  });

  it("wget with ProvenanceError returns exitCode 1 without debug hint", async ({ expect }) => {
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "1.0.0");

    // npm 404 triggers ProvenanceError from fetchNpmAttestations
    await using dispatcher = mockFetch(() => ({ statusCode: 404, data: "" }));

    const origArgv = process.argv;
    const origCwd = process.cwd();
    process.argv = ["node", "slsa", "wget"];
    process.chdir(tmp.path);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { exitCode } = await runSlsaInner({ dispatcher });
      expect(exitCode).toBe(1);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("No provenance"));
      // ProvenanceError should NOT show debug hint
      for (const call of spy.mock.calls) {
        expect(String(call[0])).not.toContain("SLSA_DEBUG=1");
      }
    } finally {
      process.argv = origArgv;
      process.chdir(origCwd);
      spy.mockRestore();
    }
  });

  it("wget with 0.0.0 returns exitCode 0", async ({ expect }) => {
    await using tmp = await tempDir();
    await writeTestPkg(tmp.path, "0.0.0");

    const origArgv = process.argv;
    const origCwd = process.cwd();
    process.argv = ["node", "slsa", "wget"];
    process.chdir(tmp.path);
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { exitCode } = await runSlsaInner();
      expect(exitCode).toBe(0);
    } finally {
      process.argv = origArgv;
      process.chdir(origCwd);
      spy.mockRestore();
    }
  });
});
