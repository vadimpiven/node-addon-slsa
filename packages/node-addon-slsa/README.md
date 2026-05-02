[![GitHub repo][github-badge]][github-repo]
[![npm version][npm-badge]][npm-package]
[![API docs][docs-badge]][docs-site]
[![Ask DeepWiki][deepwiki-badge]][deepwiki-site]
[![CI status][status-badge]][status-dashboard]
[![Test coverage][coverage-badge]][coverage-dashboard]
[![Supply-chain score][socket-badge]][socket-dashboard]

[github-badge]: https://img.shields.io/github/stars/vadimpiven/node-addon-slsa?style=flat&logo=github
[github-repo]: https://github.com/vadimpiven/node-addon-slsa
[npm-badge]: https://img.shields.io/npm/v/node-addon-slsa?logo=npm
[npm-package]: https://www.npmjs.com/package/node-addon-slsa
[docs-badge]: https://img.shields.io/badge/API_docs-typedoc-blue?logo=readthedocs
[docs-site]: https://vadimpiven.github.io/node-addon-slsa
[deepwiki-badge]: https://deepwiki.com/badge.svg
[deepwiki-site]: https://deepwiki.com/vadimpiven/node-addon-slsa
[status-badge]: https://img.shields.io/github/checks-status/vadimpiven/node-addon-slsa/main?logo=githubactions&label=CI
[status-dashboard]: https://github.com/vadimpiven/node-addon-slsa/actions?query=branch%3Amain
[coverage-badge]: https://img.shields.io/codecov/c/github/vadimpiven/node-addon-slsa/main?logo=codecov
[coverage-dashboard]: https://app.codecov.io/gh/vadimpiven/node-addon-slsa/tree/main
[socket-badge]: https://badge.socket.dev/npm/package/node-addon-slsa
[socket-dashboard]: https://socket.dev/npm/package/node-addon-slsa

# node-addon-slsa

Verifies that an npm package and its prebuilt native addon binary were
produced by the _same_ GitHub Actions workflow run. Uses [sigstore] for
npm provenance and the [Rekor transparency log][rekor] for binary
verification. Aborts `npm install` with a `SECURITY` error if any check
fails.

No authentication required. No `GITHUB_TOKEN`.

[sigstore]: https://www.sigstore.dev/
[rekor]: https://docs.sigstore.dev/logging/overview/

> **Private repositories:** the reusable `publish.yaml` workflow logs
> repository name, workflow paths, commit SHAs, and run URLs to the
> public Rekor transparency log. Source code stays private.

## Threat model

Trusts **GitHub Actions** (build environment, attestation authority) and
the **sigstore public-good instance** (Fulcio CA, Rekor). If either is
compromised, verification may pass for malicious artifacts.

### Protected

| Threat                        | Mitigation                                       |
| ----------------------------- | ------------------------------------------------ |
| Tampered npm package          | sigstore provenance verification                 |
| Tampered GitHub release       | Rekor transparency log + sigstore                |
| Mismatched artifacts          | Same workflow run check via Run Invocation URI   |
| Man-in-the-middle on download | SHA-256 hash verified against signed attestation |
| Path traversal via addon.path | Resolved path must stay within package directory |

### Not protected

- **Compromised CI workflow** — attestations will be valid for malicious
  code. This tool verifies _provenance_, not _intent_.
- **Compromised maintainer account** — write access to the repository
  allows producing legitimately attested malicious builds.
- **Dependency confusion** — verifies a single package, not its
  transitive dependency tree.
- **Version `0.0.0`** — verification is skipped (local development).
  Never publish `0.0.0` to npm.

## Setup

### 1. `package.json`

```json
{
  "name": "my-native-addon",
  "version": "1.0.0",
  "repository": {
    "url": "git+https://github.com/owner/repo.git"
  },
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "addon": {
    "path": "./dist/my_addon.node",
    "manifest": "./dist/slsa-manifest.json",
    "attestWorkflow": "release.yaml"
  },
  "scripts": {
    "postinstall": "slsa wget",
    "pack-addon": "slsa pack"
  },
  "dependencies": {
    "node-addon-slsa": "0.7.1"
  }
}
```

- **`addon.path`** — where the addon is installed (relative to package root).
- **`addon.attestWorkflow`** — filename (no path) of the GitHub Actions
  workflow in your repo that mints provenance attestations (the one that
  runs `attest-addon` — see [CI workflow](#2-ci-workflow)). The verifier
  pins the Fulcio Build Signer URI to
  `<repo>/.github/workflows/<attestWorkflow>@<40-hex>`; attestations
  minted by any other workflow in the same repo (including a malicious
  new one) are rejected.
- **`addon.manifest`** — path to the generated SLSA manifest inside the
  published tarball. The manifest carries each platform/arch binary's
  download URL, sidecar sigstore bundle URL, and SHA-256; the publish
  workflow produces it, so do not commit it by hand.
- **`postinstall`** — `slsa wget` reads the manifest, downloads the
  binary for the current platform/arch, and verifies its provenance.
  Pair with [`requireAddon`](#3-loading-the-addon): pnpm ≥ 10 blocks
  `postinstall` scripts by default, so consumers may never run this hook.
- **`pack-addon`** — `slsa pack` gzip-compresses the binary for release.
- **`repository`** — github.com URL (HTTPS, SSH, with or without `.git`).
  Determines the expected source repository for attestation checks.

### 2. CI workflow

```yaml
env:
  RELEASE_BASE_URL: "https://github.com/${{ github.repository }}/releases/download/${{ github.ref_name }}/"

jobs:
  # Must be ONE file named exactly as `addon.attestWorkflow` in
  # package.json — the install-time verifier pins attestations to this
  # exact workflow file. Don't rename it without bumping a release.
  build-addon:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-24.04, macos-15, windows-2025]
    runs-on: ${{ matrix.os }}
    permissions:
      contents: write # release upload
      id-token: write # sigstore OIDC
      attestations: write
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      # ... set up toolchain, build native addon, then:
      - name: Compress binary for release
        run: npx slsa pack
      - name: Attest addon (public-good sigstore)
        id: attest
        uses: vadimpiven/node-addon-slsa/.github/actions/attest-addon@<commit-sha>
        with:
          binary: dist/my_addon-v*.node.gz
          url-prefix: ${{ env.RELEASE_BASE_URL }}
      - name: Upload binary and sidecar to release
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
          BINARY_PATH: ${{ steps.attest.outputs.binary-path }}
          BUNDLE_PATH: ${{ steps.attest.outputs.bundle-path }}
        # `--clobber` so re-running a single failed matrix cell overwrites
        # any partial assets from the previous attempt instead of 422-ing.
        run: gh release upload "${{ github.ref_name }}" --clobber "$BINARY_PATH" "$BUNDLE_PATH"

  pack-tarball:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      # ... set up Node / pnpm, build JS, then:
      - run: npm pack
      - name: Upload pre-packed tarball
        uses: actions/upload-artifact@330a01c490aca151604b8cf639adc76d48f6c5d4 # v5.0.0
        with:
          name: my-tarball # any name; passed to publish.yaml below
          path: ./*.tgz
          if-no-files-found: error
          retention-days: 1

  publish:
    needs: [build-addon, pack-tarball]
    uses: vadimpiven/node-addon-slsa/.github/workflows/publish.yaml@<commit-sha>
    permissions:
      id-token: write # npm trusted publishing
    with:
      tarball-artifact: my-tarball # must match the upload-artifact name
      addons-artifact-pattern: slsa-addons-*
      release-base-url: https://github.com/${{ github.repository }}/releases/download/${{ github.ref_name }}/
```

Pin every third-party action to a commit SHA with a trailing `# vX.Y.Z`
comment, not a mutable tag — SHAs are immutable and audit-friendly.

Flow: each matrix runner builds its `.node.gz`, calls `attest-addon` to
hash the local binary, mint a public-good sigstore bundle covering the
future public URL, and upload a per-binary descriptor as a GHA artifact
named `slsa-addons-<platform>-<arch>`. The same step uploads the
binary and its `.sigstore` sidecar to the caller's distribution
(GitHub Releases, S3, R2 — anywhere public). `publish.yaml` then
downloads every matching descriptor artifact, validates each
descriptor's `url` against `release-base-url` (the trust anchor),
aggregates them into the addon URL map, re-fetches both binary and
bundle from their public URLs (with CDN-propagation retries), runs the
full sigstore verify chain (TUF → Fulcio → Rekor inclusion), pins the
Fulcio Build Signer URI to the caller's `attestWorkflow`, writes the
SLSA manifest into the tarball, and publishes to npm via trusted
publishing. At install time `slsa wget` re-fetches the binary, its
bundle, and runs the same chain — no token required because bundles
inherit the binary's auth model.

If `publish` fails after the GitHub release has been finalized
(immutable releases), retry only the `publish` job from the GHA UI:
the public binary URLs are stable, the pre-packed tarball and
descriptor artifacts persist, and `publish.yaml` is idempotent (npm
rejects duplicate version publishes). Do not modify or delete the
release.

### 3. Loading the addon

```typescript
import { requireAddon } from "node-addon-slsa";

type MyAddon = { greet(name: string): string };

export const addon = await requireAddon<MyAddon>();
```

Walks up from the caller's file to the enclosing `package.json`, then
downloads and provenance-verifies the binary if missing. Subsequent
calls are a `stat` plus `require` — safe to invoke at module load.

- `T` defaults to `unknown`; supply the addon's type at the call site.
- Pass `{ from: import.meta.url }` when the caller lives outside the
  consuming package (e.g. a re-export wrapper).
- `RequireAddonOptions` extends [`VerifyOptions`](#options); see
  [error handling](#error-handling) for failure modes.

## API reference

### CLI

| Command / Option              | Purpose                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `slsa wget`                   | Download, verify, and install the native addon                                     |
| `slsa pack [output-template]` | Gzip-compress the native addon. Template tokens: `{version}`/`{platform}`/`{arch}` |
| `--help`, `-h`                | Show usage information                                                             |
| `SLSA_DEBUG=1`                | Debug logging to stderr                                                            |

### Programmatic API

```typescript
import { verifyPackage, requireAddon, isProvenanceError } from "node-addon-slsa";
import type {
  VerifyPackageOptions,
  PackageProvenance,
  VerifyOptions,
} from "node-addon-slsa";

// Verify the installed package's manifest attestation via Sigstore/Rekor.
// Returns a handle for verifying individual addon binaries.
const provenance: PackageProvenance = await verifyPackage({
  packageName: "my-native-addon",
  repo: "owner/repo",
});

// Verify a binary you've already hashed.
await provenance.verifyAddonBySha256(hexHash);

// Or hash-and-verify a file in one call.
await provenance.verifyAddonFromFile("/path/to/addon.node.gz");

// Runtime loader: verify-on-demand, then require the addon.
// Supply the addon's type as T (defaults to `unknown`).
const addon = await requireAddon<MyAddon>();
```

#### Options

All options have sensible defaults. Pass only what you need:

```typescript
await verifyPackage({
  packageName: "my-native-addon",
  repo: "owner/repo",
  // All below are optional:
  cwd: process.cwd(), // resolution base; defaults to process.cwd()
  refPattern: /^refs\/tags\/v?1\./, // RegExp or exact-match string
  timeoutMs: 60_000, // per-request HTTP timeout (default: 30s)
  maxBinaryBytes: 256 * 1024 * 1024, // per-binary size cap (default: 256 MiB)
  maxBinarySeconds: 300, // per-binary download timeout (default: 300s)
  bundleFetchRetryDelays: [2000, 5000, 10000, 15000], // retry ms for sidecar 404s
  trustMaterial, // pre-loaded via loadTrustMaterial()
  dispatcher, // custom undici Dispatcher
  signal, // AbortSignal
});
```

#### Error handling

- `ProvenanceError` — verification failed (tampered artifact, mismatched
  provenance, missing/invalid sigstore bundle). Do not retry. The `kind`
  field is reserved for future fine-grained discrimination; currently
  `"other"` covers every failure mode.
- `Error` — transient issue (network timeout, service unavailable).
  Safe to retry.

```typescript
try {
  await provenance.verifyAddonBySha256(sha256);
} catch (err) {
  if (isProvenanceError(err)) {
    // Security failure — do not use this package version
  } else {
    // Transient — safe to retry
  }
}
```

#### Advanced: `node-addon-slsa/advanced`

Heavy callers verifying many packages in one process can preload trust
material once and inject a verifier:

```typescript
import { verifyPackage } from "node-addon-slsa";
import { loadTrustMaterial, createBundleVerifier } from "node-addon-slsa/advanced";

const verifier = createBundleVerifier(await loadTrustMaterial());
for (const name of packages) {
  const p = await verifyPackage({ packageName: name, repo: "owner/repo", verifier });
  await p.verifyAddonFromFile(`/path/to/${name}/dist/addon.node.gz`);
}
```

## Requirements

- Node.js `>=22.12.0`
- npm package published via the reusable
  `vadimpiven/node-addon-slsa/.github/workflows/publish.yaml` workflow
  (handles both [npm provenance][npm-provenance] and per-addon Rekor
  attestations)

[npm-provenance]: https://docs.npmjs.com/generating-provenance-statements
