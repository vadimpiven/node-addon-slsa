// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Fork-editable brand constants. Everything else (signer patterns, schema
 * URLs, docs URLs) derives from these. Enterprise forks edit this file
 * and rebuild; nothing else needs to change to retarget the toolchain.
 */

/** GitHub owner/repo hosting this library and the reusable publish workflow. */
export const BRAND_REPO = "vadimpiven/node-addon-slsa";

/** GitHub Pages origin for published schemas and docs. */
export const BRAND_PAGES_BASE = "https://vadimpiven.github.io/node-addon-slsa";

/** Path to the reusable publish workflow within {@link BRAND_REPO}. */
export const BRAND_PUBLISH_WORKFLOW_PATH = ".github/workflows/publish.yaml";
