# Readability rules — naming and comments

Applies to source, docs, and commit messages. Target audience is a developer
familiar with the codebase.

## Core qualities

- **Clear** — reader understands on first read.
- **Efficient** — no filler, no padding.
- **Honest** — unknowns are marked, not hidden.
- **Traceable** — claims have sources.

## Naming

A good name removes the need for a comment. If a reader needs the body or a
comment to know what `foo` is, rename `foo`.

- Names describe the **concept**, not the implementation. Avoid `*Impl`,
  `*Raw`, `*Internal` on public surfaces.
- Names do not leak dependency shapes (`SigstoreBundleV2Envelope` as a public
  return type is a leak if the caller only needs "verified attestation").
- Booleans read as predicates (`isVerified`, `hasSigner`), not `verified`
  (which could be a noun) or `verifyFlag`.
- Async functions read as verbs (`fetchBundle`, not `bundle`).

## Comments

Default: write none. Only add one when the **why** is non-obvious.

Keep:

- hidden constraints ("Fulcio emits the `https://` form — do not normalize");
- subtle invariants;
- workarounds for specific bugs (with a link if external);
- behavior that would surprise a reader.

Delete:

- restatements of code, types, or well-known APIs;
- task/PR references ("added for X flow", "see issue #123") — they rot and
  belong in the commit message;
- multi-paragraph essays on exported symbols — one line plus a short example
  is enough;
- hedging prose ("might", "could potentially", "generally") that obscures
  meaning;
- `// removed` or `// deprecated` tombstones in place of removed code.

## Honest unknowns

Use `TODO:` with a concrete follow-up, not vague prose. Not "several" — "3"
or `[count unknown]`. Not "significant improvement" — "2× faster" or
`[benchmark TBD]`.

## Docstrings on the public API

Every exported symbol gets a one-line summary. Add a short example only when
it clarifies usage. Avoid multi-paragraph docstrings; link out if deeper
background is needed.

## Source

Adapted from the readability-rewrite skill used across Piven.TECH projects.
