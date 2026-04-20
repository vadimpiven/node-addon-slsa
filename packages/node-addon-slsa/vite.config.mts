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
          cli: resolve("src/cli.ts"),
        },
      },
    },
    test: {
      coverage: {
        thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
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
