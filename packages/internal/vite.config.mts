import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";

import { baseConfig } from "../vite.base.mts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    build: {
      lib: { entry: { index: resolve("src/index.ts") } },
    },
    test: {
      coverage: {
        thresholds: { lines: 80, branches: 70, functions: 70, statements: 80 },
      },
    },
  }),
);
