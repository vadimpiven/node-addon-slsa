# Plan: unified addon provenance

`npm publish --provenance` rejects bundles built in internal or private
GitHub repos (server-side policy). This plan specifies one provenance flow
for every repo visibility — public, internal, or private — with no
per-visibility branches in the publisher workflow or the verifier.

## Usage

### Publisher `package.json`

```json
{
  "name": "my-native-addon",
  "version": "1.0.0",
  "repository": { "url": "git+https://github.com/owner/repo.git" },
  "addon": {
    "path": "./dist/my_addon.node",
    "manifest": "./dist/slsa-manifest.json"
  },
  "scripts": {
    "postinstall": "slsa wget",
    "pack-addon": "slsa pack"
  },
  "dependencies": { "node-addon-slsa": "1.0.0" }
}
```

- `addon.path` — install location inside the consumer's `node_modules`
  (consumer-side concern, not covered by provenance).
- `addon.manifest` — embedded manifest location inside the published
  tarball. Optional; defaults to `./slsa-manifest.json` at package root.
  Read by both the action and the verifier, keeping them in sync without a
  second input.

Binary URLs are not in `package.json` — they live in
`manifest.addons[platform][arch].url`, concrete per platform/arch,
filled in by the `publish-attested` action from its `addons` input.

### Publisher CI workflow

```yaml
jobs:
  build-addon:
    strategy:
      matrix: { os: [ubuntu-24.04, macos-15, windows-2025] }
    runs-on: ${{ matrix.os }}
    permissions:
      contents: read
      id-token: write # OIDC for attest-public → Rekor
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      # ... build the native addon ...
      - run: npx slsa pack
      - uses: vadimpiven/node-addon-slsa/attest-public@<sha>
        with:
          subject-path: dist/my_addon-v*.node.gz
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: addon-${{ matrix.os }}
          path: dist/my_addon-v*.node.gz

  publish:
    needs: build-addon
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      - uses: actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f # v6.3.0
        with: { registry-url: https://registry.npmjs.org }
      - run: npm ci
      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with: { path: ./artifacts }

      # Upload first — publish-attested fetches each URL and verifies the
      # bytes have a Rekor entry from the current run before npm publish.
      - run: |
          aws s3 cp ./artifacts/ubuntu-24.04/my_addon-v1.0.0-linux-x64.node.gz \
                    s3://.../v1.0.0/my_addon-v1.0.0-linux-x64.node.gz
          # ... etc per platform

      - working-directory: packages/node
        run: pnpm pack # or npm pack / yarn pack

      - uses: vadimpiven/node-addon-slsa/publish-attested@<sha>
        with:
          tarball: packages/node/my-native-addon-1.0.0.tgz
          addons: |
            {
              "linux":  {
                "x64":   "https://.../v1.0.0/my_addon-v1.0.0-linux-x64.node.gz",
                "arm64": "https://.../v1.0.0/my_addon-v1.0.0-linux-arm64.node.gz"
              },
              "darwin": {
                "arm64": "https://.../v1.0.0/my_addon-v1.0.0-darwin-arm64.node.gz"
              }
            }
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

No `id-token: write` in the publish job, no `--provenance`: matrix jobs
hold OIDC tokens scoped to a single binary; the publish job holds only the
npm token. Upload-before-publish ordering is load-bearing — the action
refuses to publish if any URL serves bytes without a matching Rekor entry
from the current run.

### Consumer install

`npm install my-native-addon` runs `slsa wget` via `postinstall`:

1. Read the embedded manifest from the installed package. Location: the
   consumer's `package.json` → `addon.manifest` (default
   `./slsa-manifest.json`). Trust: npm's `dist.integrity` sha512 covers
   the tarball; `dist.signatures` is TUF-backed via npm keys.
2. Look up `manifest.addons[process.platform]?.[process.arch]`.
   Download from `url`, verify sha256.
3. Rekor lookup on sha256. Cross-check cert OIDs against the manifest
   (issuer, `sourceRepo`, `sourceCommit`, `sourceRef`,
   `runInvocationURI`).

Any failure aborts install with `SECURITY`.

### Programmatic verification

```typescript
import { verifyPackageManifest, sha256Hex, githubRepo } from "node-addon-slsa";

const provenance = await verifyPackageManifest({
  packageName: "my-native-addon",
  repo: githubRepo("owner/repo"),
});
await provenance.verifyAddon({ sha256: sha256Hex(hex) });
```

No `version` input: the manifest is read from the installed tarball, so
version is implicit in what's on disk.

## Flow

```text
                     ┌──────────────┐
     build matrix ──▶│ attest-public│──▶ Rekor entries (per binary)
                     └──────────────┘
     caller uploads binaries to their declared URLs (S3 / CDN / Releases)
                     ┌───────────────────┐
     publish job  ──▶│ publish-attested  │──▶ fetch URLs, verify Rekor,
                     └───────────────────┘    build manifest, inject into
                                              tarball, npm publish

     install:  read manifest → download url → verify sha256 → Rekor lookup
               → cross-check cert OIDs (repo, commit, ref, runInvocationURI)
```

## Trust-boundary pivot

npm's client verifies `dist.integrity` (sha512) against the tarball
**before** any `postinstall` runs; `dist.signatures` is TUF-backed via
npm keys. Reading the embedded manifest from the installed package is
therefore equivalent to trusting `dist.integrity` — the verifier does
not re-sign npm artifacts. Per-binary trust comes from Rekor lookup plus
cert-OID cross-check against the (trusted) manifest.

## Manifest schema

Embedded in the npm tarball at the path declared by `addon.manifest` in
`package.json` (default `./slsa-manifest.json`). Single authoritative copy
per release, covered by `dist.integrity` regardless of location.

```jsonc
{
  "$schema": "https://vadimpiven.github.io/node-addon-slsa/schema/slsa-manifest.v1.json",
  "runInvocationURI": "https://github.com/owner/repo/actions/runs/123/attempts/1",
  "sourceRepo": "owner/repo",
  "sourceCommit": "<40-hex>",
  "sourceRef": "refs/tags/v1.2.3",
  "addons": {
    "linux": {
      "x64": { "url": "https://.../addon-linux-x64.node.gz", "sha256": "..." },
      "arm64": {
        "url": "https://.../addon-linux-arm64.node.gz",
        "sha256": "...",
      },
    },
    "darwin": {
      "x64": { "url": "https://.../addon-darwin-x64.node.gz", "sha256": "..." },
      "arm64": {
        "url": "https://.../addon-darwin-arm64.node.gz",
        "sha256": "...",
      },
    },
    "win32": {
      "x64": { "url": "https://.../addon-win32-x64.node.gz", "sha256": "..." },
      "arm64": {
        "url": "https://.../addon-win32-arm64.node.gz",
        "sha256": "...",
      },
    },
  },
}
```

Outer keys are Node's `process.platform` (`darwin | linux | win32` — the
Electron-supported set); inner keys are `process.arch`
(`x64 | arm64 | arm | ia32`; `process.arch` reports `arm` for Electron's
`armv7l` builds). Nesting avoids listing the cartesian product and scopes
the schema to the Electron matrix. Installer reads
`manifest.addons[process.platform]?.[process.arch]`.

The `$schema` URL is a version marker matched by exact string equality —
the verifier never fetches it. See "Publishing the schema" below for the
v1 → v2 bump policy.

### Publishing the schema

Zod schemas in `package/src/schemas.ts` are the single source of truth;
JSON Schemas are pure build output, regenerated on every build and
written straight into `package/docs/schema/` (no repo-root `schema/`
dir, no check-in). Zod 4's built-in `z.toJSONSchema()` handles the
conversion — no extra runtime dep.

Schemas to export are registered by their target filename:

```typescript
// package/src/schemas.ts (excerpt)
export const PublishedSchemas = {
  "slsa-manifest.v1.json": SlsaManifestSchemaV1,
  // future: "slsa-manifest.v2.json": SlsaManifestSchemaV2,
} as const;
```

A helper script iterates the registry and writes each schema:

```typescript
// package/scripts/generate-schemas.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { PublishedSchemas } from "../src/schemas.ts";

const outDir = new URL("../docs/schema/", import.meta.url);
mkdirSync(outDir, { recursive: true });
for (const [name, schema] of Object.entries(PublishedSchemas)) {
  const json = z.toJSONSchema(schema, { target: "draft-7" });
  writeFileSync(new URL(name, outDir), JSON.stringify(json, null, 2) + "\n");
}
```

Wired into the package `build` script after docs are generated:

```json
"build": "vite build && typedoc && node scripts/generate-schemas.ts"
```

No runner dep — the build runs on latest Node, which executes
TypeScript natively. Resulting URL:
`https://vadimpiven.github.io/node-addon-slsa/schema/<file>.json`.

Versioning is explicit in the registry key. An incompatible change
means adding a new entry (`slsa-manifest.v2.json`) alongside the frozen
`SlsaManifestSchemaV1`, so the v1 file keeps regenerating identically
and old manifests keep validating against the same URL. The verifier
is taught to accept both `$schema` URLs manually — the generator
doesn't decide when to bump.

## `publish-attested` action

Location: `publish-attested/` alongside `attest-public/`. Packaging
mirrors `attest-public/`: `action.yaml`, `index.ts`, `dist/index.js`,
`node24` runtime, `@vercel/ncc` bundling, dev deps via pnpm `catalog:`,
runtime dep `node-addon-slsa` (`workspace:*`).

Fetches each declared URL, verifies the bytes have a Rekor entry from the
current workflow run, builds the manifest, injects it into a pre-packed
`.tgz`, and runs `npm publish <tgz>`. Caller uploads binaries to the
declared URLs _before_ calling this action.

### Interface

```yaml
inputs:
  addons:
    description: >
      Nested JSON object: `{ [platform]: { [arch]: url } }` using Node's
      `process.platform` / `process.arch` values. Each leaf is the URL
      where the binary is already hosted.
    required: true
  tarball:
    description: Path to the input .tgz (already packed).
    required: true
  access:
    description: npm publish --access value (public|restricted).
    default: public
  tag:
    description: npm dist-tag. Omitted → npm defaults to `latest`.
    required: false
```

No outputs. The action's externally-observable effect is `npm publish`
itself.

Input Zod schema — identical key-shape to the manifest output. The caller
provides URLs they've already uploaded; `sha256` is computed by the
action itself, so it is not part of the input:

```typescript
// Re-used from package/src/verify/schemas.ts:
//   PlatformSchema, ArchSchema, Platform, Arch
const AddonUrlMapSchema = z.record(
  PlatformSchema,
  z.record(ArchSchema, z.string().url()),
);
export type AddonUrlMap = z.infer<typeof AddonUrlMapSchema>;
```

### Behaviour

```typescript
// Pseudocode. `addons` is the parsed AddonUrlMap input.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  verifyAttestation,
  sha256Hex,
  githubRepo,
  runInvocationURI,
  assertWithinDir,
  type AddonEntry,
  type AddonInventory,
} from "node-addon-slsa";

const MAX_BINARY_BYTES = 256 * 1024 * 1024; // 256 MB

const repo = githubRepo(process.env.GITHUB_REPOSITORY);
const runURI = runInvocationURI(
  `https://github.com/${process.env.GITHUB_REPOSITORY}` +
    `/actions/runs/${process.env.GITHUB_RUN_ID}` +
    `/attempts/${process.env.GITHUB_RUN_ATTEMPT}`,
);

// 1. Per URL: fetch (size-capped), hash, verify Rekor entry from THIS run.
//    Fails loud on wrong upload, stale cache, oversize, or missing Rekor.
//    Key-shape is preserved 1:1 from input to output; only the sha256 is
//    added, so there is no pivot or remapping.
const verifiedAddons: AddonInventory = {};
for (const [platform, byArch] of Object.entries(addons)) {
  for (const [arch, url] of Object.entries(byArch ?? {})) {
    const label = `${platform}/${arch}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${label}: ${url} → ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_BINARY_BYTES) {
      throw new Error(`${label}: Content-Length ${declared} exceeds 256 MB`);
    }
    const bytes = await readWithCap(res.body, MAX_BINARY_BYTES); // aborts mid-stream
    const sha256 = sha256Hex(createHash("sha256").update(bytes).digest("hex"));
    await verifyAttestation({ sha256, runInvocationURI: runURI, repo });
    const entry: AddonEntry = { url, sha256 };
    (verifiedAddons[platform] ??= {})[arch] = entry;
  }
}

// 2. Build manifest — fields match the schema 1:1; no reshaping.
const manifest: SlsaManifest = {
  $schema: SLSA_MANIFEST_V1_SCHEMA_URL,
  runInvocationURI: runURI,
  sourceRepo: process.env.GITHUB_REPOSITORY,
  sourceCommit: process.env.GITHUB_SHA,
  sourceRef: process.env.GITHUB_REF,
  addons: verifiedAddons,
};
const manifestJson = JSON.stringify(manifest, null, 2);

// 3. Unpack tarball. Resolve `addon.manifest` from its package.json.
//    Reject path traversal; refuse to overwrite a pre-existing manifest.
const work = await mkdtemp(join(tmpdir(), "publish-attested-"));
execSync(`tar -xzf "${tarball}" -C "${work}"`);
const pkgRoot = `${work}/package`;
const pkg = JSON.parse(await readFile(`${pkgRoot}/package.json`, "utf8"));
const manifestRel = pkg.addon?.manifest ?? DEFAULT_MANIFEST_PATH;
const manifestAbs = resolve(pkgRoot, manifestRel);

assertWithinDir({
  baseDir: pkgRoot,
  target: manifestAbs,
  label: "addon.manifest",
});

if (await pathExists(manifestAbs)) {
  throw new Error(
    `refusing to overwrite existing ${manifestRel} inside the tarball; ` +
      `the pre-packed .tgz must not ship a manifest. Check "files"/"npmignore".`,
  );
}

// 4. Embed manifest, repack, publish.
await mkdir(dirname(manifestAbs), { recursive: true });
await writeFile(manifestAbs, manifestJson);
const out = `${tarball}.with-manifest.tgz`;
execSync(`tar -czf "${out}" -C "${work}" package`);

const args = ["publish", out, "--access", access];
if (tag) args.push("--tag", tag);
execSync(`npm ${args.map((a) => `"${a}"`).join(" ")}`, { stdio: "inherit" });
```

Env vars read: `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`,
`GITHUB_SHA`, `GITHUB_REF`. Fail fast if any is missing. See
`https://docs.github.com/en/actions/learn-github-actions/variables`.

### Design notes

- **URL is the source of truth.** Manifest records what the installer will
  actually see. The action downloads, hashes the served bytes, and writes
  that hash. Publish-time Rekor verification catches typos in S3 keys,
  stale CDN caches, wrong-bucket uploads, and binaries rebuilt outside the
  matrix before any customer sees the bad version.
- **Shared verification code.** `verifyAttestation` is imported from
  `node-addon-slsa` (workspace link; ncc inlines into `dist/index.js`).
  One copy of Rekor/Fulcio logic, same trust anchors, same retry defaults
  for the ~30s Rekor ingestion lag.
- **Caller packs, action repacks.** Pre-packed `.tgz` input makes the
  action package-manager-agnostic. Local tarball bit-stability doesn't
  matter: `dist.integrity` is computed by `npm publish` over whatever
  bytes we hand it. mtime, ordering, gzip level are all invisible. The
  `package/` entry prefix is the npm convention; `tar -xzf` preserves it,
  `tar -czf -C "$work" package` recreates it.
- **Minimal input surface.** `addons` + `tarball` are required; `access` /
  `tag` have pit-of-success defaults. Repo / run ID / commit / ref are
  ambient env — making them inputs would invite stale-value overrides
  that break Rekor cross-check. `addons` key-shape is identical to the
  manifest's `AddonInventory`; only `sha256` (computed by the action)
  is added, so there is no mid-flight remapping.
- **Typed `access` / `tag` instead of `publish-args`.** Both vary per
  publish and are orthogonal to provenance (access gates _download_, not
  verification; tag is registry-side metadata). Structurally blocks
  `--provenance` smuggling. `--registry` and auth belong in `.npmrc` via
  `setup-node`. `--workspace(s)` / `--dry-run` / `--otp` /
  `--ignore-scripts` / `--json` are not meaningful for a pre-packed
  `.tgz` in CI.
- **Privilege separation.** `NODE_AUTH_TOKEN` lives in the caller's
  `env:` and is used only by `npm publish`. No `id-token: write`.
  `attest-public`'s per-matrix-job OIDC scoping remains the load-bearing
  trust boundary — publish-side code can never forge a Rekor entry.
- **Hardening.**
  - **Public URLs only.** No auth flow. Private-bucket publishers use a
    public CDN or prior-step presigned URL (mind expiry).
  - **256 MB hard cap per binary.** Enforced on `Content-Length`
    (fail-fast) and mid-stream (abort if header absent or lying).
  - **Path traversal rejected** via `assertWithinDir` from
    `package/src/util/fs.ts`.
  - **No overwrite** of pre-existing manifest in the tarball.

## Verifier

### `constants.ts`

```typescript
/** Default manifest path; overridden by package.json's `addon.manifest`. */
export const DEFAULT_MANIFEST_PATH = "slsa-manifest.json";

/** Fulcio OID for source repository commit digest. */
export const OID_SOURCE_REPO_DIGEST = "1.3.6.1.4.1.57264.1.13";
/** Fulcio OID for source repository ref (e.g. "refs/tags/v1.2.3"). */
export const OID_SOURCE_REPO_REF = "1.3.6.1.4.1.57264.1.14";
```

Existing OIDs: `OID_ISSUER_V1` (`.1.1`), `OID_ISSUER_V2` (`.1.8`),
`OID_SOURCE_REPO_URI` (`.1.12`), `OID_RUN_INVOCATION_URI` (`.1.21`).
Fulcio registry:
`https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md`.

### `schemas.ts` — manifest schema + domain types

Single source of truth for the manifest shape. All types are named and
exported so both the verifier and `publish-attested` consume the same
concepts under the same names.

```typescript
export const SLSA_MANIFEST_V1_SCHEMA_URL =
  "https://vadimpiven.github.io/node-addon-slsa/schema/slsa-manifest.v1.json";

export const PlatformSchema = z.enum(["darwin", "linux", "win32"]);
export const ArchSchema = z.enum(["x64", "arm64", "arm", "ia32"]);
export type Platform = z.infer<typeof PlatformSchema>;
export type Arch = z.infer<typeof ArchSchema>;

export const AddonEntrySchema = z.object({
  url: z.string().url().startsWith("https://"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AddonEntry = z.infer<typeof AddonEntrySchema>;

export const AddonInventorySchema = z.record(
  PlatformSchema,
  z.record(ArchSchema, AddonEntrySchema),
);
export type AddonInventory = z.infer<typeof AddonInventorySchema>;

export const SlsaManifestSchema = z.object({
  $schema: z.literal(SLSA_MANIFEST_V1_SCHEMA_URL),
  runInvocationURI: RunInvocationURISchema,
  sourceRepo: GitHubRepoSchema,
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  sourceRef: z.string().regex(/^refs\/(tags|heads)\//),
  addons: AddonInventorySchema,
});
export type SlsaManifest = z.infer<typeof SlsaManifestSchema>;
```

Validation rules, in prose:

- `$schema` equals `SLSA_MANIFEST_V1_SCHEMA_URL` exactly (no network).
- `runInvocationURI`, `sourceRepo` reuse the existing branded validators.
- `sourceCommit` is 40-hex; `sourceRef` starts with `refs/tags/` or
  `refs/heads/`.
- `addons` keys are closed under the Electron-supported platform/arch
  set; unknown keys reject.

### `certificates.ts` — `verifyCertificateOIDs`

```typescript
export type CertificateOIDExpectations = {
  sourceCommit: SourceCommitSha; // exact match against OID_SOURCE_REPO_DIGEST
  sourceRef: SourceRef; // regex match against OID_SOURCE_REPO_REF
  runInvocationURI: RunInvocationURI; // exact match against OID_RUN_INVOCATION_URI
};

export function verifyCertificateOIDs(
  cert: X509Certificate,
  repo: GitHubRepo,
  expect: CertificateOIDExpectations,
): void;
```

All three fields required. Helpers reused: `getExtensionValue(cert, oid)`,
`extractCertFromBundle(bundle)`.

### `verify.ts` — `verifyPackageManifest`

Sole entry point for package verification. Returns `PackageProvenance`
with `verifyAddon({ sha256 })`.

```typescript
export type VerifyPackageManifestOptions = VerifyOptions & {
  /** Installed package to verify (resolved from the caller's node_modules). */
  packageName: PackageName;
  /** Expected source repository; cross-checked against the manifest. */
  repo: GitHubRepo;
  /**
   * Expected tag/branch ref pattern. Defaults to
   * `^refs/tags/v?<escaped-package-version>$`, which pins a consumer
   * install to the exact tag that produced it. Override for monorepo
   * prefixes (`pkg-v1.2.3`), scoped tags, or release branches.
   */
  refPattern?: RegExp;
};

export async function verifyPackageManifest(
  options: VerifyPackageManifestOptions,
): Promise<PackageProvenance>;
```

Behaviour:

1. Read `${packageName}/package.json`; get `version` and `addon.manifest`.
2. Load + zod-parse the manifest at `addon.manifest` (default
   `DEFAULT_MANIFEST_PATH`) relative to the package root.
3. Assert `manifest.sourceRepo` equals `options.repo` (case-insensitive).
4. Assert `manifest.sourceRef` matches `options.refPattern`
   (default derived from installed version).
5. Return a `PackageProvenance` whose `verifyAddon({ sha256 })` does:
   (a) Rekor lookup on `sha256`; (b) cross-check each Rekor cert's OIDs
   against the manifest — issuer, `sourceRepo`, `sourceCommit`,
   `sourceRef`, `runInvocationURI`.

Progressive-disclosure notes:

- Common case is `verifyPackageManifest({ packageName, repo })`;
  everything else derives from the installed `package.json`.
- No `manifestPath` option — the manifest location is an internal detail
  resolved from `package.json`. Tests construct their own fixtures with
  a valid enclosing `package.json`; they don't need a separate override
  for the public API to be correct.
- Sigstore cert verification happens inside `verifyRekorAttestations`
  per Rekor entry (Fulcio CAs + Rekor key via TUF) — hidden from this
  entry point.

### CLI — `commands.ts`

```typescript
const provenance = await verifyPackageManifest({ packageName, repo, ... });
await provenance.verifyAddon({ sha256 });
```

Single-path call. A package with no `addon.manifest` and no
`slsa-manifest.json` at the default location fails loud — it wasn't
published with this toolkit.

### Public API

`verifyPackageManifest` is the primary entry point.
`verifyAttestation` is a standalone primitive for verifying a single
binary's Rekor entry without a manifest — used by `publish-attested`:

```typescript
export type VerifyAttestationOptions = VerifyOptions & {
  sha256: Sha256Hex;
  runInvocationURI: RunInvocationURI;
  repo: GitHubRepo;
};

export async function verifyAttestation(
  options: VerifyAttestationOptions,
): Promise<void>;
```

Wraps `verifyRekorAttestations` with trust-material loading and retry.

`assertWithinDir` is re-exported from the top-level `node-addon-slsa`
entry as a named helper (no `/internal` subpath — the publicly exposed
surface is either public API or it isn't; there's no middle tier).

### Existing building blocks reused

- `package/src/verify/rekor.ts` — `verifyRekorAttestations(...)`.
- `package/src/util/fs.ts` — `assertWithinDir({ baseDir, target, label })`
  path-traversal guard; reused by `publish-attested` for `addon.manifest`.
- `package/src/types.ts` — branded types + validators (`sha256Hex`,
  `semVerString`, `githubRepo`, `runInvocationURI`).
- `package/src/cli.ts`, `package/src/commands.ts` — CLI entry.
- Tests: inline under `if (import.meta.vitest)` per
  `package/src/verify/certificates.ts`.

## Trust model

Trusts GitHub Actions (build environment, attestation authority) and the
sigstore public-good instance (Fulcio CA, Rekor). Compromise of either
breaks verification. The per-matrix-job OIDC-scoped attestation is the
load-bearing trust boundary: publish-side code can never forge a Rekor
entry for a binary it didn't build.

| Attack                                      | Caught at                  | By                                                                                                                                   |
| ------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Wrong bytes uploaded to a declared URL      | Publish time               | `publish-attested` fetches + Rekor-verifies each URL before `npm publish`                                                            |
| Swapped `.node` on CDN/S3 after publish     | Install time               | Rekor miss (no entry for tampered sha256)                                                                                            |
| Swapped npm tarball                         | Install time               | `dist.integrity` sha512 mismatch                                                                                                     |
| Binary from unrelated legit run             | Publish time (install too) | Rekor cert's `sourceRepo` + `runInvocationURI` must match current run                                                                |
| Fake run URI in manifest                    | Install time               | No Rekor entry matches URI + hash                                                                                                    |
| `workflow_dispatch` on feature branch       | Install time               | Manifest `sourceRef` + installer `refPattern` mismatch                                                                               |
| Compromised publish runner forging manifest | Install time               | Cannot launder binaries — Rekor lookup on malicious hash fails; can only lie about version label, not exploitable for code execution |

## Privacy

`attest-public` logs to public Rekor. Its Sigstore cert reveals
`owner/repo`, commit SHA, workflow path, ref. Internal/private-repo
publishers accept this by using `attest-public`; public-repo publishers
are unaffected. The manifest adds no new leakage — it restates what's
already in public Rekor entries.

## Implementation

### New files

- `publish-attested/action.yaml`
- `publish-attested/index.ts`
- `publish-attested/package.json` (mirror `attest-public/package.json`;
  `"dependencies": { "node-addon-slsa": "workspace:*" }`; devDeps
  `@actions/core`, `@types/node`, `@vercel/ncc`, `typescript`, `zod`
  via `catalog:`)
- `publish-attested/tsconfig.json` (copy from `attest-public/`)
- `publish-attested/dist/index.js` (generated by `ncc`, committed per
  `attest-public/` precedent)

### Modified files

- `pnpm-workspace.yaml` — register `publish-attested`
- `package/src/verify/constants.ts` — `DEFAULT_MANIFEST_PATH` + 2 OIDs
- `package/src/verify/schemas.ts` — add `SlsaManifestSchema`
- `package/src/verify/certificates.ts` — `verifyCertificateOIDs` takes
  required `sourceCommit` / `sourceRef` / `runInvocationURI`
- `package/src/verify/verify.ts` — `verifyPackageManifest` as primary
  entry point; `verifyAttestation` exported for standalone binary
  verification
- `package/src/verify/index.ts` — export new symbols
- `package/src/index.ts` — re-export
- `package/src/commands.ts` — `slsa wget` calls
  `verifyPackageManifest` directly
- `README.md`, `package/README.md` — document the unified flow

### Deletions

- `package/src/verify/npm.ts` (no `fetchNpmAttestations` consumer)
- `NpmAttestationsSchema` from `schemas.ts`
- `verifyPackageProvenance` from `verify.ts`
  (`verifyAddonProvenance` → `verifyAttestation`, same wrapper)
- `OID_SOURCE_REPO_VISIBILITY` (no code path asserts it)

### Testing

Inline under `if (import.meta.vitest)`.

`SlsaManifestSchema`:

- Valid manifest parses; branded types returned.
- `$schema` mismatch (wrong URL, missing field) rejected.
- Each missing required field rejected (one test per field).
- Non-hex sha256, non-https url, malformed `runInvocationURI` rejected.
- Unknown `addons` platform key (e.g. `freebsd`) or arch key (e.g.
  `riscv64`) rejected.

`verifyCertificateOIDs`: one accept + one reject per field
(`sourceCommit`, `sourceRef`, `runInvocationURI`). Mock `X509Certificate`
per `certificates.ts` precedent.

`verifyPackageManifest`:

- Happy path via mocked `verifyRekorAttestations`.
- `manifest.sourceRepo` mismatch → `ProvenanceError`.
- `manifest.sourceRef` fails `refPattern` → throws.
- Version `1.2.3` accepts `refs/tags/1.2.3` and `refs/tags/v1.2.3`,
  rejects `refs/tags/v1.2.4`, `refs/heads/main`.
- Version with regex metacharacters (`1.2.3-rc.1`, `1.2.3+build.1`)
  correctly escaped.
- Explicit `refPattern` overrides derived default.
- Fixtures construct a real package dir with `package.json` +
  co-located `slsa-manifest.json`; no public override for manifest path.
- Rekor cert's `sourceCommit` / `runInvocationURI` disagreement → throws.

`publish-attested/index.ts` (real temp dir + fixtures):

- Happy path (mocked `fetch` + `verifyAttestation`).
- Wrong URL bytes → `verifyAttestation` rejects → fails before
  `npm publish`.
- Rekor ingestion-lag: first call rejects, retry resolves.
- `Content-Length` > 256 MB → reject before body read.
- Stream past 256 MB without declared length → mid-stream abort.
- Non-2xx HTTP → error with URL + status.
- Manifest construction from `GITHUB_*` env + verified hashes.
- Round-trip with default `addon.manifest` (output contains
  `package/slsa-manifest.json`).
- Round-trip with nested `addon.manifest` (parent dirs created).
- `addon.manifest = "../escape.json"` → `assertWithinDir` rejects.
- Pre-packed tarball already contains `addon.manifest` path → refuses
  to overwrite.
- Missing env var → actionable error (via `vi.stubEnv`).
- `execSync` stubbed for `npm publish` (no registry call).

No new Rekor network fixtures — `rekor.ts` tests cover that surface.

### Steps

1. `DEFAULT_MANIFEST_PATH` + 2 OIDs in `verify/constants.ts`.
2. `SlsaManifestSchema` in `verify/schemas.ts`.
3. `verifyCertificateOIDs` signature change in `verify/certificates.ts`.
4. Rename `verifyAddonProvenance` → `verifyAttestation` in
   `verify/verify.ts`. Add `verifyPackageManifest`. Update
   `verify/index.ts` and top-level `index.ts` exports.
5. `commands.ts` calls `verifyPackageManifest` directly.
6. Delete `verify/npm.ts`, `NpmAttestationsSchema`,
   `verifyPackageProvenance`, `OID_SOURCE_REPO_VISIBILITY`.
7. Add `publish-attested/` package to workspace. Reuse build tooling
   from `attest-public/`.
8. Inline tests per Testing above.
9. Update `README.md` (root + package) for the unified flow; add
   `publish-attested/` README in `attest-public/` style.
10. Release `v1.0.0` (breaking; no existing users).

## Out of scope

- PyPI / maturin parallel (different trust infrastructure).
- Non-GitHub CI providers. Manifest schema is GitHub-specific by design.
- Bundled attestation format (sigstore bundle inside the tarball).
  Rejected in favour of Rekor-lookup-by-hash for simplicity.
