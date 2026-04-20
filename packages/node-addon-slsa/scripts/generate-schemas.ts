// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Build-time generator for the published JSON Schemas under `docs/schema/`.
 * Reads `PublishedSchemas` (Zod, source of truth) from
 * `@node-addon-slsa/internal`, emits Draft-7 JSON Schema files with a
 * pinned `$id` pointing at GitHub Pages. Invoked by `pnpm build`; output
 * is not checked in and must not be edited by hand.
 *
 * Touch when: a new public Zod schema is exported, or the pinned
 * `$schema` / `$id` URL convention changes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod/v4";

import { BRAND_PAGES_BASE } from "../../internal/src/verify/brand.ts";
import { PublishedSchemas } from "../../internal/src/verify/schemas.ts";

const outDir = new URL("../docs/schema/", import.meta.url);
mkdirSync(outDir, { recursive: true });

for (const [name, schema] of Object.entries(PublishedSchemas)) {
  const json = z.toJSONSchema(schema, { target: "draft-7" });
  // Zod's toJSONSchema() omits $id and top-level $schema; inject them so the
  // file self-describes with the URL the verifier pins (exact-string match).
  const withIds = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${BRAND_PAGES_BASE}/schema/${name}`,
    ...json,
  };
  writeFileSync(new URL(name, outDir), JSON.stringify(withIds, null, 2) + "\n");
}
