// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Minimal in-toto Statement schema, decoded from a sigstore bundle's
 * `dsseEnvelope.payload`. Internal to bundle.ts — not re-exported.
 */

import { z } from "zod/v4";

import { Sha256HexSchema } from "./descriptor.ts";

/**
 * Only `subject` is used for the addon-digest binding; `predicateType`
 * and `predicate` are carried through unread.
 */
export const InTotoStatementSchema = z.object({
  _type: z.string(),
  subject: z
    .array(
      z.object({
        name: z.string().optional(),
        digest: z.object({ sha256: Sha256HexSchema }),
      }),
    )
    .min(1),
  predicateType: z.string(),
});
