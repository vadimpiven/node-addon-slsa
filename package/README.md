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

Verifies that an npm package and its prebuilt native addon binary were
produced by the _same_ GitHub Actions workflow run. Uses [sigstore] for
npm provenance and the [Rekor transparency log][rekor] for binary
verification. Aborts `npm install` with a `SECURITY` error if any check
fails.

No authentication required. No `GITHUB_TOKEN`.

[sigstore]: https://www.sigstore.dev/
[rekor]: https://docs.sigstore.dev/logging/overview/

> **Private repositories:** the `attest-public` action logs repository
> name, workflow paths, commit SHAs, and run URLs to the public Rekor
> transparency log. Source code stays private.

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
    "node-addon-slsa": "0.6.5"
  }
}
```

- **`addon.path`** — where the addon is installed (relative to package root)
- **`addon.url`** — download template; `{version}`, `{platform}`, `{arch}`
  resolve at install time
- **`postinstall`** — `slsa wget` downloads, verifies, and installs the
  binary on `npm install`
- **`pack-addon`** — `slsa pack` gzip-compresses the binary for release
- **`exports["./package.json"]`** — required for
  [loading the addon](#loading-the-addon)
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
      id-token: write # OIDC token for sigstore
      attestations: write # build provenance
    steps:
      - uses: actions/checkout@v6
      # ... set up toolchain, build native addon ...
      - name: Compress binary for release
        run: npx slsa pack
      - name: Attest binary provenance
        uses: vadimpiven/node-addon-slsa/attest-public@<commit-sha> # pin to SHA
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
      contents: read
      id-token: write # npm provenance via OIDC
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npm publish --provenance --access public
```

Pin the `attest-public` action to a commit SHA, not a mutable tag.

Each matrix runner produces a platform-specific binary. The `{platform}`
and `{arch}` placeholders resolve to `process.platform` and `process.arch`
at install time.

## API reference

### CLI

| Command / Option | Purpose                                        |
| ---------------- | ---------------------------------------------- |
| `slsa wget`      | Download, verify, and install the native addon |
| `slsa pack`      | Gzip-compress the native addon for release     |
| `--help`, `-h`   | Show usage information                         |
| `SLSA_DEBUG=1`   | Debug logging to stderr                        |

### Programmatic API

```typescript
import {
  verifyPackageProvenance,
  verifyAddonProvenance,
  isProvenanceError,
  sha256Hex,
  semVerString,
  githubRepo,
} from "node-addon-slsa";
import type { PackageProvenance, VerifyOptions } from "node-addon-slsa";

// Verify npm package provenance via sigstore.
// Returns { runInvocationURI, verifyAddon() }.
const provenance: PackageProvenance = await verifyPackageProvenance({
  packageName: "my-native-addon",
  version: semVerString("1.0.0"),
  repo: githubRepo("owner/repo"),
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

#### Types

| Type               | Constructor               | Purpose                                  |
| ------------------ | ------------------------- | ---------------------------------------- |
| `GitHubRepo`       | `githubRepo(value)`       | GitHub `owner/repo` slug                 |
| `SemVerString`     | `semVerString(value)`     | Strict semver (no `v` prefix)            |
| `Sha256Hex`        | `sha256Hex(value)`        | Lowercase hex-encoded SHA-256 (64 chars) |
| `RunInvocationURI` | `runInvocationURI(value)` | GitHub Actions run invocation URL        |

Constructors validate at runtime and throw `TypeError` on invalid input.

#### Options

All options have sensible defaults. Pass only what you need:

```typescript
await verifyPackageProvenance({
  packageName: "my-native-addon",
  version: semVerString("1.0.0"),
  repo: githubRepo("owner/repo"),
  // All below are optional:
  timeoutMs: 60_000, // per-request timeout (default: 30s)
  retryCount: 5, // retries after first attempt (default: 2)
  trustMaterial, // pre-loaded via loadTrustMaterial()
  dispatcher, // custom undici Dispatcher
});
```

#### Error handling

- `ProvenanceError` — verification failed (tampered artifact, mismatched
  provenance). Do not retry.
- `Error` — transient issue (network timeout, service unavailable).
  Safe to retry.

```typescript
try {
  await provenance.verifyAddon({ sha256 });
} catch (err) {
  if (isProvenanceError(err)) {
    // Security failure — do not use this package version
  } else {
    // Transient — safe to retry
  }
}
```

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

## Requirements

- Node.js `^20.19.0 || >=22.12.0`
- npm package published with [`--provenance`][npm-provenance]
- Binary attested with `vadimpiven/node-addon-slsa/attest-public`

[npm-provenance]: https://docs.npmjs.com/generating-provenance-statements
