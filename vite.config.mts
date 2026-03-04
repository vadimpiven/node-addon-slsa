import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { codecovVitePlugin } from "@codecov/vite-plugin";
import dts from "vite-plugin-dts";
import { defineConfig } from "vitest/config";

// Externalize all Node.js built-ins (with and without node: prefix)
const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
  define: {
    "import.meta.vitest": "undefined",
  },
  build: {
    lib: {
      entry: resolve("src/index.ts"),
      fileName: "index",
      formats: ["es"],
    },
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      external: nodeBuiltins,
      platform: "node",
    },
  },
  test: {
    watch: false,
    pool: "forks",
    passWithNoTests: true,
    coverage: {
      provider: "istanbul",
      reporter: ["lcovonly", "text"],
      reportsDirectory: "./coverage",
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
    reporters: ["default", ["junit", { outputFile: "report.junit.xml" }]],
    detectAsyncLeaks: false,
    includeSource: ["src/**/*.ts"],
    include: ["tests/**/*.test.ts"],
  },
  plugins: [
    dts({
      staticImport: true,
      entryRoot: "src",
    }),
    codecovVitePlugin({
      enableBundleAnalysis: process.env.CODECOV_TOKEN !== undefined,
      bundleName: "node-addon-slsa",
      uploadToken: process.env.CODECOV_TOKEN,
    }),
  ],
});
