[![CI status][status-badge]][status-dashboard]
[![Test coverage][coverage-badge]][coverage-dashboard]

[status-badge]: https://img.shields.io/github/checks-status/vadimpiven/node-addon-slsa/main
[status-dashboard]: https://github.com/vadimpiven/node-addon-slsa/actions?query=branch%3Amain
[coverage-badge]: https://img.shields.io/codecov/c/github/vadimpiven/node-addon-slsa/main
[coverage-dashboard]: https://app.codecov.io/gh/vadimpiven/node-addon-slsa/tree/main

# node-addon-slsa

Supply-chain provenance verification for npm packages with prebuilt native addons.
Ensures that both the npm package and its prebuilt binary were produced by the same
GitHub Actions workflow run, using [sigstore] and the [GitHub Attestations API][gh-attestations].
Installation aborts with a `SECURITY` error if any verification step fails.

[sigstore]: https://www.sigstore.dev/
[gh-attestations]: https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations

## End-to-end example

### 1. Configure your package

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
    "node-addon-slsa": "^1.0.0"
  }
}
```

- **`exports`** — the `"./package.json"` entry is required
  so your code can `import pkg from "./package.json"` to
  read `addon.path` at runtime; without it, Node.js strict
  ESM exports resolution blocks access
- **`addon.path`** — where the native binary is installed,
  relative to the package root
- **`addon.url`** — download URL template;
  supports `{version}`, `{platform}`, `{arch}` placeholders
- **`postinstall`** — runs `slsa wget` on `npm install`:
  downloads the binary, verifies provenance, installs it
- **`pack-addon`** — runs `slsa pack` in CI:
  gzip-compresses the binary before uploading to a GitHub
  release

### 2. Build and publish in CI

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      id-token: write # OIDC token for sigstore
      contents: write # gh release upload
      attestations: write
    steps:
      - uses: actions/checkout@v6
      - run: npm run build
      - name: Compress binary for release
        run: npx slsa pack
      - name: Attest binary provenance
        uses: actions/attest-build-provenance@v4
        with:
          subject-path: dist/my_addon-v*.node.gz
      - name: Upload binary to release
        run: gh release upload "$TAG" dist/my_addon-v*.node.gz

  publish:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      id-token: write # npm provenance
    steps:
      - run: npm publish --provenance --access public
```

### 3. On `npm install`

The `slsa wget` postinstall hook runs automatically:

1. Verifies npm package provenance via sigstore
2. Extracts the GitHub Actions Run Invocation URI from the Fulcio certificate
3. Downloads the compressed binary from the GitHub release
4. Verifies the binary's attestation matches the same workflow run
5. Decompresses and installs the binary

### 4. Load the native addon

Use the `addon.path` from your `package.json` to locate
the downloaded binary:

```typescript
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../package.json" with { type: "json" };

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const addon = require(join(root, packageJson.addon.path));
```

This is why the `"./package.json"` export is required —
it allows the JSON import to resolve under strict ESM exports.

## Details

### `repository` field

The `repository` field (or `repository.url`) determines the
expected GitHub repository for attestation verification.
Both CLI commands read it from `package.json` in the working directory.

### CLI

| Command / Option         | Purpose                                         |
| ------------------------ | ----------------------------------------------- |
| `slsa pack`              | Gzip-compress the native binary for release     |
| `slsa wget`              | Download, verify, and install the native binary |
| `slsa wget --no-verify`  | Download without provenance verification        |
| `slsa --help`, `slsa -h` | Show usage information                          |

### Verification chain

The sigstore verification validates the full Fulcio CA chain,
transparency log inclusion proof, Signed Entry Timestamp
(SET), and Signed Certificate Timestamps (SCTs). The binary
verification then confirms the GitHub attestation was signed
in the same workflow run as the npm package, linking both
artifacts to a single auditable build.

| Threat                  | Mitigation                         |
| ----------------------- | ---------------------------------- |
| Tampered npm package    | sigstore provenance verification   |
| Tampered GitHub release | GitHub Attestations API + sigstore |
| Mismatched artifacts    | Same workflow run check via URI    |

### Development mode

Version `0.0.0` skips all verification, allowing local
development and CI testing without published attestations.

### Requirements

- Node.js `^20.19.0 || >=22.12.0` for ESM support
- npm package published with [`--provenance`][npm-provenance]
- Binary attested with [`actions/attest-build-provenance`][attest-action]

[npm-provenance]: https://docs.npmjs.com/generating-provenance-statements
[attest-action]: https://github.com/actions/attest-build-provenance
