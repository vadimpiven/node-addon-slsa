[![CI status][status-badge]][status-dashboard]
[![Test coverage][coverage-badge]][coverage-dashboard]
[![npm version][npm-badge]][npm-package]

[status-badge]: https://img.shields.io/github/checks-status/vadimpiven/node-addon-slsa/main
[status-dashboard]: https://github.com/vadimpiven/node-addon-slsa/actions?query=branch%3Amain
[coverage-badge]: https://img.shields.io/codecov/c/github/vadimpiven/node-addon-slsa/main
[coverage-dashboard]: https://app.codecov.io/gh/vadimpiven/node-addon-slsa/tree/main
[npm-badge]: https://img.shields.io/npm/v/node-addon-slsa
[npm-package]: https://www.npmjs.com/package/node-addon-slsa

# node-addon-slsa

You `npm install` a package with a prebuilt `.node` binary. The package
is signed — but how do you know the binary was built from the same
source? You don't, unless both artifacts are verified against the same
CI run.

`node-addon-slsa` cross-checks [sigstore] npm provenance with
[GitHub Attestations][gh-attestations] to confirm the package and its
binary were produced by the _same_ GitHub Actions workflow run.
If they were not, installation aborts with a `SECURITY` error.

[sigstore]: https://www.sigstore.dev/
[gh-attestations]: https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations

```sh
npm install node-addon-slsa
```

## Usage

```json
{
  "addon": {
    "path": "./dist/my_addon.node",
    "url": "https://github.com/owner/repo/releases/download/v{version}/my_addon-v{version}-{platform}-{arch}.node.gz"
  },
  "scripts": {
    "postinstall": "slsa wget",
    "pack-addon": "slsa pack"
  }
}
```

Programmatic API:

```typescript
import {
  verifyPackageProvenance,
  semVerString,
  githubRepo,
} from "node-addon-slsa";

const provenance = await verifyPackageProvenance({
  packageName: "my-native-addon",
  version: semVerString("1.0.0"),
  repo: githubRepo("owner/repo"),
});

await provenance.verifyAddon({ sha256: sha256Hex(hexHash) });
```

Setup guide, threat model, and full API reference:
**[`package/README.md`](package/README.md)**

The publishable npm package lives in the [`package/`](package/)
directory. Source code, tests, and full documentation are there.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0 OR MIT — see [LICENSE-APACHE.txt](LICENSE-APACHE.txt)
and [LICENSE-MIT.txt](LICENSE-MIT.txt).
