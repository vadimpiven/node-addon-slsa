# Packages

This monorepo is split along the progressive-disclosure boundary: a thin
**block-facing** package aimed at addon authors and consumers, and an
orthogonal **platform-internal** package of primitives composed by the
GitHub Actions and fork tooling.

## [`node-addon-slsa`](./node-addon-slsa) — published CLI + runtime

User-facing surface: [`verifyPackage`](./node-addon-slsa/src/index.ts),
[`requireAddon`](./node-addon-slsa/src/loader.ts), the
[`slsa` CLI](./node-addon-slsa/bin/slsa.mjs),
[`ProvenanceError`](./node-addon-slsa/src/index.ts). Sensible defaults
make the common case trivial; optional parameters grow the call site only
when advanced use demands it.

Published to [npm](https://www.npmjs.com/package/node-addon-slsa).

## [`@node-addon-slsa/internal`](./internal) — workspace primitives (private)

Orthogonal primitives for composing custom provenance pipelines:
[`verifyAttestation`](./internal/src/verify/verify.ts),
[`loadTrustMaterial`](./internal/src/verify/verify.ts),
[`fetchAndHashAddon`](./internal/src/util/addon-fetch.ts),
[manifest schemas](./internal/src/verify/schemas.ts),
branded-type constructors, low-level HTTP and filesystem helpers.

Consumed by
[`attest-addons`](../.github/actions/attest-addons),
[`verify-addons`](../.github/actions/verify-addons),
and [`node-addon-slsa`](./node-addon-slsa) itself. Source-only,
never published — shapes can change between minor versions.
