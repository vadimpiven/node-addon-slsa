# node-addon-slsa

## Project

TypeScript CLI tool for supply-chain provenance verification
of npm packages with prebuilt native addons. Uses sigstore
and GitHub Attestations API.

## Commands

- `mise run check` — lint, format, security checks
- `mise run fix` — auto-fix lint and format issues
- `mise run test` — build + test
- `mise run build` — build package

## Code Conventions

- License header: `// SPDX-License-Identifier: Apache-2.0 OR MIT`
- `node:` prefix for Node.js built-in imports
- Markdown lines ≤ 100 characters (markdownlint MD013)
- Exact version pins in package.json (no `^`)
