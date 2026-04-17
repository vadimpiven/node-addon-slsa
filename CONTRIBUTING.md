# Contributing to node-addon-slsa

## Quick Start

The only prerequisite is
[mise](https://mise.jdx.dev/getting-started.html).
It manages Node.js, pnpm, and all other tooling automatically.

```bash
git clone https://github.com/vadimpiven/node-addon-slsa.git
cd node-addon-slsa
mise trust       # approve the mise.toml config
mise install     # install Node.js and CLI tools defined in mise.toml
mise run test    # auto-fix, build, type-check, run unit tests
```

## Coding Standards

- **License Headers**: Start every new source file with:
  `// SPDX-License-Identifier: Apache-2.0 OR MIT`
- **Imports**: Use the `node:` prefix for Node.js built-in modules
  (`import { readFile } from "node:fs/promises"`).
- **Dependencies**: Pin exact versions in `pnpm-workspace.yaml`
  (no `^` or `~`) and reference them as `catalog:` in `package.json`.
- **Formatting**: Run `mise run fix` to auto-format all files.

## Submitting Changes

1. For new features or architectural changes, open an issue first.
2. Fork the repository and create a branch from `main`.
3. Run the full suite before submitting:

   ```bash
   mise run --force test
   ```

   `--force` bypasses mise task caching to ensure a clean run.

4. Open a pull request against `main`. Describe what changed and
   why, and link to the related issue.

## Reporting Issues

<https://github.com/vadimpiven/node-addon-slsa/issues>

Include reproduction steps, Node.js version (`node -v`), and OS.

## License

Contributions are licensed under Apache-2.0 OR MIT
([Apache-2.0](LICENSE-APACHE.txt), [MIT](LICENSE-MIT.txt)).
