// SPDX-License-Identifier: Apache-2.0 OR MIT

import { createHash } from "node:crypto";
import { Transform } from "node:stream";

import { sha256Hex } from "../types.ts";
import type { Sha256Hex } from "../types.ts";

/** Create a pass-through Transform that computes a SHA-256 hash of all data flowing through it. */
export function createHashPassthrough(): { stream: Transform; digest: () => Sha256Hex } {
  const hash = createHash("sha256");
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return { stream, digest: () => sha256Hex(hash.digest("hex")) };
}
