// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Ingestion-lag retry loop for Rekor lookups. Extracted from `verify.ts`
 * so the retry policy has one obvious home, and the retry predicate keys
 * on {@link ProvenanceError.kind} instead of regex-matching the message.
 */

import { setTimeout as sleep } from "node:timers/promises";

import { log } from "../util/log.ts";
import { isProvenanceError } from "../util/provenance-error.ts";

/**
 * Sigstore Rekor's prod instance ingests with ~30s latency; retry briefly.
 * Delay schedule is caller-tunable via `VerifyOptions.rekorIngestionRetryDelays`.
 *
 * Retries only for `kind === "rekor-not-found"` — any other ProvenanceError
 * is a deterministic mismatch (cert OID, schema, sourceRef, …) that won't
 * change by waiting. Non-provenance errors (network, etc.) also bubble up
 * immediately.
 */
export async function withRekorIngestionRetry<T>(
  fn: () => Promise<T>,
  delays: readonly number[],
  signal?: AbortSignal,
): Promise<T> {
  for (const delay of [...delays, null]) {
    try {
      return await fn();
    } catch (err) {
      const retriable = isProvenanceError(err) && err.kind === "rekor-not-found";
      if (!retriable || delay === null) throw err;
      log(`Rekor ingestion lag: retrying in ${delay}ms`);
      await sleep(delay, undefined, signal ? { signal } : undefined);
    }
  }
  throw new Error("unreachable");
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  const { ProvenanceError } = await import("../util/provenance-error.ts");

  describe("withRekorIngestionRetry", () => {
    it("retries only ProvenanceError with kind=rekor-not-found", async () => {
      let calls = 0;
      const result = await withRekorIngestionRetry(async () => {
        calls++;
        if (calls < 3) {
          throw new ProvenanceError("No Rekor entry found", { kind: "rekor-not-found" });
        }
        return "ok";
      }, [1, 1]);
      expect(result).toBe("ok");
      expect(calls).toBe(3);
    });

    it("does not retry ProvenanceError with kind=other", async () => {
      let calls = 0;
      await expect(
        withRekorIngestionRetry(async () => {
          calls++;
          throw new ProvenanceError("cert OID mismatch");
        }, [1, 1]),
      ).rejects.toThrow(/cert OID mismatch/);
      expect(calls).toBe(1);
    });

    it("does not retry non-ProvenanceError", async () => {
      let calls = 0;
      await expect(
        withRekorIngestionRetry(async () => {
          calls++;
          throw new Error("network");
        }, [1, 1]),
      ).rejects.toThrow(/network/);
      expect(calls).toBe(1);
    });

    it("throws the last rekor-not-found after exhausting delays", async () => {
      let calls = 0;
      await expect(
        withRekorIngestionRetry(async () => {
          calls++;
          throw new ProvenanceError("No Rekor entry found", { kind: "rekor-not-found" });
        }, [1, 1]),
      ).rejects.toThrow(/No Rekor entry found/);
      // initial + two retries
      expect(calls).toBe(3);
    });
  });
}
