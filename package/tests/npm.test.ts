// SPDX-License-Identifier: Apache-2.0 OR MIT

import { describe, it, vi } from "vitest";

import { ProvenanceError } from "../src/util/provenance-error.ts";
import { resolveConfig } from "../src/verify/config.ts";
import { fetchNpmAttestations } from "../src/verify/npm.ts";
import { mockFetch } from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000 });

describe("fetchNpmAttestations", () => {
  it("returns ProvenanceError on 404", async ({ expect }) => {
    await using dispatcher = mockFetch(() => ({ statusCode: 404, data: "" }));
    const config = resolveConfig({ retryCount: 0, dispatcher });
    await expect(
      fetchNpmAttestations({ packageName: "pkg", version: "1.0.0" }, config),
    ).rejects.toThrow(ProvenanceError);
    await expect(
      fetchNpmAttestations({ packageName: "pkg", version: "1.0.0" }, config),
    ).rejects.toThrow(/No provenance attestation found/);
  });

  it("propagates server error as regular Error (not ProvenanceError)", async ({ expect }) => {
    await using dispatcher = mockFetch(() => ({ statusCode: 500, data: "" }));
    const config = resolveConfig({ retryCount: 0, dispatcher });
    await expect(
      fetchNpmAttestations({ packageName: "pkg", version: "1.0.0" }, config),
    ).rejects.toThrow(Error);
    await expect(
      fetchNpmAttestations({ packageName: "pkg", version: "1.0.0" }, config),
    ).rejects.not.toThrow(ProvenanceError);
  });
});
