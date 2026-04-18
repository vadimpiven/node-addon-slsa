# Plan: unified addon provenance

`npm publish --provenance` rejects bundles from internal/private GitHub
repos (server-side policy). This plan delivers one provenance flow for
every repo visibility, with no per-visibility branches in publisher or
verifier. Two mechanisms carry the trust:

- **Per-binary attestations come from a reusable workflow** at
  `vadimpiven/node-addon-slsa/.github/workflows/attest.yaml`. The Fulcio
  cert's Build Signer URI (OID `.1.9`) pins attestations to that path;
  the caller's publish job — which holds `id-token: write` for npm
  trusted publishing — carries the caller's workflow path in its own
  cert and cannot forge a passing attestation.
- **npm trusted publishing (OIDC)** replaces long-lived
  `NODE_AUTH_TOKEN`. Consumer trust in the tarball flows from npm's
  `dist.integrity` (TUF-backed), not the publish job's identity.

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

- `addon.path` — install location in the consumer's `node_modules`
  (consumer-side; not covered by provenance).
- `addon.manifest` — embedded manifest location inside the published
  tarball. Optional; defaults to `./slsa-manifest.json` at package root.
  Read by both the action and the verifier.

Binary URLs are not in `package.json`; they live in
`manifest.addons[platform][arch].url`, filled by `publish-attested`
from its `addons` input.

### Publisher CI workflow

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
      - run: npx slsa pack
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: addon-${{ matrix.os }}
          path: dist/my_addon-v*.node.gz

  # Attestation runs in this repo's reusable workflow. Its Fulcio cert's
  # Build Signer URI pins the identity; the caller's publish job cannot
  # mint a matching one.
  attest:
    needs: build-addon
    uses: vadimpiven/node-addon-slsa/.github/workflows/attest.yaml@<sha>
    with:
      artifact-pattern: "addon-*"
      subject-pattern: "my_addon-v*.node.gz"

  # Publish: id-token: write only to mint the npm trusted-publishing
  # OIDC token.
  publish:
    needs: attest
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # npm trusted publishing
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      - uses: actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f # v6.3.0
        with: { registry-url: https://registry.npmjs.org }
      - run: npm ci
      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with: { path: ./artifacts }

      # Upload before publish — `publish-attested` refuses to publish if
      # any URL serves bytes without a matching Rekor entry from this
      # run signed by the reusable attest workflow.
      - run: |
          aws s3 cp ./artifacts/addon-ubuntu-24.04/my_addon-v1.0.0-linux-x64.node.gz \
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
          # No NODE_AUTH_TOKEN — npm ≥ 11.5 exchanges the job's OIDC
          # token for a short-lived publish token.
```

### Consumer install

`npm install my-native-addon` runs `slsa wget` via `postinstall`:

1. Read the embedded manifest at `package.json.addon.manifest` (default
   `./slsa-manifest.json`). Trust: npm's `dist.integrity` sha512 covers
   the tarball before `postinstall` runs; `dist.signatures` is
   TUF-backed via npm keys. Reading the manifest is therefore equivalent
   to trusting `dist.integrity`.
2. Look up `manifest.addons[process.platform]?.[process.arch]`;
   download from `url`, verify sha256.
3. Rekor lookup on sha256; cross-check cert OIDs against the manifest
   (issuer, `sourceRepo`, `sourceCommit`, `sourceRef`,
   `runInvocationURI`, Build Signer URI).
4. Assert `manifest.packageName === package.json.name`.

Any failure aborts install with `SECURITY`.

### Programmatic verification

```typescript
import { verifyPackage, sha256Hex, githubRepo } from "node-addon-slsa";

const provenance = await verifyPackage({
  packageName: "my-native-addon",
  repo: githubRepo("owner/repo"),
});
await provenance.verifyAddon({ sha256: sha256Hex(hex) });
```

No `version` input: the manifest is read from the installed tarball, so
version is implicit. `packageName` is resolved via
`createRequire(process.cwd() + "/")`. Callers with custom layouts (PnP,
test fixtures) can pass `packageRoot` (absolute path) instead.

## Flow

```text
     build matrix  ──▶ upload binaries as GH artifacts (no id-token)

                      ┌────────────────────────────────────────────┐
     reusable    ──▶  │ vadimpiven/node-addon-slsa/.github/         │
     attest           │   workflows/attest.yaml@<sha>                │──▶ Rekor
     workflow         │   (id-token: write; pins Build Signer URI)   │
                      └────────────────────────────────────────────┘

     caller uploads binaries to their declared URLs (S3 / CDN / Releases)

                      ┌───────────────────┐
     publish job  ──▶ │ publish-attested  │──▶ fetch URLs, verify Rekor +
     (id-token        └───────────────────┘    Build Signer URI, build
      for npm                                  manifest, inject, npm publish
      OIDC)                                    (trusted publishing)

     install:  read manifest → download url → verify sha256 → Rekor lookup
               → cross-check cert OIDs (repo, commit, ref, runInvocationURI,
                 Build Signer URI) → assert manifest.packageName matches
                 installed package.json.name
```

## Trust model

Trusts GitHub Actions (build environment) and Sigstore public-good
(Fulcio CA, Rekor). Compromise of either breaks verification.

| Attack                                                     | Caught at              | By                                                                                                                       |
| ---------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Wrong bytes uploaded to a declared URL                     | Publish time           | `publish-attested` fetches + Rekor-verifies each URL before `npm publish`                                                |
| Swapped `.node` on CDN/S3 after publish                    | Install time           | Rekor miss (no entry for tampered sha256)                                                                                |
| Swapped npm tarball                                        | Install time           | `dist.integrity` sha512 mismatch                                                                                         |
| Binary from unrelated legit run                            | Publish + install time | Rekor cert's `sourceRepo` + `runInvocationURI` must match current run                                                    |
| Fake run URI in manifest                                   | Install time           | No Rekor entry matches URI + hash                                                                                        |
| `workflow_dispatch` on feature branch                      | Schema + install time  | Schema rejects non-`refs/tags/` `sourceRef`; installer `refPattern` derived from version                                 |
| Compromised publish runner forging binary attestations     | Publish + install time | Build Signer URI pin rejects certs whose URI is not the reusable `attest.yaml` workflow path                             |
| Monorepo sibling binary laundered into a different package | Install time           | `manifest.packageName === package.json.name` (Fulcio has no npm-name claim; `sourceRef`+`sourceRepo` don't disambiguate) |
| Caller pins reusable attest workflow at malicious tag      | Not caught             | **Residual.** Mitigation: pin by commit SHA, not tag, in the caller's `uses:` (README guidance)                          |

### Privacy

The reusable attest workflow logs to public Rekor. Its Sigstore cert
reveals `owner/repo`, commit SHA, workflow path, ref. Internal/private-
repo publishers accept this by opting into the flow; the manifest adds
no new leakage — it restates what's already in public Rekor entries.

## Manifest schema

Embedded in the npm tarball at `package.json.addon.manifest` (default
`./slsa-manifest.json`). Single authoritative copy per release, covered
by `dist.integrity` regardless of location.

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

- `packageName` closes the monorepo co-tagged-siblings swap: sibling
  packages from the same repo+tag share every Fulcio OID (Fulcio has no
  npm-name claim). Without this field a compromised publish job could
  reference package A's attested binary from package B's manifest and
  both `dist.integrity` and Rekor would verify.
- Outer `addons` keys are `process.platform` (`darwin | linux | win32`);
  inner keys are `process.arch` (`x64 | arm64 | arm | ia32`; Electron
  reports `arm` for `armv7l`). Nesting scopes the schema to the
  Electron matrix and avoids the cartesian product.
- `$schema` is matched by exact string equality — the verifier never
  fetches it. Version bumps are explicit via the registry key below.

### Publishing the schema

Zod schemas in `package/src/schemas.ts` are the single source of truth.
JSON Schemas are pure build output, regenerated into
`package/docs/schema/` on every build (no check-in).
Zod 4's `z.toJSONSchema()` handles the conversion — no runtime dep.

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
import { PublishedSchemas } from "../src/schemas.ts";

const outDir = new URL("../docs/schema/", import.meta.url);
mkdirSync(outDir, { recursive: true });
for (const [name, schema] of Object.entries(PublishedSchemas)) {
  const json = z.toJSONSchema(schema, { target: "draft-7" });
  writeFileSync(new URL(name, outDir), JSON.stringify(json, null, 2) + "\n");
}
```

```json
// package/package.json — wired after docs generation
"build": "vite build && typedoc && node scripts/generate-schemas.ts"
```

Build runs on latest Node (native TypeScript execution). Result:
`https://vadimpiven.github.io/node-addon-slsa/schema/<file>.json`
(already served by the existing Pages deploy in
`.github/workflows/release.yaml`).

An incompatible change adds a new registry entry
(`slsa-manifest.v2.json`) alongside the frozen `SlsaManifestSchemaV1`,
so the v1 file keeps regenerating identically and old manifests keep
validating. The verifier is taught to accept both `$schema` URLs
manually — the generator doesn't decide when to bump.

## `attest.yaml` reusable workflow

Location: `.github/workflows/attest.yaml`. Invoked as
`jobs.<id>.uses: vadimpiven/node-addon-slsa/.github/workflows/attest.yaml@<sha>`.

A reusable workflow gets its own `job_workflow_ref` in the Fulcio cert,
pinned to this repo's workflow path. A composite action would inherit
the caller's `job_workflow_ref` instead, letting the publish job (which
needs `id-token: write` for trusted publishing) mint certs with
identical OIDs. Reusable-workflow identity is what makes the URI pin
work.

```yaml
# Interface
on:
  workflow_call:
    inputs:
      artifact-pattern:
        description: Glob for GH artifact names uploaded by the caller's build matrix.
        required: true
        type: string
      subject-pattern:
        description: Glob for files within each downloaded artifact to attest.
        required: true
        type: string
```

```yaml
# Body
jobs:
  attest:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # required for Sigstore OIDC
      attestations: write # GitHub Attestations UI (optional)
    steps:
      - uses: actions/download-artifact@<sha>
        with:
          pattern: ${{ inputs.artifact-pattern }}
          path: ./artifacts
      - uses: actions/attest-build-provenance@<sha>
        with:
          subject-path: ./artifacts/**/${{ inputs.subject-pattern }}
          # Sigstore public-good is required so the attestation is
          # verifiable from internal/private repos; GitHub's default
          # sigstore instance is scoped per-repo.
```

One call → one Rekor entry covering all matched subjects (each
binary's sha256 is a subject). Consumer lookup by sha256 returns the
entry; `verifyRekorAttestations` confirms the queried sha256 is in the
subjects list.

- **No custom wrapper.** Uses `actions/attest-build-provenance`
  directly; the workflow file is plain YAML + pinned action SHAs.
- **Single attest job.** The security boundary is the reusable
  workflow's `job_workflow_ref`, not per-OS scoping.

## `publish-attested` action

Location: `publish-attested/` at repo root. Packaging: `action.yaml`,
`index.ts`, `dist/index.js`, `node24` runtime, `@vercel/ncc` bundling,
dev deps via pnpm `catalog:`, runtime dep `node-addon-slsa`
(`workspace:*`).

Fetches each declared URL, verifies the bytes have a Rekor entry from
the current run signed by the reusable attest workflow, builds the
manifest, injects it into a pre-packed `.tgz`, and runs `npm publish
<tgz>` via npm trusted publishing. Caller uploads binaries to the
declared URLs before calling this action.

### Interface

```yaml
inputs:
  addons:
    description: >
      Nested JSON: `{ [platform]: { [arch]: url } }` using Node's
      `process.platform` / `process.arch`. Each leaf is a URL the
      caller has already uploaded to.
    required: true
  tarball:
    description: Path to the input .tgz (already packed).
    required: true
  access:
    description: >
      npm publish --access value (public|restricted). Omit to use npm's
      own default (restricted for scoped, public for unscoped) —
      safer for private-org publishers.
    required: false
  tag:
    description: npm dist-tag. Omitted → npm defaults to `latest`.
    required: false
  attest-signer-pattern:
    description: >
      Regex (as string) matched against the Fulcio cert's Build Signer
      URI for each Rekor entry. Override only if using a fork of this
      repo's attest reusable workflow. Default:
      `DEFAULT_ATTEST_SIGNER_PATTERN`.
    required: false
```

No outputs; the side effect is `npm publish`.

Tag-only publishing: `sourceRef` must start with `refs/tags/` so the
default consumer `refPattern` (derived from installed version) always
has a base case.

The calling job must hold `id-token: write`. `npm publish` ≥ 11.5
exchanges the OIDC token for a short-lived registry token when a
trusted publisher is configured on npm. No `NODE_AUTH_TOKEN` is set or
read.

Input Zod schema — identical key-shape to the manifest; `sha256` is
computed by the action, not input:

```typescript
// Re-uses PlatformSchema, ArchSchema from package/src/verify/schemas.ts.
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
  sha256Hex,
  githubRepo,
  runInvocationURI,
  type AddonEntry,
  type AddonInventory,
} from "node-addon-slsa";
import { verifyAttestation, assertWithinDir } from "node-addon-slsa/internal";

const MAX_BINARY_BYTES = 256 * 1024 * 1024; // 256 MB

const repo = githubRepo(process.env.GITHUB_REPOSITORY);
const runURI = runInvocationURI(
  `https://github.com/${process.env.GITHUB_REPOSITORY}` +
    `/actions/runs/${process.env.GITHUB_RUN_ID}` +
    `/attempts/${process.env.GITHUB_RUN_ATTEMPT}`,
);

// 1. Per URL: fetch (size-capped), hash, Rekor-verify. `verifyAttestation`
//    also cross-checks Build Signer URI against DEFAULT_ATTEST_SIGNER_PATTERN,
//    rejecting certs signed by the caller's publish job (the id-token-
//    forgery path introduced by trusted publishing).
//    Key-shape in verifiedAddons is preserved 1:1 from input; only
//    sha256 is added, so there is no mid-flight remapping.
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

// 2. Unpack tarball so we can read package.json for `packageName`.
const work = await mkdtemp(join(tmpdir(), "publish-attested-"));
execSync(`tar -xzf "${tarball}" -C "${work}"`);
const pkgRoot = `${work}/package`;
const pkg = JSON.parse(await readFile(`${pkgRoot}/package.json`, "utf8"));

// 3. Build manifest — fields match the schema 1:1.
const manifest: SlsaManifest = {
  $schema: SLSA_MANIFEST_V1_SCHEMA_URL,
  packageName: pkg.name,
  runInvocationURI: runURI,
  sourceRepo: process.env.GITHUB_REPOSITORY,
  sourceCommit: process.env.GITHUB_SHA,
  sourceRef: process.env.GITHUB_REF, // must start with refs/tags/
  addons: verifiedAddons,
};
const manifestJson = JSON.stringify(manifest, null, 2);

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
      `the pre-packed .tgz must not ship a manifest. Check "files"/"npmignore".`,
  );
}

// 5. Embed, repack, publish via npm trusted publishing.
await mkdir(dirname(manifestAbs), { recursive: true });
await writeFile(manifestAbs, manifestJson);
const out = `${tarball}.with-manifest.tgz`;
execSync(`tar -czf "${out}" -C "${work}" package`);

const args = ["publish", out];
if (access) args.push("--access", access);
if (tag) args.push("--tag", tag);
execSync(`npm ${args.map((a) => `"${a}"`).join(" ")}`, { stdio: "inherit" });
```

Env vars read: `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`,
`GITHUB_SHA`, `GITHUB_REF`. Fail fast if any is missing. Reference:
<https://docs.github.com/en/actions/learn-github-actions/variables>.

### Design notes

- **URL is the source of truth.** The manifest records what the
  installer will see. The action hashes the served bytes, so typos in
  S3 keys, stale CDN caches, and wrong-bucket uploads fail at publish
  before any customer sees them.
- **Shared verification code.** `verifyAttestation` imports from
  `node-addon-slsa` (workspace link; ncc inlines). One copy of
  Rekor/Fulcio logic, same trust anchors, same ~30s retry for Rekor
  ingestion lag.
- **Caller packs, action repacks.** Pre-packed `.tgz` input keeps the
  action package-manager-agnostic. Local tarball bit-stability doesn't
  matter: `dist.integrity` is computed by `npm publish` over whatever
  bytes we hand it. The `package/` entry prefix is the npm convention.
- **Minimal input surface.** `addons` + `tarball` required; `access` /
  `tag` optional. Repo / run / commit / ref are ambient env — making
  them inputs would invite stale-value overrides that break Rekor
  cross-check. `addons` key-shape matches `AddonInventory`; only
  `sha256` is added.
- **Typed `access` / `tag`, not free-form `publish-args`.** Both are
  orthogonal to provenance; a typed surface structurally blocks
  `--provenance` smuggling. `--registry` / auth belong in `.npmrc` via
  `setup-node`.
- **Privilege separation via Build Signer URI.** The publish job holds
  `id-token: write` for trusted publishing, so it _can_ mint Sigstore
  certs — but those certs carry the caller's workflow path. Rekor
  entries signed by the publish job fail the verifier's URI pin;
  attestations must come from the reusable attest workflow.
- **Residual risk.** A caller pinning the reusable workflow at a
  compromised ref would accept malicious attestations. Mitigation:
  pin by commit SHA (`@<40-hex>`), not tag (documented in README).
- **Hardening.**
  - **Public URLs only.** No auth flow, no presigned URLs (expire
    before consumers install). Private-bucket publishers use a public
    CDN.
  - **256 MB per-binary cap.** Enforced on `Content-Length` (fail
    fast) and mid-stream (abort on absent/lying header).
  - **Path traversal rejected** via `assertWithinDir`
    (`package/src/util/fs.ts`).
  - **No overwrite** of pre-existing manifest in the tarball.

## Verifier

### `brand.ts` — fork-configurable constants

Every fork-editable value lives here. Forks edit this file (and nothing
else) to rebrand. Downstream constants derive from these, so
`pnpm build` regenerates schema files, signer patterns, and docs URLs
consistently.

```typescript
/** GitHub owner/repo hosting this library and the reusable attest workflow. */
export const BRAND_REPO = "vadimpiven/node-addon-slsa";

/** GitHub Pages origin for published schemas. */
export const BRAND_PAGES_BASE = "https://vadimpiven.github.io/node-addon-slsa";

/** Path to the reusable attest workflow within `BRAND_REPO`. */
export const BRAND_ATTEST_WORKFLOW_PATH = ".github/workflows/attest.yaml";
```

### `constants.ts`

```typescript
import {
  BRAND_REPO,
  BRAND_PAGES_BASE,
  BRAND_ATTEST_WORKFLOW_PATH,
} from "./brand.ts";

/** Default manifest path; overridden by package.json's `addon.manifest`. */
export const DEFAULT_MANIFEST_PATH = "slsa-manifest.json";

/** Fulcio OID for Build Signer URI (= job_workflow_ref for GH Actions). */
export const OID_BUILD_SIGNER_URI = "1.3.6.1.4.1.57264.1.9";
/** Fulcio OID for source repository commit digest. */
export const OID_SOURCE_REPO_DIGEST = "1.3.6.1.4.1.57264.1.13";
/** Fulcio OID for source repository ref (e.g. "refs/tags/v1.2.3"). */
export const OID_SOURCE_REPO_REF = "1.3.6.1.4.1.57264.1.14";

/** Escape a string for safe interpolation into a RegExp source. */
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Default Build Signer URI pattern. Derived from `brand.ts`. Pins
 * per-binary attestations to this repo's reusable attest workflow at
 * a signed tag. Override via `VerifyOptions.attestSignerPattern` for
 * cross-fork programmatic use (e.g., consumer verifying a package
 * published under a different fork).
 */
export const DEFAULT_ATTEST_SIGNER_PATTERN = new RegExp(
  `^${escapeRegExp(`${BRAND_REPO}/${BRAND_ATTEST_WORKFLOW_PATH}`)}@` +
    String.raw`refs/tags/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$`,
);
```

Existing: `OID_ISSUER_V1` (`.1.1`), `OID_ISSUER_V2` (`.1.8`),
`OID_SOURCE_REPO_URI` (`.1.12`), `OID_RUN_INVOCATION_URI` (`.1.21`).
Registry:
<https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md>.

### `schemas.ts` — manifest schema + domain types

Single source of truth; both verifier and `publish-attested` consume
these names.

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

- `$schema` equals `SLSA_MANIFEST_V1_SCHEMA_URL` exactly (no network).
- `packageName` is a valid npm package name (branded `PackageNameSchema`).
- `runInvocationURI`, `sourceRepo` reuse the existing branded validators.
- `sourceCommit` is 40-hex; `sourceRef` must start with `refs/tags/`
  (tag-only publishing).
- `addons` keys are closed under the Electron platform/arch set;
  unknown keys reject.

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

All four fields required. `attestSignerPattern` rejects Rekor entries
whose Build Signer URI doesn't match, regardless of other OIDs — this
is what prevents the caller's publish job from forging attestations.
Helpers reused: `getExtensionValue(cert, oid)`,
`extractCertFromBundle(bundle)`.

### `verify.ts` — `verifyPackage`

Sole block-facing entry point. Returns `PackageProvenance` with
`verifyAddon({ sha256 })`.

```typescript
export type VerifyPackageOptions = VerifyOptions & {
  /**
   * Installed package to verify. Resolved via
   * `createRequire(process.cwd() + "/").resolve(packageName +
   * "/package.json")`; the parent dir is the package root. Mutually
   * exclusive with `packageRoot`.
   */
  packageName?: string;
  /**
   * Absolute path to the package root (dir containing `package.json`).
   * Escape hatch for PnP, test fixtures, custom resolvers. Mutually
   * exclusive with `packageName`. Exactly one of `packageName` /
   * `packageRoot` must be provided.
   */
  packageRoot?: string;
  /** Expected source repository; cross-checked against the manifest. */
  repo: GitHubRepo;
  /**
   * Expected tag ref pattern. Default:
   * `^refs/tags/v?<escaped-package-version>$` (pins a consumer to the
   * exact tag that produced the installed version). Override for
   * monorepo prefixes (`pkg-v1.2.3`) or scoped tags.
   */
  refPattern?: RegExp;
  /**
   * Regex against the Fulcio cert's Build Signer URI for each Rekor
   * entry. Default: `DEFAULT_ATTEST_SIGNER_PATTERN`. Override only if
   * using a fork of this repo's attest reusable workflow.
   */
  attestSignerPattern?: RegExp;
};

export async function verifyPackage(
  options: VerifyPackageOptions,
): Promise<PackageProvenance>;
```

Behaviour:

1. Resolve the package root: either `packageRoot` (as given) or resolve
   `packageName` via `createRequire`.
2. Read `${root}/package.json`; get `name`, `version`, `addon.manifest`.
3. Load + zod-parse the manifest at `addon.manifest` (default
   `DEFAULT_MANIFEST_PATH`) relative to the root.
4. Assert `manifest.packageName === package.json.name` (monorepo
   sibling-swap defence).
5. Assert `manifest.sourceRepo` equals `options.repo`
   (case-insensitive).
6. Assert `manifest.sourceRef` matches `options.refPattern` (default
   derived from installed version).
7. Return a `PackageProvenance` whose `verifyAddon({ sha256 })`
   does (a) Rekor lookup on `sha256`; (b) cross-check each cert's
   OIDs — issuer, `sourceRepo`, `sourceCommit`, `sourceRef`,
   `runInvocationURI`, Build Signer URI.

Notes:

- Common case: `verifyPackage({ packageName, repo })`; everything else
  derives from `package.json`.
- Exactly one of `packageName` / `packageRoot` must be provided; zod
  union validates. Error message lists both forms.
- Sigstore cert verification happens inside `verifyRekorAttestations`
  per entry (Fulcio CAs + Rekor key via TUF).

### CLI — `commands.ts`

```typescript
const provenance = await verifyPackage({ packageRoot, repo, ... });
await provenance.verifyAddon({ sha256 });
```

`slsa wget` already has `packageDir` — it passes it through as
`packageRoot` (bypasses resolution). A package with no `addon.manifest`
and no `slsa-manifest.json` at the default location fails loud (wasn't
published with this toolkit).

### Internal API — `verifyAttestation`

Not exported from `node-addon-slsa`. Exposed at `node-addon-slsa/internal`
for use by `publish-attested` (workspace-internal consumer).

```typescript
// node-addon-slsa/internal
export type VerifyAttestationOptions = VerifyOptions & {
  sha256: Sha256Hex;
  runInvocationURI: RunInvocationURI;
  repo: GitHubRepo;
  /** Build Signer URI pin; defaults to `DEFAULT_ATTEST_SIGNER_PATTERN`. */
  attestSignerPattern?: RegExp;
};

export async function verifyAttestation(
  options: VerifyAttestationOptions,
): Promise<void>;
```

Wraps `verifyRekorAttestations` with trust-material loading and retry.
The Build Signer URI check runs here, so `publish-attested` inherits
the same pin as the consumer verifier.

`assertWithinDir` is also exported from `node-addon-slsa/internal` —
not from the top level. Block-facing consumers don't need a
path-traversal guard as public API.

### Existing building blocks reused

- `package/src/verify/rekor.ts` — `verifyRekorAttestations(...)`.
- `package/src/util/fs.ts` — `assertWithinDir({ baseDir, target, label })`.
- `package/src/types.ts` — branded types + validators (`sha256Hex`,
  `semVerString`, `githubRepo`, `runInvocationURI`).
- `package/src/cli.ts`, `package/src/commands.ts` — CLI entry.
- Tests: inline under `if (import.meta.vitest)` per
  `package/src/verify/certificates.ts`.

## Forking this repo

Enterprise forks are a supported mode: a rebranded fork publishes its
own `@yourorg/node-addon-slsa` to an internal registry; internal
consumers depend on the fork directly and inherit the fork's defaults
without runtime configuration.

Fork checklist (one edit retargets the whole toolchain):

1. **Edit `package/src/verify/brand.ts`**. Update `BRAND_REPO` (e.g.
   `acmecorp/node-addon-slsa`), `BRAND_PAGES_BASE` (your Pages URL or
   equivalent), and — if you moved the reusable workflow —
   `BRAND_ATTEST_WORKFLOW_PATH`. `DEFAULT_ATTEST_SIGNER_PATTERN` and
   `SLSA_MANIFEST_V1_SCHEMA_URL` regenerate from these.
2. **Run `pnpm build`.** Schemas regenerate to `package/docs/schema/`
   with the fork's URL baked in; signer pattern matches the fork's
   workflow path.
3. **Configure GitHub Pages** on the fork to serve `package/docs/`
   (or host the schemas wherever `BRAND_PAGES_BASE` points).
4. **Set up npm trusted publishing** for the fork's package on your
   registry (public or internal).
5. **Republish as `@yourorg/node-addon-slsa`.** Internal consumers
   depend on the fork; their `postinstall: slsa wget` runs the fork's
   CLI with the fork's defaults.

What NOT to do: don't try to make the CLI multi-tenant (read consumer
root config, merge signer patterns). That path opens hoisting edge
cases and weakens the trust root (consumer-writable allow-list).
Rebranding is the simpler and safer model.

Cross-fork programmatic use remains supported via
`VerifyOptions.attestSignerPattern` — a consumer of package A
(vadimpiven fork) can still verify package B (acmecorp fork) by
passing acmecorp's pattern explicitly.

## Implementation

### New files

- `.github/workflows/attest.yaml` — reusable workflow (plain YAML).
  Steps: `actions/download-artifact` → `actions/attest-build-provenance`
  (public-good Sigstore).
- `package/src/verify/brand.ts` — centralized fork-editable constants
  (`BRAND_REPO`, `BRAND_PAGES_BASE`, `BRAND_ATTEST_WORKFLOW_PATH`).
- `publish-attested/action.yaml`
- `publish-attested/index.ts`
- `publish-attested/package.json` — runtime dep `node-addon-slsa`
  (`workspace:*`); devDeps `@actions/core`, `@types/node`,
  `@vercel/ncc`, `typescript`, `zod` via `catalog:`.
- `publish-attested/tsconfig.json`
- `publish-attested/dist/index.js` (generated by `ncc`, committed)

### Modified files

- `pnpm-workspace.yaml` — register `publish-attested`; drop
  `attest-public`.
- `package/src/verify/constants.ts` — `DEFAULT_MANIFEST_PATH`,
  `OID_BUILD_SIGNER_URI`, `OID_SOURCE_REPO_DIGEST`,
  `OID_SOURCE_REPO_REF`, `DEFAULT_ATTEST_SIGNER_PATTERN` (derived
  from `brand.ts`).
- `package/src/verify/schemas.ts` — add `SlsaManifestSchema` (with
  `packageName`); tighten `sourceRef` to `^refs/tags/`;
  `SLSA_MANIFEST_V1_SCHEMA_URL` derived from `BRAND_PAGES_BASE`.
- `package/src/verify/certificates.ts` — `verifyCertificateOIDs` takes
  required `sourceCommit` / `sourceRef` / `runInvocationURI` /
  `attestSignerPattern`.
- `package/src/verify/verify.ts` — `verifyPackage` primary entry
  (takes `packageName` or `packageRoot`); `verifyAttestation` with
  `attestSignerPattern` (internal).
- `package/src/verify/index.ts` — export block-facing symbols
  (`verifyPackage`, `PackageProvenance`, `VerifyOptions`, manifest
  types).
- `package/src/internal.ts` — NEW: export `verifyAttestation`,
  `assertWithinDir`, branded-type constructors, raw schemas.
- `package/package.json` — add `"./internal"` subpath to `exports`.
- `package/src/index.ts` — re-export block-facing symbols only.
- `package/src/commands.ts` — `slsa wget` calls `verifyPackage`
  with its existing `packageDir` as `packageRoot`.
- `README.md`, `package/README.md` — unified flow, reusable attest
  workflow, commit-SHA pinning guidance, npm trusted publishing setup.

### Deletions

- `attest-public/` — entire directory (replaced by reusable workflow +
  `actions/attest-build-provenance`).
- `package/src/verify/npm.ts` (no `fetchNpmAttestations` consumer).
- `NpmAttestationsSchema` from `schemas.ts`.
- `verifyPackageProvenance` from `verify.ts` (`verifyAddonProvenance`
  → `verifyAttestation`, same wrapper).
- `OID_SOURCE_REPO_VISIBILITY` (no code path asserts it).

### Testing

Inline under `if (import.meta.vitest)`.

`brand.ts` ↔ derived constants:

- `SLSA_MANIFEST_V1_SCHEMA_URL` starts with `BRAND_PAGES_BASE`.
- `DEFAULT_ATTEST_SIGNER_PATTERN.source` contains the escaped
  `${BRAND_REPO}/${BRAND_ATTEST_WORKFLOW_PATH}` prefix.
- Rebranding test: with `brand.ts` values patched (via module mock) to
  `acmecorp/...`, derived constants re-derive to the `acmecorp` forms.
  This pins the "forks only edit `brand.ts`" invariant.

`SlsaManifestSchema`:

- Valid manifest parses; branded types returned.
- `$schema` mismatch (wrong URL, missing field) rejected.
- Each missing required field rejected (one test per field).
- Non-hex sha256, non-https url, malformed `runInvocationURI` rejected.
- Unknown `addons` platform key (e.g. `freebsd`) or arch key (e.g.
  `riscv64`) rejected.

`verifyCertificateOIDs`: one accept + one reject per field
(`sourceCommit`, `sourceRef`, `runInvocationURI`, Build Signer URI).
Mock `X509Certificate` per `certificates.ts` precedent. Specifically:
attestation signed by the reusable workflow passes; attestation whose
Build Signer URI is the caller's publish-job workflow path rejects
(covers the trusted-publishing forgery scenario).

`verifyPackage`:

- Happy path via mocked `verifyRekorAttestations`, using
  `packageRoot` (fixture-friendly path).
- `packageName` resolution: fixture installed under `node_modules/`
  of a tmpdir cwd; `packageName` resolves via `createRequire`.
- Neither `packageName` nor `packageRoot` → input-validation error.
- Both provided → input-validation error.
- `manifest.packageName` mismatch with `package.json.name` →
  `ProvenanceError` (monorepo sibling-swap).
- `manifest.sourceRepo` mismatch → `ProvenanceError`.
- `manifest.sourceRef` fails `refPattern` → throws.
- Version `1.2.3` accepts `refs/tags/1.2.3` and `refs/tags/v1.2.3`;
  rejects `refs/tags/v1.2.4` and `refs/heads/main` (latter also
  schema-rejected).
- Versions with regex metacharacters (`1.2.3-rc.1`, `1.2.3+build.1`)
  correctly escaped.
- Explicit `refPattern` / `attestSignerPattern` override defaults.
- Fixtures: tmpdir `packageRoot` with `package.json` + co-located
  `slsa-manifest.json`.
- Rekor cert's `sourceCommit` / `runInvocationURI` / Build Signer URI
  disagreement → throws.

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
- Pre-packed tarball already contains the manifest path → refuses to
  overwrite.
- Missing env var → actionable error (via `vi.stubEnv`).
- `execSync` stubbed for `npm publish` (no registry call).

No new Rekor network fixtures — `rekor.ts` tests cover that surface.

### Steps

1. Create `verify/brand.ts` with `BRAND_REPO`, `BRAND_PAGES_BASE`,
   `BRAND_ATTEST_WORKFLOW_PATH`.
2. `DEFAULT_MANIFEST_PATH`, 3 OIDs (including `OID_BUILD_SIGNER_URI`),
   and `DEFAULT_ATTEST_SIGNER_PATTERN` (derived from `brand.ts`) in
   `verify/constants.ts`.
3. `SlsaManifestSchema` (with `packageName`, `refs/tags/`-only
   `sourceRef`) in `verify/schemas.ts`; `SLSA_MANIFEST_V1_SCHEMA_URL`
   derived from `BRAND_PAGES_BASE`.
4. `verifyCertificateOIDs` signature change in `verify/certificates.ts`
   (adds required `attestSignerPattern`).
5. Rename `verifyAddonProvenance` → `verifyAttestation` in
   `verify/verify.ts` (adds optional `attestSignerPattern`). Add
   `verifyPackage` taking `packageName` or `packageRoot`. Create
   `package/src/internal.ts` exporting `verifyAttestation` +
   `assertWithinDir` + branded-type constructors + raw schemas.
   Update `package/package.json` `exports` map with `./internal`
   subpath. Top-level `index.ts` exports only block-facing surface.
6. `commands.ts` passes its existing `packageDir` as `packageRoot` to
   `verifyPackage`.
7. Delete `verify/npm.ts`, `NpmAttestationsSchema`,
   `verifyPackageProvenance`, `OID_SOURCE_REPO_VISIBILITY`.
8. Delete `attest-public/` directory entirely.
9. Create `.github/workflows/attest.yaml` reusable workflow.
10. Add `publish-attested/` package to workspace.
11. Inline tests per Testing above.
12. Update `README.md` (root + package) for the unified flow, reusable
    attest workflow, commit-SHA pinning guidance, npm trusted
    publishing setup, and the fork playbook (editing `brand.ts`,
    configuring Pages, republishing as `@yourorg/node-addon-slsa`).
13. Release `v1.0.0` (breaking; no existing users).

## Out of scope

- PyPI / maturin parallel (different trust infrastructure).
- Non-GitHub CI providers. Manifest schema is GitHub-specific by
  design.
- Bundled attestation format (sigstore bundle inside the tarball).
  Rejected in favour of Rekor-lookup-by-hash for simplicity.
