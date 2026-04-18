# Unified addon provenance

`npm publish --provenance` rejects bundles from internal/private GitHub repos (server-side
policy). This design runs one provenance flow for every repo visibility: a reusable
workflow attests the binaries, re-fetches them to verify Rekor, embeds a manifest, and
publishes the tarball via npm trusted publishing.

Two mechanisms carry trust:

- **Per-binary attestations** via this repo's `attest-public` action, which wraps
  `@actions/attest.attestProvenance` with `sigstore: "public-good"` explicitly. Public-good
  is forced regardless of repo visibility; `actions/attest-build-provenance` has no such
  input and silently uses GitHub's per-repo scoped Sigstore for private callers, which
  breaks external Rekor lookup. The Fulcio cert's Build Signer URI (OID `.1.9`) pins
  attestations to the reusable workflow's path — no other workflow mints matching certs.
- **npm trusted publishing (OIDC)**. npm validates the caller's top-level `workflow_ref`
  (not the reusable's `job_workflow_ref`), so each publisher registers their own release
  workflow on npmjs as the trusted publisher. Consumer trust in the tarball flows from
  npm's `dist.integrity` (TUF-backed `dist.signatures`).

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
                      │   ├─ attest-public ──▶ Rekor (public-good)     │
                      │   ├─ fetch URLs, verify Rekor + signer pin     │
                      │   ├─ build manifest, inject into .tgz          │
                      │   └─ npm publish  (trusted publishing)         │
                      └────────────────────────────────────────────────┘

     install: read manifest → download url → verify sha256 → Rekor lookup
              → cross-check cert OIDs → assert manifest.packageName matches
                installed package.json.name
```

## Trust model

Trusts: GitHub Actions (build env), Sigstore public-good (Fulcio CA + Rekor), npmjs (TUF
root + registry). Compromise of any of these breaks verification.

Each row: **attack** _(caught at)_ — defence.

- **Wrong bytes uploaded to a declared URL** _(publish)_ — `publish-attested` fetches and
  Rekor-verifies each URL before `npm publish`.
- **Swapped `.node` on CDN/S3 after publish** _(install)_ — Rekor miss: no entry for the
  tampered sha256.
- **Swapped npm tarball** _(install)_ — `dist.integrity` sha512 mismatch.
- **Binary from unrelated legit run** _(publish + install)_ — Rekor cert's `sourceRepo`
  and `runInvocationURI` must match the current run.
- **Fake run URI in manifest** _(install)_ — no Rekor entry matches URI + hash.
- **`workflow_dispatch` on feature branch** _(schema + install)_ — schema rejects
  non-`refs/tags/` `sourceRef`; installer `refPattern` derived from installed version.
- **Attestation minted by an unrelated workflow** _(publish + install)_ — Build Signer URI
  pin rejects certs whose URI is not the reusable `publish.yaml` path.
- **Monorepo sibling laundered into a different package** _(install)_ —
  `manifest.packageName === package.json.name` catches it. Fulcio has no npm-name claim;
  `sourceRef` + `sourceRepo` don't disambiguate siblings.
- **Reusable workflow pinned at a mutable tag** _(publish + install)_ —
  `DEFAULT_ATTEST_SIGNER_PATTERN` is SHA-only (`@<40-hex>`); tag-pinned `uses:` mint certs
  that fail the pattern.

**Privacy.** The reusable workflow logs to public Rekor. The Sigstore cert reveals
`owner/repo`, commit SHA, workflow path, and ref. Internal/private-repo publishers accept
this by opting in; the manifest restates what is already in Rekor.

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

- `addon.path` — the `.node` binary. Input to `slsa pack`; also the install location under
  `node_modules/<pkg>/` at consume time.
- `addon.manifest` — embedded manifest path inside the tarball. Optional; default
  `./slsa-manifest.json` at package root. Read by `publish-attested` and the verifier.

`slsa pack [output]` gzips `addon.path`. Default output: `{addon.path}.gz`. The publisher
uploads the gzipped file anywhere; filename is not covered by provenance (bytes are
hashed, URLs live in the manifest).

Binary URLs are authored in the reusable workflow's `addons:` input and embedded in the
manifest by `publish-attested`. The installer reads URLs from the manifest, not from
`package.json`.

### CI workflow

Three helpers hide artifact plumbing:

- `vadimpiven/node-addon-slsa/pack-addon@<sha>` — runs `slsa pack`, then
  `actions/upload-artifact` with canonical name
  `slsa-addon-${{ runner.os }}-${{ runner.arch }}`.
- `vadimpiven/node-addon-slsa/pack-tarball@<sha>` — runs the publisher's configured pack
  command (`npm pack` by default; override via input) in the configured workdir, then
  uploads with canonical name `slsa-tarball`.
- `vadimpiven/node-addon-slsa/.github/workflows/publish.yaml@<sha>` — reusable publish
  workflow. Reads the canonical artifact names by default.

```yaml
jobs:
  # No id-token. pack-addon wraps `slsa pack` + upload-artifact.
  build-addon:
    strategy:
      matrix: { os: [ubuntu-24.04, macos-15, windows-2025] }
    runs-on: ${{ matrix.os }}
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      # ... build the native addon ...
      - uses: vadimpiven/node-addon-slsa/pack-addon@<sha>
        # uploads `${addon.path}.gz` as `slsa-addon-${runner.os}-${runner.arch}`.

  # pack-tarball wraps `<pm> pack` + upload-artifact.
  pack-tarball:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      - run: npm ci
      - uses: vadimpiven/node-addon-slsa/pack-tarball@<sha>
        with:
          working-directory: packages/node # optional; defaults to repo root
          # pack-command: pnpm pack        # optional; default npm pack

  # Arbitrary caller code. The reusable workflow re-fetches and verifies bytes.
  upload-binaries:
    needs: build-addon
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          pattern: slsa-addon-*
          path: ./artifacts
      - run: |
          aws s3 cp ./artifacts/slsa-addon-Linux-X64/my_addon.node.gz \
                    s3://.../v1.0.0/my_addon-v1.0.0-linux-x64.node.gz
          # ... per platform. S3 keys are caller-chosen; bytes are attested, not names.

  # Reusable workflows cannot elevate permissions — the caller grants them here.
  publish:
    needs: [build-addon, pack-tarball, upload-binaries]
    permissions:
      contents: read
      id-token: write # npm trusted publishing + Sigstore OIDC
      attestations: write # GitHub Attestations UI (optional)
    uses: vadimpiven/node-addon-slsa/.github/workflows/publish.yaml@<sha>
    with:
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
      # No NODE_AUTH_TOKEN. npm ≥ 11.5 exchanges the OIDC token for a short-lived
      # publish token. npm validates the caller's top-level workflow_ref, so the publisher
      # registers *this* workflow (release.yaml) on npmjs as the trusted publisher.
```

Only `addons` is required. The pattern inputs default to the helper-action conventions.

**Every `uses:` in the chain (`pack-addon`, `pack-tarball`, `publish.yaml`) MUST be
SHA-pinned.** Tag/branch pins on the reusable workflow mint certs that fail
`DEFAULT_ATTEST_SIGNER_PATTERN` — the verifier rejects them.

Tag-only publishing: trigger the caller's workflow on `on: push: tags:` so `GITHUB_REF`
starts with `refs/tags/`. The default consumer `refPattern` (derived from installed
version) requires this.

## Consumer

### Install (postinstall)

`npm install my-native-addon` runs `slsa wget` via `postinstall`:

1. Read `${pkgRoot}/${addon.manifest}` (default `slsa-manifest.json`). npm's
   `dist.integrity` (sha512) covers the tarball before `postinstall` runs; `dist.signatures`
   is TUF-backed via npm keys. Reading the manifest equals trusting `dist.integrity`.
2. Look up `manifest.addons[process.platform]?.[process.arch]`; download `url`; verify
   sha256.
3. Rekor lookup on sha256; cross-check cert OIDs against the manifest (issuer, `sourceRepo`,
   `sourceCommit`, `sourceRef`, `runInvocationURI`, Build Signer URI).
4. Assert `manifest.packageName === package.json.name`.

Any failure aborts install with a `SECURITY` error.

### Install (lifecycle-scripts disabled)

pnpm ≥ 10 (default), `npm install --ignore-scripts`, and corporate policies skip
postinstalls. The published package calls `requireAddon` at the first `require`:

```typescript
import { requireAddon } from "node-addon-slsa";

export const addon = await requireAddon();
// Discovers its package.json by walking up from the caller frame; if `addon.path` is
// missing on disk, runs the same download + verify flow as `slsa wget`; then requires
// the binary.
```

Addon authors export through `requireAddon` instead of a bare `require(addon.path)` so the
package works whether or not postinstall ran. See `package/src/loader.ts`.

### Programmatic

```typescript
import { verifyPackage } from "node-addon-slsa";

const provenance = await verifyPackage({
  packageName: "my-native-addon",
  repo: "owner/repo",
});

// Verify a binary you've hashed already:
await provenance.verifyAddon({ sha256: hex });
// Or let the library hash it:
await provenance.verifyAddon({ filePath: "/path/to/addon.node.gz" });

// Inspect verified provenance (all fields populated):
provenance.packageName; // "my-native-addon"
provenance.sourceRepo; // "owner/repo"
provenance.sourceCommit; // 40-hex
provenance.sourceRef; // "refs/tags/v1.2.3"
provenance.runInvocationURI; // "https://github.com/..."
```

Plain strings at the public boundary — validated internally. No `version` input: the
manifest is read from the installed tarball, so version is implicit. `packageName`
resolves via `createRequire(process.cwd() + "/")`. Escape hatch for OnP / test fixtures:
`verifyPackageAt(packageRoot, options)` from `node-addon-slsa/internal`.

## Manifest schema

Embedded in the tarball at `${addon.manifest}`. Single authoritative copy per release,
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

- `packageName` closes the monorepo co-tagged-sibling swap. Sibling packages from the same
  `repo+tag` share every Fulcio OID (Fulcio has no npm-name claim); without this field a
  compromised publish job could reference package A's attested binary from package B's
  manifest and both `dist.integrity` and Rekor would verify.
- `addons` outer keys are `process.platform` (`darwin | linux | win32`); inner keys are
  `process.arch` (`x64 | arm64 | arm | ia32`; Electron reports `arm` for `armv7l`). Nesting
  scopes the schema to the Electron matrix.
- `$schema` is matched by exact string equality — the verifier never fetches it.

### Publishing the schema

Zod schemas in `package/src/verify/schemas.ts` are the source of truth. JSON Schemas are
build output, regenerated under `package/docs/schema/` on every build (no check-in). Zod 4's
`z.toJSONSchema()` handles the conversion — no runtime dep.

```typescript
// package/src/verify/schemas.ts (excerpt)
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
import { PublishedSchemas } from "../src/verify/schemas.ts";

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

Served at `https://vadimpiven.github.io/node-addon-slsa/schema/<file>.json` via the
existing Pages deploy in `.github/workflows/release.yaml`.

Incompatible change → new registry entry (`slsa-manifest.v2.json`) alongside frozen
`SlsaManifestSchemaV1`. The v1 file keeps regenerating identically; old manifests keep
validating. The verifier accepts both `$schema` URLs manually — the generator doesn't
decide when to bump.

## `publish.yaml` reusable workflow

Location: `.github/workflows/publish.yaml`. Invoked as
`jobs.<id>.uses: vadimpiven/node-addon-slsa/.github/workflows/publish.yaml@<sha>`.

Single job: downloads binary artifacts + pre-packed tarball, runs `attest-public` to mint
the Rekor entry, then runs the internal `publish-attested` action to re-fetch declared
URLs, verify Rekor, inject the manifest, and `npm publish`.

The reusable workflow's `job_workflow_ref` is what the Fulcio cert's Build Signer URI
reports. `DEFAULT_ATTEST_SIGNER_PATTERN` pins that URI to this workflow path and SHA — no
workflow outside this repo mints matching certs.

### Interface

```yaml
on:
  workflow_call:
    inputs:
      addons:
        description: >
          Nested JSON: `{ [platform]: { [arch]: url } }` using Node's `process.platform` /
          `process.arch`. Each leaf is a URL the caller has already uploaded to.
        required: true
        type: string
      binary-artifact-pattern:
        description: Glob for GH artifact names holding per-platform binaries.
        required: false
        default: "slsa-addon-*"
        type: string
      binary-file-pattern:
        description: Glob for files *within* each binary artifact to attest.
        required: false
        default: "*.node.gz"
        type: string
      tarball-artifact:
        description: Name of the GH artifact holding the pre-packed .tgz.
        required: false
        default: "slsa-tarball"
        type: string
      access:
        description: >
          npm publish --access (public|restricted). Omit → npm's own default
          (restricted for scoped, public for unscoped).
        required: false
        type: string
      tag:
        description: npm dist-tag. Omit → `latest`.
        required: false
        type: string
      max-binary-bytes:
        description: >
          Per-binary size cap (bytes). Enforced on Content-Length and mid-stream.
        required: false
        default: 268435456 # 256 MiB
        type: number
      max-binary-seconds:
        description: >
          Per-binary fetch timeout (seconds). Applied as undici headersTimeout +
          bodyTimeout so a stuck CDN cannot hang the publish.
        required: false
        default: 300
        type: number
```

**Deliberate non-configurables** (documented here so readers don't search for knobs):

- **Sigstore instance.** Forced public-good via `attest-public`. Private-repo attestations
  must be externally verifiable; GitHub's scoped instance would break Rekor lookup.
- **Registry URL.** Forced `registry.npmjs.org`. Trusted publishing is an npmjs feature.
- **`npm publish` flags.** `access` / `tag` are typed inputs, not a free-form
  `publish-args`. This structurally blocks callers from re-enabling `--provenance` (which
  would fail on private repos and defeat this design).

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
          pattern: ${{ inputs.binary-artifact-pattern }}
          path: ./artifacts
      - uses: actions/download-artifact@<sha>
        with:
          name: ${{ inputs.tarball-artifact }}
          path: ./tarball
      - uses: vadimpiven/node-addon-slsa/attest-public@<sha>
        with:
          subject-path: ./artifacts/**/${{ inputs.binary-file-pattern }}
          github-token: ${{ github.token }}
      - uses: vadimpiven/node-addon-slsa/publish-attested@<sha>
        with:
          tarball-dir: ./tarball
          addons: ${{ inputs.addons }}
          access: ${{ inputs.access }}
          tag: ${{ inputs.tag }}
          max-binary-bytes: ${{ inputs.max-binary-bytes }}
          max-binary-seconds: ${{ inputs.max-binary-seconds }}
```

`attest-public` emits one Rekor entry covering all matched subjects (each binary's sha256
is a subject). It fails fast when zero files match `subject-path`; `publish-attested`
independently asserts `addons` has ≥ 1 leaf before any fetch.

No per-OS scoping — the security boundary is the reusable workflow's `job_workflow_ref`,
not job granularity.

### Internal `publish-attested` action

Lives at `publish-attested/` in this repo (`action.yaml`, `index.ts`, `dist/index.js`
committed, `node24` runtime, `@vercel/ncc` bundled). Never invoked directly by publishers
— `publish.yaml` is the only advertised entry point.

Input Zod schema (key-shape identical to the manifest; `sha256` is computed):

```typescript
// Re-uses PlatformSchema, ArchSchema from package/src/verify/schemas.ts.
const AddonUrlMapSchema = z.record(
  PlatformSchema,
  z.record(ArchSchema, z.string().url()),
);
export type AddonUrlMap = z.infer<typeof AddonUrlMapSchema>;
```

Pseudocode. All I/O async; no `execSync`, no shell string interpolation; `execFile` with
argv arrays; `undici.request` streams into the hasher with a size cap; tempdir cleanup via
`await using`.

```typescript
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { request } from "undici";

import {
  SLSA_MANIFEST_V1_SCHEMA_URL,
  assertWithinDir,
  githubRepo,
  runInvocationURI,
  sha256Hex,
  tempDir,
  verifyAttestation,
  type AddonEntry,
  type AddonInventory,
  type SlsaManifest,
} from "node-addon-slsa/internal";

const execFileAsync = promisify(execFile);

// Fail fast on missing env; one lookup site for every GITHUB_*.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`required env var ${name} is not set`);
  return value;
}
const GITHUB_REPOSITORY = requireEnv("GITHUB_REPOSITORY");
const GITHUB_RUN_ID = requireEnv("GITHUB_RUN_ID");
const GITHUB_RUN_ATTEMPT = requireEnv("GITHUB_RUN_ATTEMPT");
const GITHUB_SHA = requireEnv("GITHUB_SHA");
const GITHUB_REF = requireEnv("GITHUB_REF"); // schema-validated ^refs/tags/

const MAX_BINARY_BYTES = inputs.maxBinaryBytes ?? 256 * 1024 * 1024;
const MAX_BINARY_MS = (inputs.maxBinarySeconds ?? 300) * 1000;
const repo = githubRepo(GITHUB_REPOSITORY);
const runURI = runInvocationURI(
  `https://github.com/${GITHUB_REPOSITORY}` +
    `/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}`,
);

// Flatten to triples: one ≥1-addon assertion, no inherited loop state per fetch.
const entries = Object.entries(addons).flatMap(([platform, byArch]) =>
  Object.entries(byArch ?? {}).map(([arch, url]) => ({ platform, arch, url })),
);
if (entries.length === 0) {
  throw new Error(
    "addons input has no URLs; expected at least one platform/arch leaf",
  );
}

// Per URL: stream-fetch with size cap, hash, Rekor-verify. Fetches run in parallel;
// any rejection short-circuits the publish. verifyAttestation pins Build Signer URI
// to DEFAULT_ATTEST_SIGNER_PATTERN.
const verified = await Promise.all(
  entries.map(async ({ platform, arch, url }) => {
    const label = `${platform}/${arch}`;
    const { statusCode, headers, body } = await request(url, {
      headersTimeout: MAX_BINARY_MS,
      bodyTimeout: MAX_BINARY_MS,
    });
    try {
      if (statusCode >= 400)
        throw new Error(`${label}: ${url} → ${statusCode}`);
      const declared = Number(headers["content-length"] ?? 0);
      if (declared > MAX_BINARY_BYTES) {
        throw new Error(`${label}: Content-Length ${declared} exceeds cap`);
      }
      const hash = createHash("sha256");
      let seen = 0;
      await pipeline(body, async function* (source) {
        for await (const chunk of source) {
          seen += chunk.length;
          if (seen > MAX_BINARY_BYTES) {
            throw new Error(
              `${label}: body exceeds cap ${MAX_BINARY_BYTES} bytes`,
            );
          }
          hash.update(chunk);
          yield chunk;
        }
      });
      const sha256 = sha256Hex(hash.digest("hex"));
      await verifyAttestation({ sha256, runInvocationURI: runURI, repo });
      return { platform, arch, entry: { url, sha256 } satisfies AddonEntry };
    } finally {
      // undici requires body consumption; pipeline handles the happy path, but early
      // throws (4xx, cap exceeded before pipeline starts) still need a drain.
      body.dump().catch(() => {});
    }
  }),
);
// Key-shape preserved 1:1 from input; only sha256 is added.
const verifiedAddons: AddonInventory = {};
for (const { platform, arch, entry } of verified) {
  (verifiedAddons[platform] ??= {})[arch] = entry;
}

// Resolve tarball (exactly one .tgz in tarball-dir) and unpack.
// execFile with argv array → no shell, no injection. `await using` cleans up on throw.
const tarball = await singleTgzIn(tarballDir);
await using work = await tempDir();
await execFileAsync("tar", ["-xzf", tarball, "-C", work.path]);
const pkgRoot = resolve(work.path, "package");
const pkg = JSON.parse(
  await readFile(resolve(pkgRoot, "package.json"), "utf8"),
);

const manifest: SlsaManifest = {
  $schema: SLSA_MANIFEST_V1_SCHEMA_URL,
  packageName: pkg.name,
  runInvocationURI: runURI,
  sourceRepo: GITHUB_REPOSITORY,
  sourceCommit: GITHUB_SHA,
  sourceRef: GITHUB_REF,
  addons: verifiedAddons,
};

// Resolve manifest path; reject traversal and refuse overwrite.
const manifestRel = pkg.addon?.manifest ?? DEFAULT_MANIFEST_PATH;
const manifestAbs = resolve(pkgRoot, manifestRel);
assertWithinDir({
  baseDir: pkgRoot,
  target: manifestAbs,
  label: "addon.manifest",
});
// stat + ENOENT beats racy pathExists and stays async.
const existing = await stat(manifestAbs).catch((err: NodeJS.ErrnoException) => {
  if (err.code === "ENOENT") return null;
  throw err;
});
if (existing) {
  throw new Error(
    `refusing to overwrite existing ${manifestRel} inside the tarball; ` +
      `pre-packed .tgz must not ship a manifest. Check "files"/"npmignore".`,
  );
}

// Embed, repack, publish via npm trusted publishing.
await mkdir(dirname(manifestAbs), { recursive: true });
await writeFile(manifestAbs, JSON.stringify(manifest, null, 2));
const out = `${tarball}.with-manifest.tgz`;
await execFileAsync("tar", ["-czf", out, "-C", work.path, "package"]);

const npmArgs = ["publish", out];
if (access) npmArgs.push("--access", access);
if (tag) npmArgs.push("--tag", tag);
// stdio:inherit so OIDC-exchange diagnostics reach the Actions log. spawn avoids the shell.
await new Promise<void>((ok, reject) => {
  const child = spawn("npm", npmArgs, { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) ok();
    else reject(new Error(`npm publish failed: code=${code} signal=${signal}`));
  });
});
```

Env read: `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `GITHUB_SHA`,
`GITHUB_REF`. Fail fast on any missing. Reference:
<https://docs.github.com/en/actions/learn-github-actions/variables>.

### Design notes

- **URL is the source of truth.** The manifest records what the installer will see. The
  action hashes served bytes, so typos, stale CDN caches, and wrong-bucket uploads fail at
  publish before any customer sees them.
- **Caller packs, action repacks.** Pre-packed `.tgz` input keeps the action
  package-manager-agnostic. Local tarball bit-stability doesn't matter — `dist.integrity`
  is computed by `npm publish` over whatever bytes we hand it.
- **Caller never holds `id-token: write` directly.** All OIDC-consuming steps run inside
  the reusable workflow. Build / pack / upload jobs are unprivileged. npm trusted
  publishing still works: npm validates the caller's top-level `workflow_ref`, which is
  the publisher's own `release.yaml` — exactly what they registered on npmjs.
- **No `attest-signer-pattern` override input.** A fork that moves the reusable workflow
  ships its own rebuilt default. Runtime override serves no publish-side use case and
  would invite accidental widening of the pin. The matching knob is the _verifier's_
  (`VerifyOptions.attestSignerPattern`) for cross-fork programmatic verification.
- **SHA-pin enforced, not advisory.** The default signer pattern requires `@<40-hex>` in
  the Build Signer URI.
- **Hardening.**
  - **Public URLs only.** No auth flow, no presigned URLs (expire before consumers
    install). Private-bucket publishers use a public CDN.
  - **Per-binary size cap** (default 256 MiB, override via `max-binary-bytes`). Enforced
    on `Content-Length` (fail fast) and mid-stream via a counting pass-through in the
    `pipeline` (abort on absent/lying header). Body is streamed into the hasher — never
    fully buffered.
  - **≥1 addon asserted** before any fetch — flatten `addons` and throw if empty.
  - **Path traversal rejected** via `assertWithinDir` (`package/src/util/fs.ts`).
  - **No manifest overwrite** — `stat` + `ENOENT` check.
  - **No shells, no `execSync`.** `tar` via `execFile` (promisified) with argv arrays;
    `npm publish` via `spawn`. All FS I/O uses `fs/promises` or `stream/promises`.
    `await using work = await tempDir()` removes the unpack dir on throw.
  - **Parallel fetches** via `Promise.all`. `verifyAttestation` retries internally for
    Rekor ingestion lag.

## Verifier

### `brand.ts` — fork-editable constants

Everything else derives from these. `pnpm build` regenerates schemas, signer patterns, and
docs URLs consistently.

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

/** Fulcio OIDs used here. Registry:
 *  https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md */
export const OID_BUILD_SIGNER_URI = "1.3.6.1.4.1.57264.1.9";
export const OID_SOURCE_REPO_DIGEST = "1.3.6.1.4.1.57264.1.13";
export const OID_SOURCE_REPO_REF = "1.3.6.1.4.1.57264.1.14";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * SHA-only pin. Tags are mutable; a retagged publish.yaml could mint attestations
 * passing a tag-based pin. GitHub populates `job_workflow_ref` with the literal ref
 * from the caller's `uses:` line, so a SHA-pinned `uses:` produces `@<40-hex>` in the
 * Fulcio cert. Override via VerifyOptions.attestSignerPattern for cross-fork use.
 */
export const DEFAULT_ATTEST_SIGNER_PATTERN = new RegExp(
  `^${escapeRegExp(`${BRAND_REPO}/${BRAND_PUBLISH_WORKFLOW_PATH}`)}@` +
    String.raw`[0-9a-f]{40}$`,
);
```

Existing OIDs used elsewhere: `OID_ISSUER_V1` (`.1.1`), `OID_ISSUER_V2` (`.1.8`),
`OID_SOURCE_REPO_URI` (`.1.12`), `OID_RUN_INVOCATION_URI` (`.1.21`).

### `schemas.ts` — manifest schema + domain types

Source of truth for both the verifier and `publish-attested`.

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

`sourceRef` is tag-only (pairs with the SHA-only signer pin for tamper-resistance).
`addons` keys are closed under the Electron platform/arch set; unknown keys reject.

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

All four fields required. `attestSignerPattern` rejects Rekor entries whose Build Signer
URI doesn't match, regardless of other OIDs — this is the pin binding attestations to the
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
   * Expected source repository (e.g. `"owner/repo"`). Cross-checked against the
   * manifest; case-insensitive.
   *
   * Required, not defaulted from `package.json.repository.url`: `repo` is the
   * consumer's out-of-band trust anchor. A compromised tarball could carry a matching
   * fake `repository.url`; the manifest's `sourceRepo` would agree with it and
   * verification would pass. The consumer-supplied value forces the claim to come
   * from outside the tarball.
   */
  repo: string;
  /**
   * Expected tag ref. Default: `^refs/tags/v?<escaped-package-version>$` (pins the
   * consumer to the exact tag that produced the installed version).
   *
   * Pass a string for exact-match (e.g. `"refs/tags/v1.2.3"`), or a `RegExp` for
   * monorepo prefixes (`pkg-v1.2.3`) or scoped tags. Strings are compared with `===`,
   * not compiled as regex, so metachars stay literal.
   */
  refPattern?: RegExp | string;
  /**
   * Fulcio cert's Build Signer URI for each Rekor entry. Default:
   * DEFAULT_ATTEST_SIGNER_PATTERN. Override only to verify a package produced by a
   * different fork's publish workflow. String → exact match against the full URI;
   * RegExp → pattern match.
   */
  attestSignerPattern?: RegExp | string;
};

export async function verifyPackage(
  options: VerifyPackageOptions,
): Promise<PackageProvenance>;

/** Shape returned by `verifyPackage`. All fields populated after resolve. */
export interface PackageProvenance {
  readonly packageName: string;
  readonly sourceRepo: string;
  readonly sourceCommit: string;
  readonly sourceRef: string;
  readonly runInvocationURI: string;
  /**
   * Verify a single native-addon binary belongs to this provenance. Exactly one of
   * `sha256` / `filePath` required.
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
6. Assert `manifest.sourceRef` matches `options.refPattern`: `RegExp` → `.test()`,
   `string` → `===`. Default: `RegExp` derived from installed version.
7. Return `PackageProvenance`. `verifyAddon(...)`:
   (a) hashes the file if `filePath` given;
   (b) Rekor lookup on the sha256;
   (c) cross-checks each cert's OIDs — issuer, `sourceRepo`, `sourceCommit`, `sourceRef`,
   `runInvocationURI`, Build Signer URI.

Sigstore cert verification runs inside `verifyRekorAttestations` per entry (Fulcio CAs +
Rekor key via TUF).

Escape hatch for OnP / test fixtures: `verifyPackageAt(packageRoot, options)` from
`node-addon-slsa/internal` (not exported at the top level — keeps the block-facing
surface to one entry point).

### Top-level exports

```typescript
// node-addon-slsa
export { verifyPackage } from "./verify/index.ts";
export type {
  VerifyPackageOptions,
  PackageProvenance,
} from "./verify/index.ts";

export { requireAddon } from "./loader.ts";
export type { RequireAddonOptions } from "./loader.ts";

export { ProvenanceError, isProvenanceError } from "./util/provenance-error.ts";

export type { VerifyOptions } from "./types.ts";
export type { Dispatcher } from "undici"; // re-exported for VerifyOptions.dispatcher
```

Nothing else. Branded-type constructors (`sha256Hex`, `semVerString`, `githubRepo`,
`runInvocationURI`), branded-type aliases (`Sha256Hex`, `SemVerString`, `GitHubRepo`,
`RunInvocationURI`), trust plumbing (`TrustMaterial`, `BundleVerifier`, `FetchOptions`,
`loadTrustMaterial`), and manifest-shape types (`SlsaManifest`, `AddonEntry`,
`AddonInventory`, `Platform`, `Arch`) all live in `/internal`. The block-facing API takes
plain strings and validates at the boundary; a consumer of `verifyPackage` never
constructs a branded type or a manifest object.

### `VerifyOptions` — consumer-side knobs

Single advanced-knobs bag accepted by both `verifyPackage` and `requireAddon`.

```typescript
export type VerifyOptions = {
  /** Trust root override. Default: loaded from sigstore TUF. */
  trustMaterial?: TrustMaterial;
  /** undici dispatcher — proxy / mTLS / custom connector. */
  dispatcher?: Dispatcher;
  /** AbortSignal for the entire verify + download pipeline. */
  signal?: AbortSignal;
  /**
   * Per-binary download size cap, bytes. Default: 268435456 (256 MiB). Mirrors
   * publish-side `max-binary-bytes` — a consumer can tighten it to refuse
   * unexpectedly large binaries even if the publisher allowed them.
   */
  maxBinaryBytes?: number;
  /**
   * Per-binary fetch timeout, seconds. Default: 300. Applied as `undici.request`'s
   * `headersTimeout` + `bodyTimeout` during `requireAddon` / `slsa wget` downloads.
   */
  maxBinarySeconds?: number;
};
```

`commands.wget` threads `maxBinaryBytes` / `maxBinarySeconds` into its fetch. `slsa wget`
reads them from the `VerifyOptions` bag; the CLI itself has no flags (see below).

### Internal API — `/internal`

Exposed at `node-addon-slsa/internal` for workspace code (`publish-attested`, CLI) and
fork tooling.

```typescript
// node-addon-slsa/internal
export type VerifyAttestationOptions = VerifyOptions & {
  sha256: Sha256Hex;
  runInvocationURI: RunInvocationURI;
  repo: GitHubRepo;
  /** Build Signer URI pin (string for exact-match or RegExp); defaults to
   *  DEFAULT_ATTEST_SIGNER_PATTERN. */
  attestSignerPattern?: RegExp | string;
};

export async function verifyAttestation(
  options: VerifyAttestationOptions,
): Promise<void>;

export function verifyPackageAt(
  packageRoot: string,
  options: Omit<VerifyPackageOptions, "packageName">,
): Promise<PackageProvenance>;

export { assertWithinDir, tempDir } from "../util/fs.ts";

// Branded-type constructors (workspace-only; public API takes plain strings).
export {
  sha256Hex,
  semVerString,
  githubRepo,
  runInvocationURI,
} from "../types.ts";

// Branded-type aliases threaded by workspace code.
export type {
  Sha256Hex,
  SemVerString,
  GitHubRepo,
  RunInvocationURI,
  TrustMaterial,
  BundleVerifier,
  FetchOptions,
} from "../types.ts";

// Manifest-shape types (publish-attested constructs manifests; consumers do not).
export type {
  SlsaManifest,
  AddonEntry,
  AddonInventory,
  Platform,
  Arch,
} from "../verify/schemas.ts";

export { SLSA_MANIFEST_V1_SCHEMA_URL } from "../verify/schemas.ts";

// Trust-material factory (consumers pass the result via VerifyOptions.trustMaterial).
export { loadTrustMaterial } from "../verify/index.ts";
```

`verifyAttestation` wraps `verifyRekorAttestations` with trust-material loading, retry for
Rekor ingestion lag (~30s), and the Build Signer URI check — so `publish-attested`
inherits the same pin as the consumer verifier.

### CLI

`slsa wget` calls `verifyPackageAt(packageDir, options)` from `node-addon-slsa/internal`;
the CLI has a resolved dir and should not re-resolve the package name.

Deliberately flag-less (no `--repo`, no `--signer-pattern`). Postinstall trust anchors
come from the installed `package.json` + compile-time fork defaults. Callers needing
runtime configurability use `verifyPackage` / `requireAddon` programmatically. See
"Forking" for the cross-org trust story.

A package with no `addon.manifest` and no `slsa-manifest.json` at the default location
fails loud (wasn't published with this toolkit).

## Forking

Enterprise forks are supported: a rebranded fork publishes its own
`@yourorg/node-addon-slsa` to npmjs.org (public or scoped-private). Consumers depend on
the fork directly and inherit its defaults without runtime configuration. Publishing to
an internal registry (Verdaccio, GitHub Packages, Artifactory) is not supported — the
install-time trust story depends on npm's TUF-backed `dist.signatures`, an npmjs feature.

Checklist (one edit retargets the toolchain):

1. **Edit `package/src/verify/brand.ts`.** Update `BRAND_REPO`, `BRAND_PAGES_BASE`, and —
   if you moved the reusable workflow — `BRAND_PUBLISH_WORKFLOW_PATH`.
   `DEFAULT_ATTEST_SIGNER_PATTERN` and `SLSA_MANIFEST_V1_SCHEMA_URL` regenerate from these.
2. **Run `pnpm build`.** Schemas regenerate; signer pattern matches the fork's workflow
   path.
3. **Configure GitHub Pages** to serve `package/docs/` (or host the schemas wherever
   `BRAND_PAGES_BASE` points).
4. **Set up npm trusted publishing** for the fork's package on npmjs.org.
5. **Republish as `@yourorg/node-addon-slsa`.** Consumers depend on the fork; their
   `postinstall: slsa wget` runs the fork's CLI with the fork's defaults.

Don't make the CLI multi-tenant (read consumer root config, merge signer patterns). That
opens hoisting edge cases and weakens the trust root (consumer-writable allow-list).
Rebranding is simpler and safer.

Cross-fork programmatic use: a consumer of package A (vadimpiven fork) verifies package B
(acmecorp fork) by passing acmecorp's pattern via `VerifyOptions.attestSignerPattern`.

## Testing

Inline under `if (import.meta.vitest)`.

**`brand.ts` ↔ derived constants.**

- `SLSA_MANIFEST_V1_SCHEMA_URL` starts with `BRAND_PAGES_BASE`.
- `DEFAULT_ATTEST_SIGNER_PATTERN.source` contains the escaped
  `${BRAND_REPO}/${BRAND_PUBLISH_WORKFLOW_PATH}` prefix and a 40-hex SHA suffix; tag-pinned
  URIs (`@refs/tags/v1.2.3`) are rejected.
- Rebranding: with `brand.ts` module-mocked to `acmecorp/...`, derived constants re-derive
  to acmecorp forms (pins the "forks only edit `brand.ts`" invariant).

**`SlsaManifestSchema`.**

- Valid manifest parses; branded types returned.
- `$schema` mismatch (wrong URL, missing field) rejected.
- Each missing required field rejected (one test per field).
- Non-hex sha256, non-https url, malformed `runInvocationURI` rejected.
- Unknown `addons` platform (`freebsd`) or arch (`riscv64`) rejected.

**`verifyCertificateOIDs`.** One accept + one reject per field (`sourceCommit`,
`sourceRef`, `runInvocationURI`, Build Signer URI). Mock `X509Certificate` per
`certificates.ts` precedent. Reusable-workflow-signed attestation passes; attestation
with Build Signer URI pointing at an unrelated workflow rejects.

**`verifyPackage`.**

- Happy path via mocked `verifyRekorAttestations`, through internal `verifyPackageAt`
  (fixture-friendly).
- `packageName` resolution through public `verifyPackage`: fixture installed under
  `node_modules/` of a tmpdir cwd; resolves via `createRequire`.
- Invalid `repo` string (not `owner/repo`) → input-validation error.
- `verifyAddon({ filePath })` hashes the file and succeeds; tampered file throws
  `ProvenanceError`.
- `verifyAddon` with both / neither of `sha256` / `filePath` → input-validation error.
- `manifest.packageName` mismatch → `ProvenanceError`.
- `manifest.sourceRepo` mismatch → `ProvenanceError`.
- `manifest.sourceRef` fails `refPattern` → throws.
- Version `1.2.3` accepts `refs/tags/1.2.3` and `refs/tags/v1.2.3`; rejects
  `refs/tags/v1.2.4` and `refs/heads/main` (latter also schema-rejected).
- Versions with regex metacharacters (`1.2.3-rc.1`, `1.2.3+build.1`) escaped correctly.
- Explicit `refPattern` / `attestSignerPattern` override defaults in both `RegExp` and
  `string` forms; string `"refs/tags/v1.2.3"` matches only that exact ref, not a
  substring.
- Rekor cert OID disagreement (`sourceCommit`, `runInvocationURI`, Build Signer URI)
  throws.

**`publish-attested/index.ts`** (real temp dir + fixtures).

- Happy path (mocked `fetch` + `verifyAttestation`).
- Wrong URL bytes → `verifyAttestation` rejects before `npm publish`.
- Rekor ingestion-lag: first call rejects, retry resolves.
- `Content-Length` > cap → reject before body read.
- Stream past cap without declared length → mid-stream abort.
- `max-binary-bytes` input overrides default.
- `max-binary-seconds` passes to `undici.request` as `headersTimeout` + `bodyTimeout`.
- Non-2xx HTTP → error with URL + status.
- Manifest construction from `GITHUB_*` env + verified hashes.
- Round-trip with default / nested `addon.manifest` (parent dirs created).
- `addon.manifest = "../escape.json"` → `assertWithinDir` rejects.
- Pre-packed tarball already contains the manifest path → refuses to overwrite.
- Missing env var → actionable error (via `vi.stubEnv`).
- `spawn` stubbed for `npm publish` (no registry call).

No new Rekor network fixtures — `rekor.ts` tests cover that surface.

## Out of scope

- PyPI / maturin parallel (different trust infrastructure).
- Non-GitHub CI providers (manifest schema is GitHub-specific by design).
- Non-npmjs registries (TUF-backed `dist.signatures` is an npmjs feature).
- Bundled attestation format (sigstore bundle inside the tarball). Rejected in favour of
  Rekor-lookup-by-hash for simplicity.
