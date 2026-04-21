// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Coverage for {@link withRetry}, the single retry primitive in this
 * package. `HttpClient` is exercised indirectly through addon-fetch and
 * the live integration test; its retry surface is this function.
 */

import { afterEach, describe, it, vi } from "vitest";

import { withRetry } from "../src/http.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("withRetry", () => {
  it("returns the first successful result without retrying", async ({ expect }) => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        return 42;
      },
      () => ({ retry: false }),
    );
    expect(out).toBe(42);
    expect(calls).toBe(1);
  });

  it("retries per the classifier's schedule then succeeds", async ({ expect }) => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error(`fail ${calls}`);
        return "ok";
      },
      (_err, attempt) => (attempt < 3 ? { retry: true, delayMs: 1 } : { retry: false }),
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3);
  });

  it("throws when the classifier returns { retry: false }", async ({ expect }) => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("boom");
        },
        () => ({ retry: false }),
      ),
    ).rejects.toThrow(/boom/);
    expect(calls).toBe(1);
  });

  it("propagates an aborted signal without sleeping", async ({ expect }) => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      withRetry(
        async () => "unused",
        () => ({ retry: true, delayMs: 10_000 }),
        { signal: ac.signal },
      ),
    ).rejects.toThrow();
  });
});
