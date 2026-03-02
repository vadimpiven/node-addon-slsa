# node-addon-slsa

Supply-chain provenance verification for npm packages with
prebuilt native addons. Ensures that both the npm package and
its prebuilt binary were produced by the same GitHub Actions
workflow run, using [sigstore] and the
[GitHub Attestations API][gh-attestations]. Installation
aborts with a `SECURITY` error if any verification step fails.

[sigstore]: https://www.sigstore.dev/
[gh-attestations]: https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds

## End-to-end example

### 1. Configure your package

```json
{
    "name": "my-native-addon",
    "version": "1.0.0",
    "repository": {
        "url": "git+https://github.com/owner/repo.git"
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

- **`addon.path`** — where the native binary is installed,
  relative to the package root
- **`addon.url`** — download URL template; supports
  `{version}`, `{platform}`, `{arch}` placeholders
- **`postinstall`** — runs `slsa wget` on `npm install`:
  downloads the binary, verifies provenance, installs it
- **`pack-addon`** — runs `slsa pack` in CI: gzip-compresses
  the binary before uploading to a GitHub release

### 2. Build and publish in CI

```yaml
jobs:
    build:
        runs-on: ubuntu-latest
        permissions:
            id-token: write       # OIDC token for sigstore
            contents: write       # gh release upload
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
            id-token: write       # npm provenance
        steps:
            - run: npm publish --provenance --access public
```

### 3. On `npm install`

The `slsa wget` postinstall hook runs automatically:

1. Verifies npm package provenance via sigstore
2. Extracts the GitHub Actions Run Invocation URI from the
   Fulcio certificate
3. Downloads the compressed binary from the GitHub release
4. Verifies the binary's attestation matches the same
   workflow run
5. Decompresses and installs the binary

## Details

### `repository` field

The `repository` field (or `repository.url`) determines the
expected GitHub repository for attestation verification.
Both CLI commands read it from `package.json` in the working
directory.

### CLI

| Command     | Purpose                                         |
| ----------- | ----------------------------------------------- |
| `slsa wget` | Download, verify, and install the native binary |
| `slsa pack` | Gzip-compress the native binary for release     |

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

- Node.js `^20.19.0 || >=22.12.0`
- npm package published with
  [`--provenance`][npm-provenance]
- Binary attested with
  [`actions/attest-build-provenance`][attest-action]

[npm-provenance]: https://docs.npmjs.com/generating-provenance-statements
[attest-action]: https://github.com/actions/attest-build-provenance

## License

Apache-2.0 OR MIT
