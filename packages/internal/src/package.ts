// SPDX-License-Identifier: Apache-2.0 OR MIT

/** Parse and validate package.json: name, version, addon config, repository. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import dedent from "dedent";
import { z } from "zod/v4";

import { githubRepo, SEMVER_RE, type GitHubRepo, type SemVerString } from "./types.ts";

const SemVerStringSchema = z
  .string()
  .regex(SEMVER_RE)
  .transform((v) => v as SemVerString);

/** `addon` block: `.node` path and SLSA manifest path, both relative to the tarball root. */
const AddonConfigSchema = z.object({
  path: z.string().refine((path) => !path.split(/[/\\]/).includes("..") && path.endsWith(".node"), {
    message: "addon.path must be a relative .node file path",
  }),
  manifest: z.string().refine((p) => !p.split(/[/\\]/).includes("..") && p.endsWith(".json"), {
    message: "addon.manifest must be a relative .json file path",
  }),
});

const RepositorySchema = z.union([z.string(), z.object({ url: z.string().optional() })]);

const PackageJsonSchema = z.object({
  name: z.string().min(1),
  version: SemVerStringSchema,
  addon: AddonConfigSchema,
  repository: RepositorySchema.optional(),
});

type Repository = z.infer<typeof RepositorySchema>;
type PackageJson = z.infer<typeof PackageJsonSchema>;

/** Read and validate `<packageDir>/package.json`. Throws a formatted Zod error on schema failure. */
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

// Anchored to the full string so a nested path
// (`https://github.com/foo/bar/baz.git`) returns null instead of silently
// capturing the wrong owner/repo.
const GITHUB_URL_FORM =
  /^(?:git\+)?(?:https?|git|ssh):\/\/(?:[^@/]*@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const GITHUB_SCP_FORM = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/;

/** Returns null on unknown formats; callers treat that as "no trust anchor". */
export function extractExpectedRepo(repository: Repository | undefined): GitHubRepo | null {
  if (!repository) return null;
  const raw = typeof repository === "string" ? repository : (repository.url ?? "");
  const match = raw.match(GITHUB_URL_FORM) ?? raw.match(GITHUB_SCP_FORM);
  if (!match) return null;
  const [, owner, repo] = match;
  if (!owner || !repo) return null;
  try {
    return githubRepo(`${owner}/${repo}`);
  } catch {
    return null;
  }
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;
  const { writeFile } = await import("node:fs/promises");
  const { tempDir } = await import("./util/fs.ts");

  describe("extractExpectedRepo", () => {
    it("extracts from HTTPS URL with .git", ({ expect }) => {
      expect(extractExpectedRepo({ url: "git+https://github.com/owner/repo.git" })).toBe(
        "owner/repo",
      );
    });
    it("extracts from SSH URL", ({ expect }) => {
      expect(extractExpectedRepo("git@github.com:owner/repo.git")).toBe("owner/repo");
    });
    it("returns null for non-GitHub URL", ({ expect }) => {
      expect(extractExpectedRepo("https://gitlab.com/owner/repo")).toBeNull();
    });
    it("returns null for missing repository", ({ expect }) => {
      expect(extractExpectedRepo(undefined)).toBeNull();
    });
    it("returns null for nested GitHub paths (no silent miscapture)", ({ expect }) => {
      // Loose regex used to return "bar/baz" here, misidentifying the repo.
      expect(extractExpectedRepo("https://github.com/foo/bar/baz.git")).toBeNull();
    });
    it("returns null for unknown URL scheme", ({ expect }) => {
      expect(extractExpectedRepo("ftp://github.com/owner/repo")).toBeNull();
    });
    it("returns null for github.com as part of a different host", ({ expect }) => {
      expect(extractExpectedRepo("https://evil.com/github.com/owner/repo")).toBeNull();
    });
  });

  describe("readPackageJson", () => {
    const validPkg = {
      name: "test-pkg",
      version: "1.0.0",
      addon: {
        path: "./dist/test.node",
        manifest: "./slsa-manifest.json",
      },
      repository: { url: "git+https://github.com/owner/repo.git" },
    };

    it("reads a valid package.json", async ({ expect }) => {
      await using tmp = await tempDir();
      await writeFile(join(tmp.path, "package.json"), JSON.stringify(validPkg));
      const result = await readPackageJson(tmp.path);
      expect(result.name).toBe("test-pkg");
      expect(result.addon.path).toBe("./dist/test.node");
    });

    it("accepts a custom manifest path", async ({ expect }) => {
      await using tmp = await tempDir();
      await writeFile(
        join(tmp.path, "package.json"),
        JSON.stringify({
          ...validPkg,
          addon: {
            path: "./dist/test.node",
            manifest: "./custom/slsa.json",
          },
        }),
      );
      const result = await readPackageJson(tmp.path);
      expect(result.addon.manifest).toBe("./custom/slsa.json");
    });

    it("rejects traversal in addon.manifest", async ({ expect }) => {
      await using tmp = await tempDir();
      await writeFile(
        join(tmp.path, "package.json"),
        JSON.stringify({
          ...validPkg,
          addon: {
            path: "./dist/test.node",
            manifest: "../../etc/passwd.json",
          },
        }),
      );
      await expect(readPackageJson(tmp.path)).rejects.toThrow(
        /addon\.manifest must be a relative \.json file path/,
      );
    });

    it("rejects a missing addon.manifest", async ({ expect }) => {
      await using tmp = await tempDir();
      await writeFile(
        join(tmp.path, "package.json"),
        JSON.stringify({
          ...validPkg,
          addon: { path: "./dist/test.node" },
        }),
      );
      await expect(readPackageJson(tmp.path)).rejects.toThrow(/addon\.manifest/);
    });

    it("throws for missing package.json", async ({ expect }) => {
      await using tmp = await tempDir();
      await expect(readPackageJson(tmp.path)).rejects.toThrow();
    });

    it("rejects traversal in addon.path", async ({ expect }) => {
      await using tmp = await tempDir();
      await writeFile(
        join(tmp.path, "package.json"),
        JSON.stringify({
          ...validPkg,
          addon: {
            path: "../etc/evil.node",
            manifest: "./slsa-manifest.json",
          },
        }),
      );
      await expect(readPackageJson(tmp.path)).rejects.toThrow();
    });
  });
}
