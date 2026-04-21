import { resolve } from "node:path";
import { codecovVitePlugin } from "@codecov/vite-plugin";
import sbom from "rollup-plugin-sbom";
import { defineConfig, mergeConfig } from "vitest/config";

import { baseConfig } from "../vite.base.mts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    build: {
      lib: {
        entry: {
          index: resolve("src/index.ts"),
          advanced: resolve("src/advanced.ts"),
          cli: resolve("src/cli.ts"),
        },
      },
    },
    test: {
      coverage: {
        // Branch threshold relaxed slightly: loader.ts has platform-
        // dependent branches that don't light up on a single CI arch
        // (68% on its own), which keeps the whole-package average below
        // the 80% other packages hit.
        thresholds: { lines: 80, branches: 78, functions: 80, statements: 80 },
      },
    },
    plugins: [
      sbom({
        rootComponentType: "library",
        generateSerial: true,
      }),
      codecovVitePlugin({
        enableBundleAnalysis: process.env.CODECOV_TOKEN !== undefined,
        bundleName: "node-addon-slsa",
        uploadToken: process.env.CODECOV_TOKEN,
      }),
    ],
  }),
);
