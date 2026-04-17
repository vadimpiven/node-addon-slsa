# Plan: provenance for closed-source repositories

## Goal

Extend `node-addon-slsa` so consumers of npm packages published from **internal** or
**private** GitHub repositories get the same addon-binary provenance guarantee
`--provenance` offers for public repos. Do this without requiring the publisher to
host attestation bundles manually.

## Motivation

`npm publish --provenance` rejects bundles whose Sigstore cert carries
`Source Repository Visibility At Signing = internal|private` (npm registry policy,
enforced server-side; see `npm/provenance` docs). Packages built in internal repos
therefore cannot use the standard provenance path, even when the package itself is
public on npm. Publisher's reported error:

```text
npm error 422 Unprocessable Entity — Error verifying sigstore provenance bundle:
Unsupported GitHub Actions source repository visibility: "internal".
Only public source repositories are supported when publishing with provenance.
```

## Starting points in this repo

Files and facts you need to implement this plan — all already in the tree:

- `attest-public/action.yaml`, `attest-public/index.ts`, `attest-public/package.json` —
  template for the new action. Same packaging: `node24` runtime, `@vercel/ncc` bundle
  to `dist/index.js`, `build` script:
  `ncc build index.ts --license licenses.txt --external supports-color`.
  Dev deps via `catalog:` pnpm workspace.
- `package/src/verify/constants.ts` — Fulcio OIDs already defined:
  `OID_ISSUER_V1 = 1.3.6.1.4.1.57264.1.1`,
  `OID_ISSUER_V2 = 1.3.6.1.4.1.57264.1.8`,
  `OID_SOURCE_REPO_URI = 1.3.6.1.4.1.57264.1.12`,
  `OID_RUN_INVOCATION_URI = 1.3.6.1.4.1.57264.1.21`.
  Fulcio OID registry: `https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md`.
- `package/src/verify/certificates.ts` — `getExtensionValue(cert, oid)`,
  `verifyCertificateOIDs(cert, repo)`, `extractCertFromBundle(bundle)`.
- `package/src/verify/verify.ts` — existing `verifyPackageProvenance`,
  `verifyAddonProvenance`, `PackageProvenance` type. Mirror its shape.
- `package/src/verify/rekor.ts` — `verifyRekorAttestations({ sha256, runInvocationURI,
  repo, config, trustMaterial })`. Reuse unchanged.
- `package/src/verify/npm.ts` — `fetchNpmAttestations`. Do **not** touch; manifest
  path bypasses it.
- `package/src/types.ts` — branded types + validators: `sha256Hex`, `semVerString`,
  `githubRepo`, `runInvocationURI`. Use these; do not invent new validators.
- `package/src/verify/schemas.ts` — zod schemas in the same file module pattern
  (existing: `NpmAttestationsSchema`). Add `SlsaManifestSchema` here.
- Tests: inline in each module under `if (import.meta.vitest)` blocks using vitest.
  See `package/src/verify/certificates.ts` bottom for the pattern.
- `package/src/cli.ts`, `package/src/commands.ts` — CLI entry for `slsa wget`.

OIDs to **add** to `constants.ts`:

```typescript
/** Fulcio OID for the source repository commit digest. */
export const OID_SOURCE_REPO_DIGEST = "1.3.6.1.4.1.57264.1.13";
/** Fulcio OID for the source repository ref (e.g. "refs/tags/v1.2.3"). */
export const OID_SOURCE_REPO_REF = "1.3.6.1.4.1.57264.1.14";
/**
 * Fulcio OID for source repository visibility at signing
 * ("public" | "private" | "internal"). Intentionally NOT asserted
 * by the manifest verifier path; npm registry enforces it only for
 * --provenance uploads.
 */
export const OID_SOURCE_REPO_VISIBILITY = "1.3.6.1.4.1.57264.1.22";
```

## Trust boundary note (important, self-contained)

npm client verifies `dist.integrity` (sha512) against the tarball at install time
**before** any `postinstall` script runs. Anything read from inside the installed
package directory is therefore covered by npm's signature chain (`dist.signatures`
checked against npm's TUF-distributed public keys). The manifest verifier does
**not** need to re-verify npm signatures — reading `slsa-manifest.json` from the
installed package root is equivalent to trusting `dist.integrity`. This is the
pivot that makes the whole design work for closed repos.

## Design overview

Binaries are already attested via `attest-public` (Rekor entries, public and tokenless
regardless of repo visibility). The missing link is binding the **npm package** to the
**workflow run** that produced the binaries. We close that link with a
signed-by-npm manifest embedded in the package.

Flow on publish:

1. Matrix jobs build per-platform `.node(.gz)` files and run `attest-public` on each.
   Already in place. No change.
2. A new action `write-manifest` runs in the publish job (after matrix artifacts are
   downloaded). It hashes each addon, reads run metadata from the ambient
   `${{ github.* }}` context, and writes a sidecar `{addon.path}.manifest.json` next
   to each addon. Every sidecar carries the same manifest content.
3. Publish job copies one manifest file into the npm package (covered by npm's
   `dist.integrity` signature), then `npm publish` **without** `--provenance`.
4. S3 upload job uploads each `.node(.gz)` plus its sidecar manifest.

Flow on install:

1. Installer reads manifest from the npm package (already covered by npm signature
   chain via `dist.integrity` + `dist.signatures`).
2. For the installer's platform+arch, downloads the addon from `url`, verifies its
   sha256 against the manifest entry.
3. Looks up the sha256 in Rekor (existing `verifyRekorAttestations`). Verifies cert
   issuer, source repo OID, ref pattern, and that the cert's Run Invocation URI +
   source commit match the manifest's.

## Manifest schema

Written as `{addon.path}.manifest.json`. Same content in every sidecar.

```jsonc
{
  "schemaVersion": 1,
  "runInvocationURI": "https://github.com/owner/repo/actions/runs/123/attempts/1",
  "sourceRepo": "owner/repo",
  "sourceCommit": "<full-sha>",
  "sourceRef": "refs/tags/v1.2.3",
  "addons": {
    "linux-x64":   { "url": "https://.../addon-linux-x64.node.gz",   "sha256": "..." },
    "linux-arm64": { "url": "https://.../addon-linux-arm64.node.gz", "sha256": "..." },
    "darwin-x64":  { "url": "https://.../addon-darwin-x64.node.gz",  "sha256": "..." },
    "darwin-arm64":{ "url": "https://.../addon-darwin-arm64.node.gz","sha256": "..." },
    "win32-x64":   { "url": "https://.../addon-win32-x64.node.gz",   "sha256": "..." }
  }
}
```

Key is `${platform}-${arch}` using Node's `process.platform` / `process.arch` values
(`linux`, `darwin`, `win32`; `x64`, `arm64`). The installer reads
`manifest.addons[${process.platform}-${process.arch}]` directly.

## New action: `write-manifest`

Lives at `write-manifest/` alongside existing `attest-public/`. Same packaging pattern
(`action.yaml`, `index.ts`, `dist/index.js`, `node24` runtime).

### Inputs

```yaml
inputs:
  addons:
    description: >
      JSON array of addon entries. Each entry has path (local file to hash),
      url (where installers fetch it from), platform (node platform), arch (node arch).
    required: true
```

Example caller:

```yaml
- uses: vadimpiven/node-addon-slsa/write-manifest@v0.8.0
  with:
    addons: |
      [
        {"path": "./artifacts/linux-x64/pframes_rs_node-v1.2.3-napi-v8-linux-x64.node.gz",
         "url": "https://cdn.../v1.2.3/pframes_rs_node-v1.2.3-napi-v8-linux-x64.node.gz",
         "platform": "linux", "arch": "x64"},
        ...
      ]
```

### Behaviour

```typescript
// Pseudocode.
for (const a of addons) {
  a.sha256 = sha256OfFile(a.path);
}

const manifest = {
  schemaVersion: 1,
  runInvocationURI: `https://github.com/${process.env.GITHUB_REPOSITORY}`
    + `/actions/runs/${process.env.GITHUB_RUN_ID}`
    + `/attempts/${process.env.GITHUB_RUN_ATTEMPT}`,
  sourceRepo:   process.env.GITHUB_REPOSITORY,        // "owner/repo"
  sourceCommit: process.env.GITHUB_SHA,               // resolved commit
  sourceRef:    process.env.GITHUB_REF,               // e.g. "refs/tags/v1.2.3"
  addons: Object.fromEntries(addons.map(a => [
    `${a.platform}-${a.arch}`,
    { url: a.url, sha256: a.sha256 },
  ])),
};

for (const a of addons) {
  await writeFile(`${a.path}.manifest.json`, JSON.stringify(manifest, null, 2));
}
```

### Outputs

```yaml
outputs:
  manifest-paths:
    description: JSON array of written manifest file paths.
```

### Does not

- Talk to Sigstore, Rekor, or GitHub Attestations API. No `id-token` permission needed.
- Upload the manifest anywhere. Caller uploads to S3 / copies into npm tarball.

### Environment variables read by the action

All set by GitHub Actions; documented at
`https://docs.github.com/en/actions/learn-github-actions/variables`.

- `GITHUB_REPOSITORY` — `owner/repo`.
- `GITHUB_RUN_ID` — numeric run ID.
- `GITHUB_RUN_ATTEMPT` — numeric attempt; always set by GitHub.
- `GITHUB_SHA` — full commit SHA the workflow is running against.
- `GITHUB_REF` — full ref (`refs/tags/v1.2.3`, `refs/heads/main`, etc.).

Fail fast if any is missing or empty (action is useless off-CI).

## Publish-side wiring (reference only, NOT in this repo)

```yaml
# in node-publish job, after download-artifact of all matrix outputs:
- uses: vadimpiven/node-addon-slsa/write-manifest@vX.Y.Z
  with:
    addons: ${{ steps.collect-addons.outputs.entries }}

- name: Embed manifest in npm package
  run: cp ./artifacts/linux-x64/*.manifest.json packages/node/slsa-manifest.json

- name: Publish
  run: pnpm publish --no-git-checks --access public   # no --provenance
```

S3 upload step (existing) adds a pattern to also push `*.manifest.json` sidecars.

This snippet shows how a consumer project (`pframes-rs` was the reference) wires
the action. **You do not need access to that repo to implement the action or the
verifier** — the example is illustrative only.

## Verifier changes in `package/src/verify/`

### `schemas.ts`

Add `SlsaManifestSchema` (zod). Validate:

- `schemaVersion === 1`
- `runInvocationURI` parses via `runInvocationURI()` type guard
- `sourceRepo` matches `owner/repo`
- `sourceCommit` is 40-hex
- `sourceRef` starts with `refs/tags/` or `refs/heads/`
- `addons` values have sha256 hex (64 chars) and https url

### `verify.ts`

Add a new entry point that does not rely on npm's provenance endpoint:

```typescript
export async function verifyPackageManifest(options: {
  manifestPath: string;              // path inside the installed package
  repo: GitHubRepo;                  // caller-asserted expected repo
  refPattern?: RegExp;               // default: /^refs\/tags\/v/
} & VerifyOptions): Promise<PackageProvenance> {
  // 1. Load + zod-parse manifest.
  // 2. Assert manifest.sourceRepo equals options.repo (case-insensitive).
  // 3. Assert manifest.sourceRef matches options.refPattern.
  // 4. Return PackageProvenance whose verifyAddon():
  //    a. Looks up sha256 in Rekor (reuse verifyRekorAttestations).
  //    b. Cross-checks each Rekor cert's:
  //       - issuer (OID_ISSUER_*)               == GITHUB_ACTIONS_ISSUER
  //       - source repo URI (OID_SOURCE_REPO_URI) == manifest.sourceRepo
  //       - source commit (OID_SOURCE_REPO_DIGEST) == manifest.sourceCommit
  //       - source ref    (OID_SOURCE_REPO_REF)    == manifest.sourceRef
  //       - run invocation URI (OID_RUN_INVOCATION_URI) == manifest.runInvocationURI
  //    c. Deliberately does NOT check Source Repository Visibility OID.
}
```

Notes:

- Does not call `fetchNpmAttestations`. npm registry has no bundle for these packages.
- Does not call `verifier.verify(bundle)` on an npm-provenance bundle (there is none).
  Sigstore cert verification happens inside `verifyRekorAttestations` for each Rekor
  entry — same trust anchors (Fulcio CAs, Rekor key via TUF).

### `certificates.ts`

Extend `verifyCertificateOIDs(cert, repo, opts?)` to optionally assert:

- `sourceCommit`: exact match against `OID_SOURCE_REPO_DIGEST`
- `sourceRef`: regex match against `OID_SOURCE_REPO_REF`
- `runInvocationURI`: exact match against `OID_RUN_INVOCATION_URI`

Passed through from `verifyPackageManifest`. Existing `verifyPackageProvenance`
callers unaffected (opts default to current behaviour).

### `constants.ts`

Add OIDs listed in the "Starting points" section above.

### CLI (`cli.ts`, `commands.ts`)

Today `slsa wget` uses `verifyPackageProvenance`. Add auto-detection:

```typescript
// Pseudocode.
if (existsSync(`${pkgRoot}/slsa-manifest.json`)) {
  provenance = await verifyPackageManifest({ manifestPath, repo, ... });
} else {
  provenance = await verifyPackageProvenance({ packageName, version, repo, ... });
}
// downstream: provenance.verifyAddon({ sha256 }) — identical API.
```

Consumers with private repos ship `slsa-manifest.json` in the package and set no
other config. Consumers with public repos get unchanged behaviour.

## Trust model

Threat analysis, public-repo `--provenance` vs. this design:

- **Swapped `.node` on CDN/S3.** Public: Rekor miss, fail. Manifest: Rekor miss, fail.
- **Swapped npm tarball contents.** Public: `dist.integrity` fail. Manifest: same.
- **Malicious publish, new version, same binaries.** Public: allowed (signed).
  Manifest: allowed (signed).
- **Malicious publish, binary from unrelated legit run.** Public: rejected (npm binds
  tarball ↔ bundle). Manifest: rejected (Rekor cert's `sourceRepo` and
  `runInvocationURI` must match the manifest).
- **Malicious publish, fake run URI in manifest.** Public: N/A. Manifest: rejected
  (no Rekor entry matches that URI + hash combination).
- **Malicious publish, `workflow_dispatch` on feature branch.** Public: rejected
  (cert `ref`). Manifest: rejected (manifest `sourceRef` + installer `refPattern`).
- **Compromised publish runner forges manifest.** Public: cannot forge (npm binds).
  Manifest: cannot launder binaries (Rekor cross-check). Can only lie about version
  label.
- **Public Rekor entries leak from internal repo.** Public: N/A. Manifest: accepted
  leak; cert reveals repo name, commit SHA, workflow path. Documented trade-off.

Residual difference vs. `--provenance`: npm does not itself attest the package ↔ bundle
binding. Substituted by: `dist.integrity` covers the manifest + the installer's
Rekor cross-check on every binary. No weaker guarantee on binary integrity; slightly
weaker guarantee on **version labelling** (malicious publisher can republish the
same binary under a different version). Not exploitable for code execution.

## Privacy note

`attest-public` already logs to public Rekor today. The Sigstore cert reveals:
`owner/repo`, commit SHA, workflow path, ref. Publishers of internal repos accept
this trade-off by using `attest-public` at all. The manifest adds no new leakage —
it only re-states what is already in the public Rekor entries.

## Open decisions

1. **Sidecar placement for npm tarball embed.** Action writes one sidecar per addon,
   all identical. Caller picks one to copy into `packages/<pkg>/slsa-manifest.json`
   before `npm publish`. Acceptable? Alternative: action takes a second optional
   input `embed-path` and writes the manifest directly there.
2. **Manifest filename inside tarball.** Proposed: `slsa-manifest.json` at package
   root. Alternative: under `.attestations/` or nested under `dist/`.
3. **Backward compatibility.** Auto-detect in CLI (if file exists → manifest path;
   else → npm provenance path). Acceptable, or require explicit opt-in flag?
4. **Refpattern default.** Proposed: `/^refs\/tags\/v/`. Caller can override. Some
   projects tag without `v` prefix.
5. **`visibility` OID handling in `verifyPackageProvenance` path.** Keep strict
   public-only assertion there (existing behaviour), since that path is for packages
   that WOULD have gone through npm provenance. Only the manifest path relaxes it.

## Files created or modified

Exhaustive list. Nothing else needs to change.

New:

- `write-manifest/action.yaml`
- `write-manifest/index.ts`
- `write-manifest/package.json`          (mirror `attest-public/package.json`; deps:
  `@actions/core`, `@types/node`, `@vercel/ncc`, `typescript` — all `catalog:`)
- `write-manifest/tsconfig.json`         (copy from `attest-public/tsconfig.json`)
- `write-manifest/dist/index.js`         (generated by `ncc`, committed per
  `attest-public/` precedent)

Modified:

- `pnpm-workspace.yaml`                  (register `write-manifest` package)
- `package/src/verify/constants.ts`      (add 3 OIDs)
- `package/src/verify/schemas.ts`        (add `SlsaManifestSchema`)
- `package/src/verify/certificates.ts`   (extend `verifyCertificateOIDs` options)
- `package/src/verify/verify.ts`         (add `verifyPackageManifest`, `loadManifest`)
- `package/src/verify/index.ts`          (export new symbols)
- `package/src/index.ts`                 (re-export new symbols at top level)
- `package/src/commands.ts`              (auto-detect manifest for `slsa wget`)
- `README.md`, `package/README.md`       (document internal-repo flow)

## Testing strategy

All tests inline in the source module under `if (import.meta.vitest)` (existing
pattern; vitest picks them up via config).

For `SlsaManifestSchema`:

- Valid manifest parses, branded types returned.
- `schemaVersion !== 1` rejected.
- Missing required fields rejected (each field one test).
- Non-hex sha256 rejected, non-https url rejected, malformed
  `runInvocationURI` rejected.

For `verifyCertificateOIDs` new option fields: mirror existing tests — one
accept case, one reject case per new option (`sourceCommit`, `sourceRef`,
`runInvocationURI`). Mock `X509Certificate` like `certificates.ts` already does.

For `verifyPackageManifest`:

- Happy path: write a temp manifest file, mock `verifyRekorAttestations` to
  return a fixed Rekor result, assert the result flows through.
- `manifest.sourceRepo` mismatch → throws `ProvenanceError`.
- `manifest.sourceRef` fails `refPattern` → throws.
- Rekor cert's `sourceCommit` disagrees with manifest → throws.
- Rekor cert's `runInvocationURI` disagrees with manifest → throws.

For `write-manifest/index.ts`: unit test against a real temp dir with small
fixture files. Mock env vars (`GITHUB_REPOSITORY` etc.) via `vi.stubEnv`.
Missing env var → action fails with actionable message.

No new network fixtures needed — Rekor lookup tests in `rekor.ts` already
cover the network surface.

## Implementation steps

1. Add `write-manifest/` action (action.yaml, index.ts, dist/, package.json). Reuse
   build tooling from `attest-public/`.
2. Add `SlsaManifestSchema` to `verify/schemas.ts`.
3. Add missing OIDs to `verify/constants.ts`.
4. Extend `verifyCertificateOIDs` in `verify/certificates.ts` with optional
   `sourceCommit`, `sourceRef`, `runInvocationURI`, `visibility`.
5. Add `verifyPackageManifest` + `loadManifest` helpers to `verify/verify.ts`.
   Export from `verify/index.ts` and top-level `index.ts`.
6. Wire CLI auto-detection in `commands.ts`.
7. Tests in `package/tests/`: manifest parsing (valid + malformed), cert OID
   cross-check (each field mismatch rejected), end-to-end with a fixture manifest
   - recorded Rekor response.
8. Update `README.md` (root + package) with an "Internal repositories" section
   referencing the new flow.
9. Document the `write-manifest` action in `attest-public/`-style README or inline
   in root README.
10. Release as `v0.8.0` (minor; additive API, no breaking changes).

## Out of scope

- PyPI / maturin parallel (pypl-publish uses PyPI, different trust infrastructure).
- Non-GitHub CI providers. Manifest schema is GitHub-specific by design.
- Bundled attestation format (sigstore bundle inside the tarball). Explicitly
  rejected in favour of Rekor-lookup-by-hash for simplicity.
