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
  runs `attest-addons` — see [CI workflow](#2-ci-workflow)). The verifier
  pins the Fulcio Build Signer URI to
  `<repo>/.github/workflows/<attestWorkflow>@<40-hex>`; attestations
  minted by any other workflow in the same repo (including a malicious
  new one) are rejected.
- **`addon.manifest`** (optional) — path to the generated SLSA manifest
  inside the published tarball. Defaults to `./slsa-manifest.json`. The
  manifest carries each platform/arch binary's download URL, sidecar
  sigstore bundle URL, and SHA-256; the publish workflow produces it, so
  do not commit it by hand.
- **`postinstall`** — `slsa wget` reads the manifest, downloads the
  binary for the current platform/arch, and verifies its provenance.
  Pair with [`requireAddon`](#3-loading-the-addon): pnpm ≥ 10 blocks
  `postinstall` scripts by default, so consumers may never run this hook.
- **`pack-addon`** — `slsa pack` gzip-compresses the binary for release.
- **`repository`** — github.com URL (HTTPS, SSH, with or without `.git`).
  Determines the expected source repository for attestation checks.

### 2. CI workflow

```yaml
jobs:
  build-addon:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-24.04, macos-15, windows-2025]
    runs-on: ${{ matrix.os }}
    permissions:
      contents: write # release upload
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      # ... set up toolchain, build native addon ...
      - name: Compress binary for release
        run: npx slsa pack
      - name: Upload binary to release
        uses: softprops/action-gh-release@b4309332981a82ec1c5618f44dd2e27cc8bfbfda # v3.0.0
        with:
          files: dist/my_addon-v*.node.gz

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

  # Must be ONE file named exactly as `addon.attestWorkflow` in
  # package.json — the install-time verifier pins attestations to this
  # exact workflow file. Don't rename it without bumping a release.
  attest-addons:
    needs: build-addon
    runs-on: ubuntu-latest
    permissions:
      id-token: write # sigstore OIDC
      attestations: write
      contents: write # upload sidecar bundles to the release
    steps:
      - name: Attest addons (public-good sigstore)
        id: attest
        uses: vadimpiven/node-addon-slsa/.github/actions/attest-addons@<commit-sha>
        with:
          addons: ${{ env.ADDONS }}
          bundle-dir: ${{ runner.temp }}/slsa-bundles
      - name: Upload sidecar bundles to wherever the addons live
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
          BUNDLES: ${{ steps.attest.outputs.bundles }}
        # Replace with your CDN upload if addons aren't on GitHub Releases.
        # Every file under `.path` must land at the URL declared in `.bundleUrl`.
        run: |
          set -euo pipefail
          mapfile -t paths < <(jq -r '.[].path' <<<"$BUNDLES")
          gh release upload "${{ github.ref_name }}" "${paths[@]}" --clobber

  publish:
    needs: [attest-addons, pack-tarball]
    uses: vadimpiven/node-addon-slsa/.github/workflows/publish.yaml@<commit-sha>
    permissions:
      id-token: write # npm trusted publishing
    with:
      tarball-artifact: my-tarball # must match the upload-artifact name
      addons: |
        {
          "linux":  { "x64":   {
            "url":       "https://github.com/owner/repo/releases/download/v${{ github.ref_name }}/my_addon-v${{ github.ref_name }}-linux-x64.node.gz",
            "bundleUrl": "https://github.com/owner/repo/releases/download/v${{ github.ref_name }}/my_addon-v${{ github.ref_name }}-linux-x64.node.gz.sigstore"
          } },
          "darwin": { "arm64": {
            "url":       "https://github.com/owner/repo/releases/download/v${{ github.ref_name }}/my_addon-v${{ github.ref_name }}-darwin-arm64.node.gz",
            "bundleUrl": "https://github.com/owner/repo/releases/download/v${{ github.ref_name }}/my_addon-v${{ github.ref_name }}-darwin-arm64.node.gz.sigstore"
          } }
        }
```

Pin every third-party action to a commit SHA with a trailing `# vX.Y.Z`
comment, not a mutable tag — SHAs are immutable and audit-friendly.

Flow: each matrix runner builds + uploads its `.node.gz` to the caller's
chosen distribution (GitHub Releases, Cloudflare R2, S3 — anywhere
public). The `attest-addons` job then fetches each URL, hashes the
bytes, mints one multi-subject sigstore bundle on the public-good
instance, and uploads each `.node.gz.sigstore` sidecar to its
`bundleUrl`. Finally `publish.yaml` re-fetches both (with
CDN-propagation retries), runs the full sigstore verify chain (TUF →
Fulcio → Rekor inclusion), pins the Fulcio Build Signer URI to the
caller's `attestWorkflow`, writes the SLSA manifest into the tarball,
and publishes to npm via trusted publishing. At install time `slsa
wget` re-fetches the binary, its bundle, and runs the same chain — no
token required because bundles inherit the binary's auth model.

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
