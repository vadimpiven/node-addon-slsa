// SPDX-License-Identifier: Apache-2.0 OR MIT

import process from "node:process";

/** Write `[slsa] message` to stderr when SLSA_DEBUG=1. */
export function log(message: string): void {
  // read per-call: allows tests to set env after import
  if (process.env["SLSA_DEBUG"] === "1") {
    process.stderr.write(`[slsa] ${message}\n`);
  }
}

/** Write `[slsa] message` to stderr unconditionally. */
export function warn(message: string): void {
  process.stderr.write(`[slsa] ${message}\n`);
}

if (import.meta.vitest) {
  const { describe, it, vi, afterEach } = import.meta.vitest;

  afterEach(() => {
    delete process.env["SLSA_DEBUG"];
    vi.restoreAllMocks();
  });

  describe("log", () => {
    it("writes to stderr when SLSA_DEBUG=1", ({ expect }) => {
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      process.env["SLSA_DEBUG"] = "1";
      log("test message");
      expect(spy).toHaveBeenCalledWith("[slsa] test message\n");
    });

    it("is silent when env var unset", ({ expect }) => {
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      log("should not appear");
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("warn", () => {
    it("writes to stderr unconditionally", ({ expect }) => {
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      warn("warning message");
      expect(spy).toHaveBeenCalledWith("[slsa] warning message\n");
    });
  });
}
