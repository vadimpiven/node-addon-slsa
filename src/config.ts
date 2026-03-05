// SPDX-License-Identifier: Apache-2.0 OR MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import dedent from "dedent";
import { z } from "zod/v4";

import { githubRepo, SEMVER_RE } from "./types.ts";
import type { GitHubRepo, SemVerString } from "./types.ts";

const NPM_PACKAGE_NAME_RE = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const SemVerStringSchema = z
  .string()
  .regex(SEMVER_RE)
  .transform((v) => v as SemVerString);

// z.url() accepts template placeholders like {version} because
// curly braces are tolerated in URL paths by Node.js URL parser.
// Origin check works because placeholders are in the path, not the host.
const AddonConfigSchema = z.object({
  path: z.string().refine((path) => !path.split(/[/\\]/).includes("..") && path.endsWith(".node"), {
    message: `addon.path must be a relative .node file path`,
  }),
  url: z.url().refine((url) => new URL(url).origin === "https://github.com", {
    message: `addon.url must point to github.com`,
  }),
});

const RepositorySchema = z.union([z.string(), z.object({ url: z.string().optional() })]);

const PackageJsonSchema = z.object({
  name: z.string().regex(NPM_PACKAGE_NAME_RE),
  version: SemVerStringSchema,
  addon: AddonConfigSchema,
  repository: RepositorySchema,
});

type Repository = z.infer<typeof RepositorySchema>;
type PackageJson = z.infer<typeof PackageJsonSchema>;

/**
 * Read and parse package.json from the given directory.
 */
export async function readPackageJson(packageDir: string): Promise<PackageJson> {
  const raw = await readFile(join(packageDir, "package.json"), "utf8");
  try {
    return PackageJsonSchema.parse(JSON.parse(raw));
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues
        .map((issue) => {
          const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
          return `  ${path}${issue.message}`;
        })
        .join("\n");
      throw new Error(
        dedent`
          invalid ${join(packageDir, "package.json")}:
          ${issues}
        `,
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * Extract GitHub owner/repo from a repository field.
 * Supports HTTPS URLs, SSH URLs, and optional `.git` suffix.
 * Returns null if the format is not recognized.
 */
export function extractExpectedRepo(repository: Repository): GitHubRepo | null {
  const raw = typeof repository === "string" ? repository : (repository.url ?? "");
  const match = raw.match(/(?:^|[/@])github\.com[/:]+([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match?.[1]) return null;
  try {
    return githubRepo(match[1]);
  } catch {
    return null;
  }
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;

  describe("extractExpectedRepo", () => {
    it("extracts from HTTPS URL with .git suffix", ({ expect }) => {
      expect(
        extractExpectedRepo({
          url: "git+https://github.com/owner/repo.git",
        }),
      ).toBe("owner/repo");
    });

    it("extracts from HTTPS URL without .git suffix", ({ expect }) => {
      expect(extractExpectedRepo("https://github.com/owner/repo")).toBe("owner/repo");
    });

    it("extracts from SSH URL", ({ expect }) => {
      expect(extractExpectedRepo("git@github.com:owner/repo.git")).toBe("owner/repo");
    });

    it("returns null for non-GitHub URL", ({ expect }) => {
      expect(extractExpectedRepo("https://gitlab.com/owner/repo")).toBeNull();
    });

    it("returns null for empty string", ({ expect }) => {
      expect(extractExpectedRepo("")).toBeNull();
    });

    it("returns null for missing url in object", ({ expect }) => {
      expect(extractExpectedRepo({})).toBeNull();
    });
  });

  describe("readPackageJson", () => {
    it("reads valid package.json", async ({ expect }) => {
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { tempDir } = await import("./util/fs.ts");

      await using tmp = await tempDir();
      const pkg = {
        name: "test-pkg",
        version: "1.0.0",
        addon: {
          path: "./dist/test.node",
          url: "https://github.com/owner/repo/releases/download/v{version}/test.node.gz",
        },
        repository: {
          url: "git+https://github.com/owner/repo.git",
        },
      };
      await writeFile(join(tmp.path, "package.json"), JSON.stringify(pkg));

      const result = await readPackageJson(tmp.path);
      expect(result.name).toBe("test-pkg");
      expect(result.version).toBe("1.0.0");
      expect(result.addon.path).toBe("./dist/test.node");
    });

    it("throws for missing package.json", async ({ expect }) => {
      const { tempDir } = await import("./util/fs.ts");

      await using tmp = await tempDir();
      await expect(readPackageJson(tmp.path)).rejects.toThrow();
    });

    it("throws for missing required fields", async ({ expect }) => {
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { tempDir } = await import("./util/fs.ts");

      await using tmp = await tempDir();
      await writeFile(join(tmp.path, "package.json"), JSON.stringify({ name: "test" }));
      await expect(readPackageJson(tmp.path)).rejects.toThrow();
    });

    it("rejects non-github.com addon URL", async ({ expect }) => {
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { tempDir } = await import("./util/fs.ts");

      await using tmp = await tempDir();
      const pkg = {
        name: "test-pkg",
        version: "1.0.0",
        addon: {
          path: "./dist/test.node",
          url: "https://example.com/test-v{version}.node.gz",
        },
        repository: {
          url: "git+https://github.com/owner/repo.git",
        },
      };
      await writeFile(join(tmp.path, "package.json"), JSON.stringify(pkg));
      await expect(readPackageJson(tmp.path)).rejects.toThrow(
        /addon\.url must point to github\.com/,
      );
    });

    it("formats top-level type error without path prefix", async ({ expect }) => {
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { tempDir } = await import("./util/fs.ts");

      await using tmp = await tempDir();
      // Valid JSON but not an object — produces ZodError with empty path
      await writeFile(join(tmp.path, "package.json"), JSON.stringify("not an object"));
      await expect(readPackageJson(tmp.path)).rejects.toThrow(/invalid .*package\.json/);
    });

    it("throws for malformed JSON", async ({ expect }) => {
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { tempDir } = await import("./util/fs.ts");

      await using tmp = await tempDir();
      await writeFile(join(tmp.path, "package.json"), "not valid json");
      await expect(readPackageJson(tmp.path)).rejects.toThrow();
    });
  });
}
