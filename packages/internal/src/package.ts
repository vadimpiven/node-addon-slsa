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

/**
 * `addon` block in package.json. All fields are required: hidden
 * conventions cause silent install failures when they drift, and an
 * explicit declaration is one extra line per consumer.
 *
 * `path` is the `.node` location inside `node_modules/<pkg>/`;
 * `manifest` is the SLSA manifest path inside the same tarball;
 * `attestWorkflow` is the filename of the GitHub Actions workflow that
 * mints provenance attestations for this package — the consumer-side
 * verifier pins the Fulcio Build Signer URI to
 * `<repo>/.github/workflows/<attestWorkflow>`, so attestations produced
 * by any other workflow (including new evil workflows added to the
 * same repo) are rejected. URLs are read from the manifest at install
 * time, not from here.
 */
const AddonConfigSchema = z.object({
  path: z.string().refine((path) => !path.split(/[/\\]/).includes("..") && path.endsWith(".node"), {
    message: "addon.path must be a relative .node file path",
  }),
  manifest: z
    .string()
    .refine((p) => !p.split(/[/\\]/).includes("..") && p.endsWith(".json"), {
      message: "addon.manifest must be a relative .json file path",
    }),
  attestWorkflow: z.string().regex(/^[A-Za-z0-9._-]+\.ya?ml$/, {
    message: 'addon.attestWorkflow must be a workflow filename like "release.yaml"',
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

/**
 * Extract GitHub `owner/repo` from a `repository` field. Returns null
 * when the format is unrecognized — callers treat that as "no trust
 * anchor in package.json."
 */
export function extractExpectedRepo(repository: Repository | undefined): GitHubRepo | null {
  if (!repository) return null;
  const raw = typeof repository === "string" ? repository : (repository.url ?? "");
  // Anchor to the full string and accept only the classic github.com forms:
  //   https://github.com/<owner>/<repo>(.git)?(/)?
  //   git://github.com/<owner>/<repo>(.git)?(/)?
  //   ssh://git@github.com/<owner>/<repo>(.git)?(/)?
  //   git@github.com:<owner>/<repo>(.git)?
  // Loose match (e.g. `https://github.com/foo/bar/baz.git`) must return
  // null rather than silently capturing the wrong owner/repo pair.
  const match = raw.match(
    /^(?:git\+)?(?:https?|git|ssh):\/\/(?:[^@/]*@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$|^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (!match) return null;
  const owner = match[1] ?? match[3];
  const repo = match[2] ?? match[4];
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
        attestWorkflow: "release.yaml",
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
            attestWorkflow: "release.yaml",
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
            attestWorkflow: "release.yaml",
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
          addon: { path: "./dist/test.node", attestWorkflow: "release.yaml" },
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
            attestWorkflow: "release.yaml",
          },
        }),
      );
      await expect(readPackageJson(tmp.path)).rejects.toThrow();
    });
  });
}
