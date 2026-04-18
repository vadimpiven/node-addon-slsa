# Unified addon provenance

`npm publish --provenance` rejects bundles from internal/private GitHub repos (server-side
policy). This design delivers one provenance flow for every repo visibility, entered via a
single `uses:` of a reusable workflow that attests binaries and publishes the tarball.

Two mechanisms carry the trust:

- **Per-binary attestations** via `actions/attest-build-provenance` run inside the reusable
  workflow at `vadimpiven/node-addon-slsa/.github/workflows/publish.yaml`. The Fulcio cert's
  Build Signer URI (OID `.1.9`) pins attestations to that workflow path — no other workflow
  can mint a matching cert.
- **npm trusted publishing (OIDC)** replaces long-lived `NODE_AUTH_TOKEN`. npm validates the
  caller's top-level `workflow_ref` (not the reusable's `job_workflow_ref`), so each publisher
  registers their own release workflow as the trusted publisher on npmjs. Consumer trust in
  the tarball flows from npm's `dist.integrity` (TUF-backed).

Scope: GitHub (public or private) → npmjs.org. Non-GitHub CI and non-npmjs registries
(Verdaccio, GitHub Packages, Artifactory) are out of scope.

## Flow

```text
     build matrix ──▶ upload binaries as GH artifacts (no id-token)
     pack step    ──▶ upload .tgz as GH artifact (no id-token)
     upload step  ──▶ push binaries to declared URLs (S3 / CDN / Releases)

                      ┌────────────────────────────────────────────────┐
     caller's    ──▶  │ vadimpiven/node-addon-slsa/.github/            │
     publish          │   workflows/publish.yaml@<sha>                 │
     job              │   (id-token: write; attestations: write)       │
                      │                                                │
                      │   ├─ attest-build-provenance ──▶ Rekor         │
                      │   ├─ fetch URLs, verify Rekor + signer pin     │
                      │   ├─ build manifest, inject into .tgz          │
                      │   └─ npm publish  (trusted publishing)         │
                      └────────────────────────────────────────────────┘

     install: read manifest → download url → verify sha256 → Rekor lookup
              → cross-check cert OIDs → assert manifest.packageName matches
                installed package.json.name
```

## Trust model

Trusts: GitHub Actions (build env), Sigstore public-good (Fulcio CA and Rekor), npmjs (TUF
root and registry). Compromise of any of these breaks verification.

Each row: **attack** _(caught at)_ — defence.

- **Wrong bytes uploaded to a declared URL** _(publish)_ — `publish-attested` fetches and
  Rekor-verifies each URL before `npm publish`.
- **Swapped `.node` on CDN/S3 after publish** _(install)_ — Rekor miss (no entry for the
  tampered sha256).
- **Swapped npm tarball** _(install)_ — `dist.integrity` sha512 mismatch.
- **Binary from unrelated legit run** _(publish + install)_ — Rekor cert's `sourceRepo`
  and `runInvocationURI` must match the current run.
- **Fake run URI in manifest** _(install)_ — no Rekor entry matches URI + hash.
- **`workflow_dispatch` on feature branch** _(schema + install)_ — schema rejects
  non-`refs/tags/` `sourceRef`; installer `refPattern` derived from version.
- **Attestation minted by an unrelated workflow** _(publish + install)_ — Build Signer URI
  pin rejects certs whose URI is not the reusable `publish.yaml` workflow path.
- **Monorepo sibling binary laundered into a different package** _(install)_ —
  `manifest.packageName === package.json.name` catches it (Fulcio has no npm-name claim;
  `sourceRef` + `sourceRepo` don't disambiguate siblings).
- **Caller pins reusable workflow at a mutable tag** _(publish + install)_ —
  `DEFAULT_ATTEST_SIGNER_PATTERN` is SHA-only (`@<40-hex>`); tag-pinned `uses:` mints
  certs that fail the pattern.

Privacy: the reusable workflow logs to public Rekor. The Sigstore cert reveals `owner/repo`,
commit SHA, workflow path, ref. Internal/private-repo publishers accept this by opting in;
the manifest restates what's already in public Rekor entries.

## Publisher

### `package.json`

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

- `addon.path` — the `.node` binary. Input for `slsa pack`; also the consumer-side install
  location under `node_modules/<pkg>/`.
- `addon.manifest` — embedded manifest location inside the tarball. Optional; default
  `./slsa-manifest.json` at package root. Read by both the publish action and the verifier.

`slsa pack [output]` gzips `addon.path`. Default output is `{addon.path}.gz`. The publisher
uploads the gzipped file anywhere; filename is not covered by provenance (bytes are hashed,
URLs live in the manifest).

Binary URLs are filled in the manifest by the reusable workflow from its `addons` input.

### CI workflow

```yaml
jobs:
  # Build-only: no id-token. Upload binaries as GH artifacts.
  build-addon:
    strategy:
      matrix: { os: [ubuntu-24.04, macos-15, windows-2025] }
    runs-on: ${{ matrix.os }}
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      # ... build the native addon ...
      - run: npx slsa pack # writes ./dist/my_addon.node.gz
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: addon-${{ matrix.os }}
          path: dist/my_addon.node.gz

  # Pack tarball once; upload as artifact for the reusable workflow to pick up.
  pack-tarball:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      - run: npm ci
      - working-directory: packages/node
        run: pnpm pack # or npm pack / yarn pack
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: tarball
          path: packages/node/my-native-addon-*.tgz

  # Push binaries to declared URLs. No id-token — this job is arbitrary caller code.
  # The reusable workflow re-fetches and verifies bytes before publishing.
  upload-binaries:
    needs: build-addon
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with: { path: ./artifacts }
      - run: |
          aws s3 cp ./artifacts/addon-ubuntu-24.04/dist/my_addon.node.gz \
                    s3://.../v1.0.0/my_addon-v1.0.0-linux-x64.node.gz
          # ... etc per platform. S3 key naming is the caller's choice — bytes are
          # attested, not filenames.

  # One uses: attests binaries, builds manifest, publishes via npm trusted publishing.
  # Reusable workflows cannot elevate their own permissions — caller grants them here.
  publish:
    needs: [build-addon, pack-tarball, upload-binaries]
    permissions:
      contents: read
      id-token: write # npm trusted publishing + Sigstore OIDC
      attestations: write # GitHub Attestations UI (optional)
    uses: vadimpiven/node-addon-slsa/.github/workflows/publish.yaml@<sha>
    with:
      artifact-pattern: "addon-*"
      subject-pattern: "my_addon.node.gz"
      tarball-artifact: "tarball"
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
      # No NODE_AUTH_TOKEN — npm ≥ 11.5 exchanges the OIDC token for a short-lived
      # publish token. npm validates the caller's top-level workflow_ref, so the
      # publisher registers *this* workflow (release.yaml) on npmjs as the trusted
      # publisher — not the reusable.
```

The caller MUST pin `publish.yaml@<sha>` by commit SHA. Tag/branch pins fail
`DEFAULT_ATTEST_SIGNER_PATTERN` and the verifier rejects the attestation.

## Consumer

### Install

`npm install my-native-addon` runs `slsa wget` via `postinstall`:

1. Read `${pkgRoot}/${addon.manifest}` (default `slsa-manifest.json`). Trust: npm's
   `dist.integrity` (sha512) covers the tarball before `postinstall` runs; `dist.signatures`
   is TUF-backed via npm keys. Reading the manifest is equivalent to trusting
   `dist.integrity`.
2. Look up `manifest.addons[process.platform]?.[process.arch]`; download from `url`; verify
   sha256.
3. Rekor lookup on sha256; cross-check cert OIDs against the manifest (issuer, `sourceRepo`,
   `sourceCommit`, `sourceRef`, `runInvocationURI`, Build Signer URI).
4. Assert `manifest.packageName === package.json.name`.

Any failure aborts install with `SECURITY`.

### Programmatic

```typescript
import { verifyPackage } from "node-addon-slsa";

const provenance = await verifyPackage({
  packageName: "my-native-addon",
  repo: "owner/repo",
});

// Verify a binary you've already hashed:
await provenance.verifyAddon({ sha256: hex });

// Or point at a file and let the library hash it:
await provenance.verifyAddon({ filePath: "/path/to/addon.node.gz" });

// Inspect verified provenance (all readable after verifyPackage resolves):
provenance.packageName; // "my-native-addon"
provenance.sourceRepo; // "owner/repo"
provenance.sourceCommit; // 40-hex
provenance.sourceRef; // "refs/tags/v1.2.3"
provenance.runInvocationURI; // "https://github.com/..."
```

Plain strings at the public boundary — validated internally. No branded-type wrappers to
import. No `version` input: the manifest is read from the installed tarball, so version is
implicit. `packageName` is resolved via `createRequire(process.cwd() + "/")`. OnP / test
fixture escape hatch: `verifyPackageAt(packageRoot, options)` from `node-addon-slsa/internal`.

## Manifest schema

Embedded in the npm tarball at `${addon.manifest}`. Single authoritative copy per release,
covered by `dist.integrity`.

```jsonc
{
  "$schema": "https://vadimpiven.github.io/node-addon-slsa/schema/slsa-manifest.v1.json",
  "packageName": "@scope/my-native-addon",
  "runInvocationURI": "https://github.com/owner/repo/actions/runs/123/attempts/1",
  "sourceRepo": "owner/repo",
  "sourceCommit": "<40-hex>",
  "sourceRef": "refs/tags/v1.2.3",
  "addons": {
    "linux": {
      "x64": { "url": "https://.../addon-linux-x64.node.gz", "sha256": "..." },
    },
    "darwin": {
      "arm64": {
        "url": "https://.../addon-darwin-arm64.node.gz",
        "sha256": "...",
      },
    },
    "win32": {
      "x64": { "url": "https://.../addon-win32-x64.node.gz", "sha256": "..." },
    },
  },
}
```

- `packageName` closes the monorepo co-tagged-sibling swap: sibling packages from the same
  `repo+tag` share every Fulcio OID (Fulcio has no npm-name claim). Without it, a compromised
  publish job could reference package A's attested binary from package B's manifest and both
  `dist.integrity` and Rekor would verify.
- `addons` outer keys are `process.platform` (`darwin | linux | win32`); inner keys are
  `process.arch` (`x64 | arm64 | arm | ia32`; Electron reports `arm` for `armv7l`). Nesting
  scopes the schema to the Electron matrix and avoids the cartesian product.
- `$schema` is matched by exact string equality — the verifier never fetches it. Version
  bumps are explicit via the registry below.

### Publishing the schema

Zod schemas in `package/src/schemas.ts` are the single source of truth. JSON Schemas are
build output, regenerated into `package/docs/schema/` on every build (no check-in). Zod 4's
`z.toJSONSchema()` handles the conversion — no runtime dep.

```typescript
// package/src/schemas.ts (excerpt)
export const PublishedSchemas = {
  "slsa-manifest.v1.json": SlsaManifestSchemaV1,
  // future: "slsa-manifest.v2.json": SlsaManifestSchemaV2,
} as const;
```

```typescript
// package/scripts/generate-schemas.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { BRAND_PAGES_BASE } from "../src/verify/brand.ts";
import { PublishedSchemas } from "../src/schemas.ts";

const outDir = new URL("../docs/schema/", import.meta.url);
mkdirSync(outDir, { recursive: true });
for (const [name, schema] of Object.entries(PublishedSchemas)) {
  const json = z.toJSONSchema(schema, { target: "draft-7" });
  // Zod's toJSONSchema() does not emit $id or top-level $schema; inject them so the
  // published file self-describes with the URL the verifier pins (exact-string match).
  const withIds = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: `${BRAND_PAGES_BASE}/schema/${name}`,
    ...json,
  };
  writeFileSync(new URL(name, outDir), JSON.stringify(withIds, null, 2) + "\n");
}
```

```json
// package/package.json — wired after docs generation
"build": "vite build && typedoc && node scripts/generate-schemas.ts"
```

Built on latest Node (native TypeScript execution). Served at
`https://vadimpiven.github.io/node-addon-slsa/schema/<file>.json` via the existing Pages
deploy in `.github/workflows/release.yaml`.

Incompatible change → new registry entry (`slsa-manifest.v2.json`) alongside frozen
`SlsaManifestSchemaV1`. The v1 file keeps regenerating identically; old manifests keep
validating. The verifier is taught to accept both `$schema` URLs manually — the generator
doesn't decide when to bump.

## `publish.yaml` reusable workflow

Location: `.github/workflows/publish.yaml`. Invoked as
`jobs.<id>.uses: vadimpiven/node-addon-slsa/.github/workflows/publish.yaml@<sha>`.

Single-job workflow: downloads binary artifacts and the pre-packed tarball, runs
`actions/attest-build-provenance` to attest binaries, then runs the internal
`publish-attested` action to re-fetch declared URLs, verify Rekor, inject the manifest,
and `npm publish`.

A reusable workflow gets its own `job_workflow_ref` in the Fulcio cert, pinned to this
repo's workflow path. That's what makes the Build Signer URI pin work — no workflow outside
this repo can mint certs that match `DEFAULT_ATTEST_SIGNER_PATTERN`.

### Interface

```yaml
on:
  workflow_call:
    inputs:
      artifact-pattern:
        description: Glob for GH artifact names holding per-platform binaries.
        required: true
        type: string
      subject-pattern:
        description: Glob for files within each downloaded artifact to attest.
        required: true
        type: string
      tarball-artifact:
        description: Name of the GH artifact holding the pre-packed .tgz.
        required: true
        type: string
      addons:
        description: >
          Nested JSON: `{ [platform]: { [arch]: url } }` using Node's `process.platform` /
          `process.arch`. Each leaf is a URL the caller has already uploaded to.
        required: true
        type: string
      access:
        description: >
          npm publish --access (public|restricted). Omit to use npm's own default
          (restricted for scoped, public for unscoped).
        required: false
        type: string
      tag:
        description: npm dist-tag. Omitted → npm defaults to `latest`.
        required: false
        type: string
      max-binary-bytes:
        description: >
          Per-binary size cap (bytes). Enforced on Content-Length and mid-stream.
          Default: 268435456 (256 MiB).
        required: false
        type: string
```

### Body

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # Sigstore OIDC + npm trusted publishing
      attestations: write # GitHub Attestations UI (optional)
    steps:
      - uses: actions/download-artifact@<sha>
        with:
          pattern: ${{ inputs.artifact-pattern }}
          path: ./artifacts
      - uses: actions/download-artifact@<sha>
        with:
          name: ${{ inputs.tarball-artifact }}
          path: ./tarball
      - uses: actions/attest-build-provenance@<sha>
        with:
          subject-path: ./artifacts/**/${{ inputs.subject-pattern }}
          # Sigstore public-good is required so the attestation is verifiable from
          # internal/private repos; GitHub's default sigstore instance is scoped per-repo.
      - uses: vadimpiven/node-addon-slsa/publish-attested@<sha>
        with:
          tarball-dir: ./tarball
          addons: ${{ inputs.addons }}
          access: ${{ inputs.access }}
          tag: ${{ inputs.tag }}
          max-binary-bytes: ${{ inputs.max-binary-bytes }}
```

`actions/attest-build-provenance` produces one Rekor entry covering all matched subjects
(each binary's sha256 is a subject). Consumer lookup by sha256 returns the entry;
`verifyRekorAttestations` confirms the queried sha256 is in the subjects list.

No per-OS scoping — the security boundary is the reusable workflow's `job_workflow_ref`,
not job granularity.

Tag-only publishing: the caller's workflow must be triggered by a tag (`on: push: tags:`);
`sourceRef` must start with `refs/tags/` so the default consumer `refPattern` (derived from
installed version) always has a base case. `npm publish` ≥ 11.5 exchanges the OIDC token
for a short-lived registry token when the caller's top-level workflow is configured as a
trusted publisher on npmjs. No `NODE_AUTH_TOKEN` is set or read.

### Internal `publish-attested` action

Implementation detail of the reusable workflow. Lives at `publish-attested/` in this repo
(`action.yaml`, `index.ts`, `dist/index.js` committed, `node24` runtime, `@vercel/ncc`
bundled). Never invoked directly by publishers — `publish.yaml` is the only advertised
entry point.

Input Zod schema — identical key-shape to the manifest; `sha256` is computed, not input:

```typescript
// Re-uses PlatformSchema, ArchSchema from package/src/verify/schemas.ts.
const AddonUrlMapSchema = z.record(
  PlatformSchema,
  z.record(ArchSchema, z.string().url()),
);
export type AddonUrlMap = z.infer<typeof AddonUrlMapSchema>;
```

Pseudocode:

```typescript
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { AddonEntry, AddonInventory } from "node-addon-slsa";
// workspace-internal consumer: imports constructors + helpers from /internal
import {
  sha256Hex,
  githubRepo,
  runInvocationURI,
  verifyAttestation,
  assertWithinDir,
} from "node-addon-slsa/internal";

const MAX_BINARY_BYTES = Number(inputs.maxBinaryBytes ?? 256 * 1024 * 1024);
const repo = githubRepo(process.env.GITHUB_REPOSITORY);
const runURI = runInvocationURI(
  `https://github.com/${process.env.GITHUB_REPOSITORY}` +
    `/actions/runs/${process.env.GITHUB_RUN_ID}` +
    `/attempts/${process.env.GITHUB_RUN_ATTEMPT}`,
);

// 1. Per URL: fetch (size-capped), hash, Rekor-verify.
//    verifyAttestation cross-checks Build Signer URI against DEFAULT_ATTEST_SIGNER_PATTERN,
//    rejecting attestations not minted by our reusable workflow.
//    Key-shape in verifiedAddons is preserved 1:1 from input; only sha256 is added.
const verifiedAddons: AddonInventory = {};
for (const [platform, byArch] of Object.entries(addons)) {
  for (const [arch, url] of Object.entries(byArch ?? {})) {
    const label = `${platform}/${arch}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${label}: ${url} → ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_BINARY_BYTES) {
      throw new Error(`${label}: Content-Length ${declared} exceeds cap`);
    }
    const bytes = await readWithCap(res.body, MAX_BINARY_BYTES);
    const sha256 = sha256Hex(createHash("sha256").update(bytes).digest("hex"));
    await verifyAttestation({ sha256, runInvocationURI: runURI, repo });
    (verifiedAddons[platform] ??= {})[arch] = {
      url,
      sha256,
    } satisfies AddonEntry;
  }
}

// 2. Resolve tarball (there must be exactly one .tgz in tarball-dir) and unpack for
//    package.json access.
const tarball = await singleTgzIn(tarballDir);
const work = await mkdtemp(join(tmpdir(), "publish-attested-"));
execSync(`tar -xzf "${tarball}" -C "${work}"`);
const pkgRoot = `${work}/package`;
const pkg = JSON.parse(await readFile(`${pkgRoot}/package.json`, "utf8"));

// 3. Build manifest.
const manifest: SlsaManifest = {
  $schema: SLSA_MANIFEST_V1_SCHEMA_URL,
  packageName: pkg.name,
  runInvocationURI: runURI,
  sourceRepo: process.env.GITHUB_REPOSITORY,
  sourceCommit: process.env.GITHUB_SHA,
  sourceRef: process.env.GITHUB_REF, // must start with refs/tags/
  addons: verifiedAddons,
};

// 4. Resolve manifest path; reject traversal and overwrite.
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
      `pre-packed .tgz must not ship a manifest. Check "files"/"npmignore".`,
  );
}

// 5. Embed, repack, publish via npm trusted publishing.
await mkdir(dirname(manifestAbs), { recursive: true });
await writeFile(manifestAbs, JSON.stringify(manifest, null, 2));
const out = `${tarball}.with-manifest.tgz`;
execSync(`tar -czf "${out}" -C "${work}" package`);

const args = ["publish", out];
if (access) args.push("--access", access);
if (tag) args.push("--tag", tag);
execSync(`npm ${args.map((a) => `"${a}"`).join(" ")}`, { stdio: "inherit" });
```

Env read: `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `GITHUB_SHA`,
`GITHUB_REF`. Fail fast if any is missing.
(<https://docs.github.com/en/actions/learn-github-actions/variables>)

### Design notes

- **URL is the source of truth.** The manifest records what the installer will see. The
  action hashes served bytes, so typos, stale CDN caches, and wrong-bucket uploads fail at
  publish before any customer sees them.
- **Caller packs, action repacks.** Pre-packed `.tgz` input keeps the action
  package-manager-agnostic. Local tarball bit-stability doesn't matter — `dist.integrity`
  is computed by `npm publish` over whatever bytes we hand it.
- **Typed `access` / `tag`, not free-form `publish-args`.** A typed surface structurally
  blocks `--provenance` smuggling. Registry / auth config is not an input — trusted
  publishing to `registry.npmjs.org` needs none.
- **Caller never directly holds `id-token: write`.** All OIDC-consuming steps run inside
  the reusable workflow. The caller's other jobs (build / pack / upload) are unprivileged.
  npm trusted publishing still works because npm validates the caller's top-level
  `workflow_ref`, which is the publisher's own `release.yaml` — exactly what they'd
  register on npmjs as the trusted publisher.
- **No `attest-signer-pattern` override input.** A fork that moves the reusable workflow
  ships its own rebuilt default — runtime override serves no real publish-side use case
  and would invite accidental widening of the pin. The matching knob lives on the
  _verifier_ (`VerifyOptions.attestSignerPattern`) for the legitimate niche: a cross-fork
  consumer verifying a package programmatically.
- **SHA-pinned caller `uses:` is enforced, not advisory.** The default signer pattern
  requires `@<40-hex>` in the Build Signer URI; tag/branch pins fail the verifier.
- **Hardening.**
  - **Public URLs only.** No auth flow, no presigned URLs (expire before consumers install).
    Private-bucket publishers use a public CDN.
  - **Per-binary size cap** (default 256 MiB, override via `max-binary-bytes`). Enforced on
    `Content-Length` (fail fast) and mid-stream (abort on absent/lying header).
  - **Path traversal rejected** via `assertWithinDir` (`package/src/util/fs.ts`).
  - **No overwrite** of a pre-existing manifest in the tarball.

## Verifier

### `brand.ts` — fork-configurable constants

Every fork-editable value lives here. Forks edit this file (and nothing else) to rebrand.
Downstream constants derive from these, so `pnpm build` regenerates schema files, signer
patterns, and docs URLs consistently.

```typescript
/** GitHub owner/repo hosting this library and the reusable publish workflow. */
export const BRAND_REPO = "vadimpiven/node-addon-slsa";

/** GitHub Pages origin for published schemas. */
export const BRAND_PAGES_BASE = "https://vadimpiven.github.io/node-addon-slsa";

/** Path to the reusable publish workflow within BRAND_REPO. */
export const BRAND_PUBLISH_WORKFLOW_PATH = ".github/workflows/publish.yaml";
```

### `constants.ts`

```typescript
import {
  BRAND_REPO,
  BRAND_PAGES_BASE,
  BRAND_PUBLISH_WORKFLOW_PATH,
} from "./brand.ts";

/** Default manifest path; overridden by package.json's `addon.manifest`. */
export const DEFAULT_MANIFEST_PATH = "slsa-manifest.json";

/** Fulcio OID for Build Signer URI (= job_workflow_ref for GH Actions). */
export const OID_BUILD_SIGNER_URI = "1.3.6.1.4.1.57264.1.9";
/** Fulcio OID for source repository commit digest. */
export const OID_SOURCE_REPO_DIGEST = "1.3.6.1.4.1.57264.1.13";
/** Fulcio OID for source repository ref (e.g. "refs/tags/v1.2.3"). */
export const OID_SOURCE_REPO_REF = "1.3.6.1.4.1.57264.1.14";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * SHA-only pin: tags are mutable and a retagged publish.yaml could re-mint attestations
 * that pass a tag-based pin. GitHub populates `job_workflow_ref` with the literal ref
 * from the caller's `uses:` line, so a SHA-pinned `uses:` produces `@<40-hex>` in the
 * Fulcio cert. Override via VerifyOptions.attestSignerPattern for cross-fork programmatic
 * use (e.g. consumer verifying a package published under a different fork).
 */
export const DEFAULT_ATTEST_SIGNER_PATTERN = new RegExp(
  `^${escapeRegExp(`${BRAND_REPO}/${BRAND_PUBLISH_WORKFLOW_PATH}`)}@` +
    String.raw`[0-9a-f]{40}$`,
);
```

Existing OIDs: `OID_ISSUER_V1` (`.1.1`), `OID_ISSUER_V2` (`.1.8`), `OID_SOURCE_REPO_URI`
(`.1.12`), `OID_RUN_INVOCATION_URI` (`.1.21`). Registry:
<https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md>.

### `schemas.ts` — manifest schema + domain types

Single source of truth; both the verifier and the internal `publish-attested` action
consume these names.

```typescript
import { BRAND_PAGES_BASE } from "./brand.ts";

export const SLSA_MANIFEST_V1_SCHEMA_URL = `${BRAND_PAGES_BASE}/schema/slsa-manifest.v1.json`;

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
  packageName: PackageNameSchema, // existing branded type
  runInvocationURI: RunInvocationURISchema,
  sourceRepo: GitHubRepoSchema,
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  sourceRef: z.string().regex(/^refs\/tags\//),
  addons: AddonInventorySchema,
});
export type SlsaManifest = z.infer<typeof SlsaManifestSchema>;
```

`sourceRef` is tag-only (pairs with the SHA-only signer pin for tamper-resistance). `addons`
keys are closed under the Electron platform/arch set; unknown keys reject.

### `certificates.ts` — `verifyCertificateOIDs`

```typescript
export type CertificateOIDExpectations = {
  sourceCommit: SourceCommitSha; // exact match against OID_SOURCE_REPO_DIGEST
  sourceRef: SourceRef; // exact match against OID_SOURCE_REPO_REF
  runInvocationURI: RunInvocationURI; // exact match against OID_RUN_INVOCATION_URI
  attestSignerPattern: RegExp; // regex match against OID_BUILD_SIGNER_URI
};

export function verifyCertificateOIDs(
  cert: X509Certificate,
  repo: GitHubRepo,
  expect: CertificateOIDExpectations,
): void;
```

All four fields required. `attestSignerPattern` rejects Rekor entries whose Build Signer URI
doesn't match, regardless of other OIDs — this is the pin that binds attestations to the
reusable workflow.

### `verify.ts` — `verifyPackage`

Sole block-facing entry point.

```typescript
export type VerifyPackageOptions = VerifyOptions & {
  /**
   * Installed package to verify. Resolved via
   * `createRequire(process.cwd() + "/").resolve(packageName + "/package.json")`;
   * the parent dir is the package root.
   */
  packageName: string;
  /**
   * Expected source repository (e.g. `"owner/repo"`). Cross-checked against the manifest;
   * case-insensitive. Plain string — no constructor ceremony.
   */
  repo: string;
  /**
   * Expected tag ref pattern. Default: `^refs/tags/v?<escaped-package-version>$` (pins a
   * consumer to the exact tag that produced the installed version). Override for monorepo
   * prefixes (`pkg-v1.2.3`) or scoped tags.
   */
  refPattern?: RegExp;
  /**
   * Regex against the Fulcio cert's Build Signer URI for each Rekor entry.
   * Default: DEFAULT_ATTEST_SIGNER_PATTERN. Override only to verify a package produced by
   * a different fork's publish workflow (cross-fork programmatic use).
   */
  attestSignerPattern?: RegExp;
};

export async function verifyPackage(
  options: VerifyPackageOptions,
): Promise<PackageProvenance>;

/** Shape returned by `verifyPackage`. All fields populated after resolve. */
export interface PackageProvenance {
  readonly packageName: string;
  readonly sourceRepo: string; // "owner/repo"
  readonly sourceCommit: string; // 40-hex
  readonly sourceRef: string; // "refs/tags/v1.2.3"
  readonly runInvocationURI: string;
  /**
   * Verify a single native-addon binary belongs to this provenance.
   * Accepts either a pre-computed sha256 (hex) or a file path the library will hash.
   * Exactly one of `sha256` / `filePath` required.
   */
  verifyAddon(input: { sha256: string } | { filePath: string }): Promise<void>;
}
```

Behaviour:

1. Resolve `packageName` via `createRequire(process.cwd() + "/")`.
2. Read `${root}/package.json`; get `name`, `version`, `addon.manifest`.
3. Load + zod-parse the manifest at `addon.manifest` (default `DEFAULT_MANIFEST_PATH`).
4. Assert `manifest.packageName === package.json.name` (monorepo sibling-swap defence).
5. Assert `manifest.sourceRepo` equals `options.repo` (case-insensitive).
6. Assert `manifest.sourceRef` matches `options.refPattern` (default derived from version).
7. Return a `PackageProvenance` whose `verifyAddon(...)` does: (a) hash the file if
   `filePath` was given; (b) Rekor lookup on the sha256; (c) cross-check each cert's OIDs
   — issuer, `sourceRepo`, `sourceCommit`, `sourceRef`, `runInvocationURI`, Build Signer URI.

Escape hatch for OnP / test fixtures / custom resolvers:
`verifyPackageAt(packageRoot: string, options)` in `node-addon-slsa/internal`. Not exported
from the top level — keeps the block-facing surface to one entry point per Chollet/Keras
"non-proliferation of concepts".

Sigstore cert verification happens inside `verifyRekorAttestations` per entry (Fulcio CAs
and Rekor key via TUF).

### Internal API — `/internal`

Not exported from `node-addon-slsa`. Exposed at `node-addon-slsa/internal` for
workspace-internal consumers (publish-attested, CLI).

```typescript
// node-addon-slsa/internal
export type VerifyAttestationOptions = VerifyOptions & {
  sha256: Sha256Hex;
  runInvocationURI: RunInvocationURI;
  repo: GitHubRepo;
  /** Build Signer URI pin; defaults to DEFAULT_ATTEST_SIGNER_PATTERN. */
  attestSignerPattern?: RegExp;
};

export async function verifyAttestation(
  options: VerifyAttestationOptions,
): Promise<void>;

export function verifyPackageAt(
  packageRoot: string,
  options: Omit<VerifyPackageOptions, "packageName">,
): Promise<PackageProvenance>;

export { assertWithinDir } from "../util/fs.ts";
// Branded-type constructors (kept internal; block-facing API takes plain strings):
export {
  sha256Hex,
  semVerString,
  githubRepo,
  runInvocationURI,
} from "../types.ts";
```

`verifyAttestation` wraps `verifyRekorAttestations` with trust-material loading and retry
(~30s for Rekor ingestion lag) plus the Build Signer URI check — so `publish-attested`
inherits the same pin as the consumer verifier.

Top-level exports: `verifyPackage`, `PackageProvenance`, `VerifyOptions`, manifest types
(`SlsaManifest`, `AddonEntry`, `AddonInventory`, `Platform`, `Arch`), and branded-type
_types_ (`Sha256Hex`, `GitHubRepo`, …) — constructors live in `/internal`.

### CLI

`slsa wget` calls `verifyPackageAt(packageDir, options)` from `node-addon-slsa/internal` —
the CLI already has a resolved dir and shouldn't re-do package-name resolution.

A package with no `addon.manifest` and no `slsa-manifest.json` at the default location fails
loud (wasn't published with this toolkit).

## Forking

Enterprise forks are a supported mode: a rebranded fork publishes its own
`@yourorg/node-addon-slsa` to npmjs.org (public or scoped-private). Consumers depend on the
fork directly and inherit the fork's defaults without runtime configuration. Publishing to
an internal registry (Verdaccio, GitHub Packages, Artifactory) is not supported — the
install-time trust story depends on npm's TUF-backed `dist.signatures`, an npmjs feature.

Checklist (one edit retargets the whole toolchain):

1. **Edit `package/src/verify/brand.ts`.** Update `BRAND_REPO` (e.g.
   `acmecorp/node-addon-slsa`), `BRAND_PAGES_BASE`, and — if you moved the reusable
   workflow — `BRAND_PUBLISH_WORKFLOW_PATH`. `DEFAULT_ATTEST_SIGNER_PATTERN` and
   `SLSA_MANIFEST_V1_SCHEMA_URL` regenerate from these.
2. **Run `pnpm build`.** Schemas regenerate with the fork's URL baked in; signer pattern
   matches the fork's workflow path.
3. **Configure GitHub Pages** to serve `package/docs/` (or host the schemas wherever
   `BRAND_PAGES_BASE` points).
4. **Set up npm trusted publishing** for the fork's package on npmjs.org.
5. **Republish as `@yourorg/node-addon-slsa`** to npmjs. Consumers depend on the fork;
   their `postinstall: slsa wget` runs the fork's CLI with the fork's defaults.

Don't make the CLI multi-tenant (read consumer root config, merge signer patterns). That
opens hoisting edge cases and weakens the trust root (consumer-writable allow-list).
Rebranding is simpler and safer.

Cross-fork programmatic use is supported via `VerifyOptions.attestSignerPattern` — a
consumer of package A (vadimpiven fork) can still verify package B (acmecorp fork) by
passing acmecorp's pattern explicitly.

## Testing

Inline under `if (import.meta.vitest)`.

`brand.ts` ↔ derived constants:

- `SLSA_MANIFEST_V1_SCHEMA_URL` starts with `BRAND_PAGES_BASE`.
- `DEFAULT_ATTEST_SIGNER_PATTERN.source` contains the escaped
  `${BRAND_REPO}/${BRAND_PUBLISH_WORKFLOW_PATH}` prefix and a 40-hex SHA suffix; tag-pinned
  URIs (`@refs/tags/v1.2.3`) are rejected.
- Rebranding: with `brand.ts` module-mocked to `acmecorp/...`, derived constants re-derive
  to the `acmecorp` forms (pins the "forks only edit `brand.ts`" invariant).

`SlsaManifestSchema`:

- Valid manifest parses; branded types returned.
- `$schema` mismatch (wrong URL, missing field) rejected.
- Each missing required field rejected (one test per field).
- Non-hex sha256, non-https url, malformed `runInvocationURI` rejected.
- Unknown `addons` platform (`freebsd`) or arch (`riscv64`) rejected.

`verifyCertificateOIDs`: one accept + one reject per field (`sourceCommit`, `sourceRef`,
`runInvocationURI`, Build Signer URI). Mock `X509Certificate` per `certificates.ts`
precedent. Attestation signed by the reusable workflow passes; attestation whose Build
Signer URI points at an unrelated workflow path rejects.

`verifyPackage`:

- Happy path via mocked `verifyRekorAttestations`, through internal `verifyPackageAt`
  (fixture-friendly path).
- `packageName` resolution through public `verifyPackage`: fixture installed under
  `node_modules/` of a tmpdir cwd; resolves via `createRequire`.
- Invalid `repo` string (not `owner/repo`) → input-validation error (no constructor needed
  caller-side).
- `verifyAddon({ filePath })` hashes the file and succeeds; tampered file throws
  `ProvenanceError`.
- `verifyAddon` with both / neither of `sha256` / `filePath` → input-validation error.
- `manifest.packageName` mismatch with `package.json.name` → `ProvenanceError`.
- `manifest.sourceRepo` mismatch → `ProvenanceError`.
- `manifest.sourceRef` fails `refPattern` → throws.
- Version `1.2.3` accepts `refs/tags/1.2.3` and `refs/tags/v1.2.3`; rejects
  `refs/tags/v1.2.4` and `refs/heads/main` (latter also schema-rejected).
- Versions with regex metacharacters (`1.2.3-rc.1`, `1.2.3+build.1`) correctly escaped.
- Explicit `refPattern` / `attestSignerPattern` override defaults.
- Rekor cert OID disagreement (`sourceCommit`, `runInvocationURI`, Build Signer URI)
  throws.

`publish-attested/index.ts` (real temp dir + fixtures):

- Happy path (mocked `fetch` + `verifyAttestation`).
- Wrong URL bytes → `verifyAttestation` rejects before `npm publish`.
- Rekor ingestion-lag: first call rejects, retry resolves.
- `Content-Length` > cap → reject before body read.
- Stream past cap without declared length → mid-stream abort.
- `max-binary-bytes` input overrides the default.
- Non-2xx HTTP → error with URL + status.
- Manifest construction from `GITHUB_*` env + verified hashes.
- Round-trip with default / nested `addon.manifest` (parent dirs created).
- `addon.manifest = "../escape.json"` → `assertWithinDir` rejects.
- Pre-packed tarball already contains the manifest path → refuses to overwrite.
- Missing env var → actionable error (via `vi.stubEnv`).
- `execSync` stubbed for `npm publish` (no registry call).

No new Rekor network fixtures — `rekor.ts` tests cover that surface.

## Out of scope

- PyPI / maturin parallel (different trust infrastructure).
- Non-GitHub CI providers (manifest schema is GitHub-specific by design).
- Non-npmjs registries (TUF-backed `dist.signatures` is an npmjs feature).
- Bundled attestation format (sigstore bundle inside the tarball). Rejected in favour of
  Rekor-lookup-by-hash for simplicity.
