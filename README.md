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

[![Open in GitHub Codespaces][codespace-badge]][codespace-action]

[codespace-badge]: https://github.com/codespaces/badge.svg
[codespace-action]: https://codespaces.new/vadimpiven/node-addon-slsa?quickstart=1

# node-addon-slsa

You `npm install` a package with a prebuilt `.node` binary. The package
is signed — but how do you know the binary was built from the same
source? You don't, unless both artifacts are verified against the same
CI run.

`node-addon-slsa` cross-checks [sigstore] npm provenance with the
[Rekor transparency log][rekor] to confirm the package and its
binary were produced by the _same_ GitHub Actions workflow run.
If they were not, installation aborts with a `SECURITY` error.

[sigstore]: https://www.sigstore.dev/
[rekor]: https://docs.sigstore.dev/logging/overview/

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
import { verifyPackage } from "node-addon-slsa";

const provenance = await verifyPackage({
  packageName: "my-native-addon",
  repo: "owner/repo",
});

await provenance.verifyAddonFromFile("/path/to/addon.node.gz");
```

Setup guide, threat model, and full API reference (including
`requireAddon`, options, error handling):
**[`packages/node-addon-slsa/README.md`](packages/node-addon-slsa/README.md)**

The published npm package lives in
[`packages/node-addon-slsa/`](packages/node-addon-slsa/); workspace-internal
primitives live in [`packages/internal/`](packages/internal/) as
`@node-addon-slsa/internal`. See [`packages/README.md`](packages/README.md)
for the layout.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0 OR MIT — see [LICENSE-APACHE.txt](LICENSE-APACHE.txt)
and [LICENSE-MIT.txt](LICENSE-MIT.txt).
