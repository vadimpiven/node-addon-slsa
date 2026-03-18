[![GitHub repo][github-badge]][github-repo]
[![npm version][npm-badge]][npm-package]
[![API docs][docs-badge]][docs-site]
[![Ask DeepWiki][deepwiki-badge]][deepwiki-site]
[![CI status][status-badge]][status-dashboard]
[![Test coverage][coverage-badge]][coverage-dashboard]

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

# node-addon-slsa

Verifies that an npm package and its prebuilt native addon binary were produced
by the _same_ GitHub Actions workflow run. Uses [sigstore] for npm provenance
and the [GitHub Attestations API][gh-attestations] for binary verification.
Aborts `npm install` with a `SECURITY` error if any check fails.

[sigstore]: https://www.sigstore.dev/
[gh-attestations]: https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations

## Threat model

This tool trusts two infrastructure providers: **GitHub Actions** (build
environment and attestation authority) and the **sigstore public-good
instance** (Fulcio CA, Rekor transparency log). If either is compromised,
verification may pass for malicious artifacts.

### Protected

| Threat                        | Mitigation                                       |
| ----------------------------- | ------------------------------------------------ |
| Tampered npm package          | sigstore provenance verification                 |
| Tampered GitHub release       | GitHub Attestations API + sigstore               |
| Mismatched artifacts          | Same workflow run check via URI                  |
| Man-in-the-middle on download | SHA-256 hash verified against signed attestation |
| Path traversal via addon.path | Resolved path must stay within package directory |

### Not protected

- **Compromised CI workflow** — if the workflow itself is malicious, all
  attestations will be valid for malicious code. This tool verifies
  _provenance_, not _intent_.
- **Compromised maintainer account** — an attacker with write access to the
  repository can modify the workflow and produce legitimately attested builds.
- **Dependency confusion** — the tool verifies a single package, not its
  transitive dependency tree.
- **Version `0.0.0`** — all verification is skipped, by design, for local
  development and CI testing. Never publish version `0.0.0` to npm.

## Setup

### 1. Configure `package.json`

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
    },
    "./package.json": "./package.json"
  },
  "addon": {
    "path": "./dist/my_addon.node",
    "url": "https://github.com/owner/repo/releases/download/v{version}/my_addon-v{version}-{platform}-{arch}.node.gz"
  },
  "scripts": {
    "postinstall": "slsa wget",
    "pack-addon": "slsa pack"
  },
  "dependencies": {
    "node-addon-slsa": "0.6.4"
  }
}
```

- **`addon.path`** — where the native addon is installed, relative to the
  package root
- **`addon.url`** — download URL template; supports `{version}`,
  `{platform}`, `{arch}` placeholders
- **`postinstall`** — runs `slsa wget` on `npm install`: downloads the
  binary, verifies provenance, installs it
- **`pack-addon`** — runs `slsa pack` in CI: gzip-compresses the binary
  before uploading to a release
- **`exports["./package.json"]`** — required for loading the addon at
  runtime (see [Loading the addon](#loading-the-addon))

### 2. CI setup

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
      id-token: write # OIDC token for sigstore
      attestations: write # build provenance
    steps:
      - uses: actions/checkout@v6
      # ... set up toolchain, build native addon ...
      - name: Compress binary for release
        run: npx slsa pack
      - name: Attest binary provenance
        uses: actions/attest-build-provenance@v4
        with:
          subject-path: dist/my_addon-v*.node.gz
      - name: Upload binary to release
        uses: softprops/action-gh-release@v2
        with:
          files: dist/my_addon-v*.node.gz

  publish:
    needs: build-addon
    runs-on: ubuntu-latest
    permissions:
      contents: read # to fetch code
      id-token: write # npm provenance via OIDC
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npm publish --provenance --access public
```

Each matrix runner produces a platform-specific binary (e.g.
`my_addon-v1.0.0-linux-x64.node.gz`). The `{platform}` and `{arch}`
placeholders in `addon.url` resolve to `process.platform` and
`process.arch` at install time, so each user downloads the correct
binary for their OS.

## How verification works

`slsa wget` runs on `npm install`:

1. Verifies npm package provenance via sigstore
2. Extracts the Run Invocation URI from the Fulcio certificate
3. Downloads the compressed binary from the GitHub release, computing a
   SHA-256 hash of the compressed bytes and decompressing into a temp file
4. Verifies the binary's GitHub attestation matches the same workflow run
5. Moves the verified binary to its final location

On failure, the temp file is removed and installation aborts.

## API reference

### CLI

| Command / Option | Purpose                                        |
| ---------------- | ---------------------------------------------- |
| `slsa pack`      | Gzip-compress the native addon for release     |
| `slsa wget`      | Download, verify, and install the native addon |
| `--help`, `-h`   | Show usage information                         |

### Environment variables

| Variable       | Purpose                                                             |
| -------------- | ------------------------------------------------------------------- |
| `GITHUB_TOKEN` | GitHub API auth (required for private repos, increases rate limits) |
| `SLSA_DEBUG=1` | Debug logging to stderr                                             |

### Programmatic API

#### Types

| Type               | Constructor               | Purpose                                  |
| ------------------ | ------------------------- | ---------------------------------------- |
| `GitHubRepo`       | `githubRepo(value)`       | GitHub `owner/repo` slug                 |
| `SemVerString`     | `semVerString(value)`     | Strict semver (no `v` prefix)            |
| `Sha256Hex`        | `sha256Hex(value)`        | Lowercase hex-encoded SHA-256 (64 chars) |
| `RunInvocationURI` | `runInvocationURI(value)` | GitHub Actions run invocation URL        |

Constructors validate at runtime and throw `TypeError` on invalid input.

#### Functions

```typescript
import {
  verifyPackageProvenance,
  verifyAddonProvenance,
  isProvenanceError,
  sha256Hex,
  semVerString,
  githubRepo,
} from "node-addon-slsa";
import type {
  PackageProvenance,
  RunInvocationURI,
  VerifyOptions,
} from "node-addon-slsa";

// Verify npm package provenance via sigstore.
// Returns { runInvocationURI, verifyAddon() }.
const provenance: PackageProvenance = await verifyPackageProvenance({
  packageName: "my-native-addon",
  version: semVerString("1.0.0"),
  repo: githubRepo("owner/repo"),
});

// With custom timeouts (e.g. behind a slow proxy):
const provenance2 = await verifyPackageProvenance({
  packageName: "my-native-addon",
  version: semVerString("1.0.0"),
  repo: githubRepo("owner/repo"),
  timeoutMs: 60_000,
  retryCount: 5,
});

// Verify the addon binary was produced by the same workflow run.
await provenance.verifyAddon({ sha256: sha256Hex(hexHash) });

// Standalone binary verification when you already have a URI.
await verifyAddonProvenance({
  sha256: sha256Hex(hexHash),
  runInvocationURI,
  repo: githubRepo("owner/repo"),
});
```

#### Error handling

- `ProvenanceError` — verification failed (tampered artifact, mismatched
  provenance). Do not retry.
- `Error` — transient issue (network timeout, GitHub API rate limit).
  Safe to retry.

Use `isProvenanceError(err)` in catch blocks to distinguish the two.

Non-security errors include a `Set SLSA_DEBUG=1 for detailed diagnostics`
hint. When reporting issues, include the debug output.

## Configuration

### `repository` field

The `repository` field (or `repository.url`) determines the expected GitHub
repository for attestation verification. Both CLI commands read it from
`package.json` in the working directory. Only `github.com` URLs are
supported (HTTPS, SSH, with or without `.git` suffix).

### Loading the addon

```typescript
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../package.json" with { type: "json" };

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const addon = require(join(root, packageJson.addon.path));
```

The `"./package.json"` export in your `exports` map is required for this
JSON import to resolve under strict ESM exports.

### Authentication

Public repositories work without authentication. Private repositories **require** `GITHUB_TOKEN`.
Unauthenticated requests are limited to 60/hour by GitHub. Set `GITHUB_TOKEN` to increase:

```sh
export GITHUB_TOKEN="$(gh auth token)"
```

## Requirements

- Node.js `^20.19.0 || >=22.12.0`
- npm package published with [`--provenance`][npm-provenance]
- Binary attested with
  [`actions/attest-build-provenance`][attest-action]

[npm-provenance]: https://docs.npmjs.com/generating-provenance-statements
[attest-action]: https://github.com/actions/attest-build-provenance
