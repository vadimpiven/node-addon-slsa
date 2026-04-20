import { builtinModules } from "node:module";
import dts from "vite-plugin-dts";
import type { UserConfig } from "vitest/config";

// Externalize all Node.js built-ins (with and without node: prefix).
const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

/**
 * Shared vite/vitest configuration for workspace packages. Each package
 * merges this with its own `build.lib.entry`, coverage thresholds, and any
 * package-specific plugins (e.g. codecov, sbom for the published one).
 */
export const baseConfig: UserConfig = {
  define: {
    "import.meta.vitest": "undefined",
  },
  // `source` condition resolves @node-addon-slsa/internal to src/ for vite
  // (outer lib build) and vitest. ncc-built Actions don't read vite config
  // and fall through to `default` → internal/dist, as intended.
  resolve: {
    conditions: ["source"],
  },
  build: {
    lib: { formats: ["es"] },
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      external: nodeBuiltins,
      // Rolldown (vite 8) uses this to emit proper Node `require` handling
      // for CJS deps inlined into the ESM bundle. Not a classic Rollup option.
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
      exclude: ["dist/**", "docs/**", "coverage/**"],
    },
    reporters: ["default", ["junit", { outputFile: "report.junit.xml" }]],
    detectAsyncLeaks: true,
    includeSource: ["src/**/*.ts"],
    include: ["tests/**/*.test.ts"],
  },
  plugins: [
    dts({
      staticImport: true,
      entryRoot: "src",
    }),
  ],
};
