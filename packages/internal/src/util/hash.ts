// SPDX-License-Identifier: Apache-2.0 OR MIT

/** Streaming SHA-256 passthrough for the download pipeline. */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Transform, Writable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

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

/** Options for {@link hashFileSha256}. */
export type HashFileSha256Options = {
  readonly sizeCap?: number | undefined;
};

/**
 * Hash the file at `path` with SHA-256. When `sizeCap` is given, the file
 * is `stat`-ed first and the call rejects if the size exceeds the cap —
 * the error message names the input so the operator knows which knob to
 * raise (`max-binary-bytes` on the `attest-addon` action).
 */
export async function hashFileSha256(
  path: string,
  options: HashFileSha256Options = {},
): Promise<{ sha256: Sha256Hex; size: number }> {
  const { size } = await stat(path);
  if (options.sizeCap !== undefined && size > options.sizeCap) {
    throw new Error(
      `binary ${path} is ${size} bytes, exceeds cap ${options.sizeCap} — ` +
        `raise the 'max-binary-bytes' input on the attest-addon action if this is expected.`,
    );
  }
  const { stream, digest } = createHashPassthrough();
  await pipeline(
    createReadStream(path),
    stream,
    new Writable({
      write(_c, _e, cb) {
        cb();
      },
    }),
  );
  return { sha256: digest(), size };
}
