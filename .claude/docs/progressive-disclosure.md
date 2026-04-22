# API Design: Progressive Disclosure

This document captures the design philosophy for the **user-facing** surface of
node-addon-slsa — the CLI commands and the programmatic API exported from
`packages/node-addon-slsa/src/index.ts`.

## The principle

The user of this tool is a package author or CI pipeline wiring up supply-chain
verification. They are not experts in sigstore, Rekor, Fulcio, or the GitHub
Attestations API — those are implementation details. The API optimizes for
*their* time, not ours.

**One entry point per concept, sensible defaults, optional parameters that grow
the call site only when the use case demands it.** (Tradition of pandas,
scikit-learn, Keras, SwiftUI, Docker.)

Contrast with the orthogonal tradition (Unix pipes, Go stdlib): many small
primitives composed by the caller. That tradition is correct for *platform
internals* but wrong for a block-facing SDK.

## Rules for the user-facing surface

1. **One function with options, not N functions for N use cases.**
   `verify(pkg, options?)`, not `verifyBasic` / `verifyWithPolicy` /
   `verifyOffline`. New use cases become new options on the existing entry
   point.

2. **Sensible defaults make the common case trivial.**
   Minimal-argument calls must produce reasonable behavior. The pit of success:
   the least-effort path leads to correct results. Defaults are a design
   decision — pick one, don't hide behind required parameters.

3. **Every reasonably-configurable knob is reachable.**
   Registry URL, attestation endpoint, timeout, cache dir, allowed signer
   identities, OIDC issuer, offline mode, verbosity — if a real user could
   plausibly want it, expose it as an option (with a default). Conversely, if
   an "option" only exists because we could not decide a default, decide.

4. **Types represent whole concepts.**
   If callers always need fields A, B, C together, return one type with all
   three. Do not split into separate shapes that the caller must zip back
   together.

5. **Inspection and consistency.**
   Names and shapes are consistent across the surface. Similar operations read
   similarly. Result types are inspectable (no opaque handles the caller must
   pass to another function to make sense of).

## Rules for internals

Internal modules (loader, verification primitives, schemas) can be orthogonal —
many small primitives, explicit composition. The audience is us. Apply the
progressive-disclosure rule at the boundary, not below it.

## Litmus test

A user can verify a package with a single call using defaults, and reach
advanced behavior by adding options — without reading the source.

If the user has to compose multiple functions in a specific order, or read the
source to understand the return type, the API is wrong.

## When to push back on a proposed change

Push back if the change to the user-facing surface:

- splits one concept into multiple functions the caller must discover and
  compose;
- removes a default that made the common case trivial;
- forces the caller to understand internals to make a correct call;
- adds a concept the caller must learn for the common case.

Accept if the change:

- adds an optional parameter for an advanced case;
- reduces the number of concepts a caller must learn;
- replaces several near-duplicate entry points with one that carries options.

## Source

Adapted from the platform-wide progressive-disclosure philosophy (Chollet,
Buitinck et al., Wickham, Fowler) and scoped to this project.
