# `@node-addon-slsa/internal`

Workspace-internal primitives for [`node-addon-slsa`](../node-addon-slsa) and
its bundled GitHub Actions
([`attest-addons`](../../.github/actions/attest-addons),
[`verify-addons`](../../.github/actions/verify-addons)). Private, unpublished,
and consumed through the pnpm workspace.

## Stability contract

**Not semver.** Shapes can change in any commit. If you import from this
package, pin your consumer to an exact commit of the monorepo and read the
diff before upgrading. There is no migration guide.

If you need a stable surface, use [`node-addon-slsa`](../node-addon-slsa) —
that package's `src/index.ts` is the curated re-export and is covered by the
public semver contract.

## What's here

Everything under [`src/`](./src) is exported from [`src/index.ts`](./src/index.ts).
The grouping below mirrors the barrel:

- **Verification** — [`src/verify/verify.ts`](./src/verify/verify.ts) for
  `verifyAttestation`, `loadTrustMaterial`, `verifyPackage`, `verifyPackageAt`.
  [`bundle.ts`](./src/verify/bundle.ts) fetches and cryptographically
  verifies the sidecar sigstore bundle; [`certificates.ts`](./src/verify/certificates.ts)
  pulls OIDs out of Fulcio certs; [`config.ts`](./src/verify/config.ts)
  resolves caller options against defaults from
  [`constants.ts`](./src/verify/constants.ts).
- **Schemas** — [`src/verify/schemas.ts`](./src/verify/schemas.ts)
  is the Zod source of truth for the published SLSA manifest (the pinned
  `$schema` URL lives in the same file). JSON Schemas are regenerated
  from here by
  [`packages/node-addon-slsa/scripts/generate-schemas.ts`](../node-addon-slsa/scripts/generate-schemas.ts).
- **Branded types** — [`src/types.ts`](./src/types.ts) has the runtime
  validators (`githubRepo`, `sha256Hex`, `semVerString`, etc.) that mint
  branded strings from plain input.
- **HTTP** — [`src/http.ts`](./src/http.ts) wraps undici with retry +
  streaming hash semantics used by both the CLI and the actions.
- **Addon fetch + hash** — [`src/util/addon-fetch.ts`](./src/util/addon-fetch.ts)
  is the single code path for "download a `.node.gz`, enforce the size cap,
  return its sha256" shared across attest/verify pipelines.
- **Filesystem, logging, errors** —
  [`src/util/`](./src/util) has `tempDir`, `assertWithinDir`,
  `createHashPassthrough`, `ProvenanceError`, the `errorMessage` formatter.

## If you're here to build your own publisher

Read these three files in order:

1. [`src/verify/verify.ts`](./src/verify/verify.ts) — the shape of
   `verifyAttestation` (hash + expected repo/commit/ref → sidecar bundle
   verification, which internally runs the TUF / Fulcio / Rekor-inclusion
   chain) and `verifyPackageAt` (manifest file → provenance handle).
2. [`.github/actions/verify-addons/index.ts`](../../.github/actions/verify-addons/index.ts)
   — the reference composition: fetch + hash + `verifyAttestation` + manifest
   emission. This is the template for a custom verifier.
3. [`.github/actions/attest-addons/index.ts`](../../.github/actions/attest-addons/index.ts)
   — minting side: fetch + hash + `@actions/attest.attestProvenance`.
   A custom publisher will mirror this.

The [`publish.yaml`](../../.github/workflows/publish.yaml) reusable
workflow shows how the two halves compose at the workflow level, including
`DEFAULT_ATTEST_SIGNER_PATTERN` — the Build Signer URI regex
`verifyAttestation` pins against. If you fork, this is the string that
must match your own workflow's ref.

## Development

- **`pnpm run test`** — vitest over `tests/` and in-source
  `import.meta.vitest` blocks. Coverage threshold 80% across all metrics.
- **`pnpm run build`** — vite library build into `dist/`, so ncc-bundled
  consumers (the actions) get a single pre-processed file without having
  to strip in-source test blocks themselves.

Tests for package-to-package integration (CLI, actions, public API) live
in [`packages/node-addon-slsa/tests/`](../node-addon-slsa/tests).
