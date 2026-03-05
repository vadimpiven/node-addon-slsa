// SPDX-License-Identifier: Apache-2.0 OR MIT

import { vi } from "vitest";

/** Replace global `fetch` for the duration of a `using` block. */
export function stubFetch(impl: typeof fetch): Disposable {
  const original = globalThis.fetch;
  vi.stubGlobal("fetch", impl);
  return { [Symbol.dispose]: () => vi.stubGlobal("fetch", original) };
}
