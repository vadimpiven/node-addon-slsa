#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * `slsa` CLI launcher. Thin shim over {@link runSlsa} in `../dist/cli.js`;
 * keeps the shebang file free of compile output so `pnpm build` can
 * overwrite `dist/` without touching `package.json#bin`.
 */

import { runSlsa } from "../dist/cli.js";

await runSlsa();
