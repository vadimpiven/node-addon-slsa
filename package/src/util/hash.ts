// SPDX-License-Identifier: Apache-2.0 OR MIT

/** SHA-256 hashing for the download pipeline in commands.ts. */

import { createHash } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

import { sha256Hex, type Sha256Hex } from "../types.ts";

/** Create a pass-through Transform that computes a SHA-256 hash of all data flowing through it. */
export function createHashPassthrough(): { stream: Transform; digest: () => Sha256Hex } {
  const hash = createHash("sha256");
  const stream = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return { stream, digest: (): Sha256Hex => sha256Hex(hash.digest("hex")) };
}
