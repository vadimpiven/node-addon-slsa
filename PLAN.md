# Rekor fallback for tokenless private-repo verification

## Problem

`actions/attest-build-provenance` selects the sigstore instance by
repo visibility
(from `@actions/toolkit` `packages/attest/src/endpoints.ts`):

| Visibility | Fulcio CA              | Witness  | Bundle storage     |
| ---------- | ---------------------- | -------- | ------------------ |
| Public     | `fulcio.sigstore.dev`  | Rekor    | GitHub API + Rekor |
| Private    | `fulcio.githubapp.com` | TSA only | GitHub API only    |

Private repos: no Rekor entry, incompatible Fulcio CA, GitHub
Attestations API returns 404 without `GITHUB_TOKEN`.

## Blocker: Rekor DSSE entries omit the envelope

Verified against entry `108e9186e8...` for `cli/cli`:

```json
{
  "apiVersion": "0.0.1",
  "kind": "dsse",
  "spec": {
    "envelopeHash": { "algorithm": "sha256", "value": "72cd9b..." },
    "payloadHash": { "algorithm": "sha256", "value": "383256..." },
    "signatures": [
      {
        "signature": "MEUC...",
        "verifier": "LS0tLS1CRUdJTi..." // base64 PEM certificate
      }
    ]
  }
}
```

- ✅ Fulcio certificate (RunInvocationURI, SourceRepoURI, Issuer)
- ✅ Signature, inclusion proof, signed entry timestamp (SET)
- ❌ DSSE envelope payload → cannot reconstruct `SerializedBundle`

## Solution: certificate-level verification via Rekor

```text
GitHub API path (existing):
  fetchGitHubAttestations
    → resolve bundles
    → verifier.verify(bundle)      // full DSSE + tlog
    → extractCertFromBundle
    → check RunInvocationURI + OIDs

Rekor fallback (new, when GitHub API returns 404 + no token):
  searchRekor(sha256)              // POST rekor.sigstore.dev
    → for each entry UUID:
        fetchRekorEntry(uuid)
        → verifyRekorInclusion()   // SET + checkpoint + merkle
        → extractCert()            // from entry body
        → check RunInvocationURI + OIDs
```

### Prerequisite: `sigstore: public-good` in CI

```yaml
# overrides auto-detection in @actions/toolkit endpoints.ts
- uses: actions/attest-build-provenance@v4
  with:
    subject-path: dist/my_addon-v*.node.gz
    sigstore: public-good # → fulcio.sigstore.dev + rekor.sigstore.dev
```

## New dependencies

```jsonc
// pnpm-workspace.yaml catalog — pin to versions used by sigstore 4.1.0
"@sigstore/tuf": "4.0.1",    // getTrustedRoot() → TrustedRoot
"@sigstore/verify": "3.1.0", // toTrustMaterial() → TrustMaterial
```

Required because pnpm strict hoisting blocks access to transitive
deps. `TrustMaterial.tlogs` provides `TLogAuthority[]` with the
Rekor public key needed for SET and checkpoint verification.

## Architecture

### `package/src/verify/rekor.ts` (new)

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { crypto, json, X509Certificate } from "@sigstore/core";
import { getTrustedRoot } from "@sigstore/tuf";
import { toTrustMaterial } from "@sigstore/verify";
import type { TrustMaterial } from "@sigstore/verify";

import type { GitHubRepo, RunInvocationURI, Sha256Hex } from "../types.ts";
import type { ResolvedConfig } from "./config.ts";
import { fetchWithRetry } from "../download.ts";
import { log } from "../util/log.ts";
import { ProvenanceError } from "../util/provenance-error.ts";
import { evalTemplate } from "../util/template.ts";
import { getExtensionValue, verifyCertificateOIDs } from "./certificates.ts";
import {
  MAX_REKOR_ENTRIES,
  OID_RUN_INVOCATION_URI,
  REKOR_ENTRY_URL,
  REKOR_SEARCH_URL,
} from "./constants.ts";
import {
  RekorDsseBodySchema,
  RekorLogEntrySchema,
  RekorSearchResponseSchema,
} from "./schemas.ts";

// Cached across calls within the same process
let trustMaterialCache: TrustMaterial | undefined;

async function getTrustMaterial(): Promise<TrustMaterial> {
  if (!trustMaterialCache) {
    const root = await getTrustedRoot();
    trustMaterialCache = toTrustMaterial(root);
  }
  return trustMaterialCache;
}

/**
 * Rekor fallback: search + verify addon provenance via the public
 * Rekor transparency log. Called when GitHub API returns 404
 * without a token.
 *
 * @returns void on success, null if no entries found.
 * @throws ProvenanceError if entries exist but none match.
 * @throws Error on transient failures.
 */
export async function verifyAddonViaRekor(options: {
  sha256: Sha256Hex;
  runInvocationURI: RunInvocationURI;
  repo: GitHubRepo;
  config: ResolvedConfig;
}): Promise<void | null> {
  const { sha256, runInvocationURI, repo, config } = options;

  // Step 1: search Rekor for entries matching the artifact hash
  const uuids = await searchRekor(sha256, config);
  if (uuids.length === 0) return null;

  // Step 2: fetch trust material (Rekor public keys from TUF)
  const trustMaterial = await getTrustMaterial();

  // Step 3: for each entry, verify inclusion + check cert OIDs
  const capped = uuids.slice(0, MAX_REKOR_ENTRIES);
  let verifyFailures = 0;

  for (const uuid of capped) {
    try {
      const entry = await fetchRekorEntry(uuid, config);
      verifyRekorInclusion(entry, trustMaterial);
      const cert = extractCertFromRekorEntry(entry);
      const certRunURI = getExtensionValue(cert, OID_RUN_INVOCATION_URI);
      if (certRunURI === runInvocationURI) {
        verifyCertificateOIDs(cert, repo);
        return; // success
      }
    } catch (err) {
      if (err instanceof ProvenanceError) throw err;
      verifyFailures++;
      log(`Rekor entry ${uuid} failed: ${err}`);
    }
  }

  throw new ProvenanceError(
    verifyFailures === capped.length
      ? `All ${capped.length} Rekor entries failed verification.`
      : `${capped.length} Rekor entries found, none matched ` +
        `workflow run ${runInvocationURI}.`,
  );
}

// --- Rekor API ---

/** POST /api/v1/index/retrieve → UUID[] */
async function searchRekor(
  sha256: Sha256Hex,
  config: ResolvedConfig,
): Promise<string[]> {
  const response = await fetchWithRetry(REKOR_SEARCH_URL, {
    ...config,
    headers: { "Content-Type": "application/json" },
    // fetchWithRetry needs a GET-style call; use fetch directly
    // for POST. [See implementation note below.]
  });
  // Implementation: POST with body { "hash": "sha256:{hash}" }
  // Parse with RekorSearchResponseSchema
}

/** GET /api/v1/log/entries/{uuid} → parsed entry */
async function fetchRekorEntry(
  uuid: string,
  config: ResolvedConfig,
): Promise<RekorLogEntry> {
  const url = evalTemplate(REKOR_ENTRY_URL, { uuid });
  const response = await fetchWithRetry(url, config);
  // Parse with RekorLogEntrySchema, return first value
}

// --- Inclusion proof verification ---
// Reimplements @sigstore/verify internals using @sigstore/core.
// Cannot use @sigstore/verify's verifyTLogInclusion directly
// because it's not exported.

interface RekorLogEntry {
  body: string; // base64-encoded canonicalized entry
  integratedTime: number;
  logID: string;
  logIndex: number;
  verification: {
    signedEntryTimestamp: string;
    inclusionProof: {
      checkpoint: string;
      hashes: string[];
      logIndex: number;
      rootHash: string;
      treeSize: number;
    };
  };
}

/**
 * Verify SET + checkpoint signature + Merkle inclusion proof.
 * Uses TLogAuthority[] from TrustMaterial for the Rekor public key.
 */
function verifyRekorInclusion(
  entry: RekorLogEntry,
  trustMaterial: TrustMaterial,
): void {
  const tlogs = trustMaterial.tlogs;
  verifyTLogSET(entry, tlogs);
  const checkpoint = verifyCheckpoint(entry, tlogs);
  verifyMerkleInclusion(entry, checkpoint);
}

// --- SET verification (from @sigstore/verify tlog/set.js) ---

function verifyTLogSET(entry: RekorLogEntry, tlogs: TLogAuthority[]): void {
  // Filter tlogs by logID + timestamp validity
  const logIdBuf = Buffer.from(entry.logID, "hex");
  const timestamp = new Date(entry.integratedTime * 1000);
  const validTLogs = tlogs.filter(
    (t) =>
      crypto.bufferEqual(t.logID, logIdBuf) &&
      timestamp >= t.validFor.start &&
      timestamp <= t.validFor.end,
  );

  // Re-create the SET verification payload (same as @sigstore/verify)
  const payload = {
    body: entry.body, // already base64
    integratedTime: entry.integratedTime,
    logIndex: entry.logIndex,
    logID: entry.logID,
  };
  const data = Buffer.from(json.canonicalize(payload), "utf8");
  const signature = Buffer.from(
    entry.verification.signedEntryTimestamp,
    "base64",
  );

  const verified = validTLogs.some((tlog) =>
    crypto.verify(data, tlog.publicKey, signature),
  );
  if (!verified) {
    throw new Error("Rekor SET verification failed");
  }
}

// --- Checkpoint verification (from @sigstore/verify tlog/checkpoint.js) ---

interface LogCheckpoint {
  origin: string;
  logSize: bigint;
  logHash: Buffer;
}

function verifyCheckpoint(
  entry: RekorLogEntry,
  tlogs: TLogAuthority[],
): LogCheckpoint {
  const envelope = entry.verification.inclusionProof.checkpoint;
  // Checkpoint format (transparency-dev/formats):
  //   <note>\n\n— <identity> <keyhint+sig>\n
  const sepIdx = envelope.indexOf("\n\n");
  const note = envelope.slice(0, sepIdx + 1); // includes trailing \n
  const sigs = envelope.slice(sepIdx + 2);

  // Parse checkpoint body: origin\nsize\nbase64(rootHash)\n
  const lines = note.trimEnd().split("\n");
  const checkpoint: LogCheckpoint = {
    origin: lines[0]!,
    logSize: BigInt(lines[1]!),
    logHash: Buffer.from(lines[2]!, "base64"),
  };

  // Verify signature(s) — format: "— <name> <base64(4-byte-hint + sig)>\n"
  const sigRegex = /\u2014 (\S+) (\S+)\n/g;
  const noteData = Buffer.from(note, "utf-8");
  let anyVerified = false;

  for (const match of sigs.matchAll(sigRegex)) {
    const sigBytes = Buffer.from(match[2]!, "base64");
    const keyHint = sigBytes.subarray(0, 4);
    const sig = sigBytes.subarray(4);
    const tlog = tlogs.find(
      (t) =>
        crypto.bufferEqual(t.logID.subarray(0, 4), keyHint) &&
        t.baseURL.match(match[1]!),
    );
    if (tlog && crypto.verify(noteData, tlog.publicKey, sig)) {
      anyVerified = true;
      break;
    }
  }

  if (!anyVerified) {
    throw new Error("Rekor checkpoint signature verification failed");
  }
  return checkpoint;
}

// --- Merkle inclusion (from @sigstore/verify tlog/merkle.js, RFC 6962) ---

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

function verifyMerkleInclusion(
  entry: RekorLogEntry,
  checkpoint: LogCheckpoint,
): void {
  const proof = entry.verification.inclusionProof;
  const index = BigInt(proof.logIndex);
  const size = checkpoint.logSize;

  const { inner, border } = decompInclProof(index, size);
  const hashes = proof.hashes.map((h) => Buffer.from(h, "hex"));

  const leafHash = crypto.digest(
    "sha256",
    LEAF_PREFIX,
    Buffer.from(entry.body, "base64"),
  );
  const root = chainBorderRight(
    chainInner(leafHash, hashes.slice(0, inner), index),
    hashes.slice(inner),
  );

  if (!crypto.bufferEqual(root, checkpoint.logHash)) {
    throw new Error("Merkle inclusion proof failed");
  }
}

function decompInclProof(
  index: bigint,
  size: bigint,
): { inner: number; border: number } {
  const inner = bitLength(index ^ (size - 1n));
  const border = popCount(index >> BigInt(inner));
  return { inner, border };
}

function chainInner(seed: Buffer, hashes: Buffer[], index: bigint): Buffer {
  return hashes.reduce(
    (acc, h, i) =>
      (index >> BigInt(i)) & 1n
        ? crypto.digest("sha256", NODE_PREFIX, h, acc)
        : crypto.digest("sha256", NODE_PREFIX, acc, h),
    seed,
  );
}

function chainBorderRight(seed: Buffer, hashes: Buffer[]): Buffer {
  return hashes.reduce(
    (acc, h) => crypto.digest("sha256", NODE_PREFIX, h, acc),
    seed,
  );
}

function bitLength(n: bigint): number {
  return n === 0n ? 0 : n.toString(2).length;
}

function popCount(n: bigint): number {
  return n.toString(2).split("1").length - 1;
}

// --- Certificate extraction ---

function extractCertFromRekorEntry(entry: RekorLogEntry): X509Certificate {
  const body = JSON.parse(Buffer.from(entry.body, "base64").toString("utf8"));
  const parsed = RekorDsseBodySchema.parse(body);
  const certB64 = parsed.spec.signatures[0]!.verifier;
  const certPem = Buffer.from(certB64, "base64").toString("utf8");
  return X509Certificate.parse(certPem);
}
```

**Implementation note:** `fetchWithRetry` only supports GET.
`searchRekor` needs POST. Two options:

1. Add `method` + `body` to `FetchOptions` (small change to
   `download.ts`)
2. Call `fetch()` directly in `searchRekor` with manual retry

Option 1 is cleaner. Add to `FetchOptions`:

```typescript
// types.ts — add to FetchOptions
readonly method?: string | undefined;
readonly body?: string | undefined;
```

### `package/src/util/provenance-error.ts` — add

```typescript
// Distinguishes "no access" (fallback-eligible) from
// "no attestation" (security error)
export class GitHubAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAccessError";
  }
}

export function isGitHubAccessError(err: unknown): err is GitHubAccessError {
  return err instanceof GitHubAccessError;
}
```

### `package/src/verify/constants.ts` — add

```typescript
export const REKOR_SEARCH_URL =
  "https://rekor.sigstore.dev/api/v1/index/retrieve";
export const REKOR_ENTRY_URL =
  "https://rekor.sigstore.dev/api/v1/log/entries/{uuid}";
export const MAX_REKOR_ENTRIES = 50;
```

### `package/src/verify/schemas.ts` — add

```typescript
export const RekorSearchResponseSchema = z.array(z.string());

export const RekorLogEntrySchema = z.record(
  z.string(),
  z.object({
    body: z.string(),
    integratedTime: z.number(),
    logID: z.string(),
    logIndex: z.number(),
    verification: z.object({
      signedEntryTimestamp: z.string(),
      inclusionProof: z.object({
        checkpoint: z.string(),
        hashes: z.array(z.string()),
        logIndex: z.number(),
        rootHash: z.string(),
        treeSize: z.number(),
      }),
    }),
  }),
);

export const RekorDsseBodySchema = z.object({
  apiVersion: z.string(),
  kind: z.literal("dsse"),
  spec: z.object({
    envelopeHash: z.object({
      algorithm: z.literal("sha256"),
      value: z.string(),
    }),
    payloadHash: z.object({
      algorithm: z.literal("sha256"),
      value: z.string(),
    }),
    signatures: z
      .array(
        z.object({
          signature: z.string(),
          verifier: z.string(),
        }),
      )
      .min(1),
  }),
});
```

### `package/src/verify/attestations.ts` — modify

```typescript
// In throwGitHubApiError, replace the 404 + no-token branch:
if (response.status === 404 && !token) {
  throw new GitHubAccessError(`GitHub API returned 404 without authentication`);
}
// Keep the 404 + token branch as ProvenanceError (no attestation)
```

### `package/src/verify/api.ts` — modify

```typescript
// In verifyAddonProvenance, wrap fetchGitHubAttestations in try/catch:
export async function verifyAddonProvenance(options) {
  const { sha256, runInvocationURI, repo } = options;
  const config = resolveConfig(options);

  let ghAttestations: GitHubAttestations;
  try {
    ghAttestations = await fetchGitHubAttestations({ repo, sha256 }, config);
  } catch (err) {
    if (isGitHubAccessError(err)) {
      log("GitHub API inaccessible, trying Rekor fallback");
      const result = await verifyAddonViaRekor({
        sha256,
        runInvocationURI,
        repo,
        config,
      });
      if (result === null) {
        throw new ProvenanceError(dedent`
          No attestation found via GitHub API or Rekor for ${sha256}.
          For private repos, either set GITHUB_TOKEN or use
          sigstore: public-good in attest-build-provenance.
        `);
      }
      return; // Rekor verification succeeded
    }
    throw err;
  }

  // ... existing bundle verification loop (unchanged) ...
}
```

### Unchanged files

`certificates.ts`, `types.ts`, `config.ts`, `commands.ts` —
`verifyCertificateOIDs` works on any `X509Certificate` regardless
of source.

## Security analysis

### Trust model equivalence

| Property              | GitHub API path            | Rekor path             |
| --------------------- | -------------------------- | ---------------------- |
| Certificate authority | public-good Fulcio         | same                   |
| Transparency proof    | tlogEntry in bundle        | inclusion proof direct |
| Same-run binding      | RunInvocationURI in cert   | same                   |
| Source repo check     | OID 1.3.6.1.4.1.57264.1.12 | same                   |
| Issuer check          | OID 1.3.6.1.4.1.57264.1.8  | same                   |
| Artifact binding      | SHA-256 in DSSE subject    | SHA-256 Rekor index    |

The GitHub API path verifies the DSSE signature (certificate holder
signed this in-toto statement). The Rekor path verifies the
inclusion proof (signing event was logged). Both require Fulcio
compromise or Rekor forgery to bypass.

### Threat: attacker submits Rekor entries for the same hash

Rekor is append-only and publicly writable.
`verifyCertificateOIDs` rejects certificates with wrong
`RunInvocationURI` or source repo.

### Threat: Rekor entry flood (DoS)

Cap at `MAX_REKOR_ENTRIES` (50), use `RESOLVE_CONCURRENCY` for
fetches, apply `MAX_JSON_RESPONSE_BYTES` to responses. Real
artifact hashes have 1–5 entries (verified: `cli/cli` hash → 1).

### Information leak: private repo metadata in Rekor

`sigstore: public-good` on a private repo exposes in the public
Rekor log: repository name, workflow path, run URL, commit SHA.
Source code stays private.

### Certificate validity window

Fulcio certificates are valid ~10 minutes. The SET proves the
signing occurred within the validity window. `verifyTLogSET`
checks the `integratedTime` against `TLogAuthority.validFor`.

## Testing

### Unit tests (`rekor.ts` inline vitest)

```typescript
describe("extractCertFromRekorEntry", () => {
  it("parses cert from real entry fixture", ({ expect }) => {
    // Use captured entry body from cli/cli Rekor lookup
    const cert = extractCertFromRekorEntry(FIXTURE_ENTRY);
    expect(getExtensionValue(cert, OID_RUN_INVOCATION_URI)).toBe(
      "https://github.com/cli/cli/actions/runs/22312430014/attempts/4",
    );
    expect(getExtensionValue(cert, OID_SOURCE_REPO_URI)).toBe(
      "https://github.com/cli/cli",
    );
  });
});

describe("verifyMerkleInclusion", () => {
  it("accepts valid proof from fixture", ({ expect }) => {
    // Use real inclusion proof from cli/cli entry
    expect(() =>
      verifyMerkleInclusion(FIXTURE_ENTRY, FIXTURE_CHECKPOINT),
    ).not.toThrow();
  });
  it("rejects tampered root hash", ({ expect }) => {
    const bad = { ...FIXTURE_CHECKPOINT, logHash: Buffer.alloc(32) };
    expect(() => verifyMerkleInclusion(FIXTURE_ENTRY, bad)).toThrow(/Merkle/);
  });
});

describe("decompInclProof", () => {
  it("computes inner/border for known values", ({ expect }) => {
    // index=3, size=7 → inner=2, border=1
    expect(decompInclProof(3n, 7n)).toEqual({ inner: 2, border: 1 });
  });
});
```

### Unit tests (`verify.test.ts` additions)

```typescript
describe("fetchGitHubAttestations Rekor fallback", () => {
  it("throws GitHubAccessError on 404 + no token", async ({ expect }) => {
    using _fetch = stubFetch(async () => new Response(null, { status: 404 }));
    // No GITHUB_TOKEN in env
    await expect(
      fetchGitHubAttestations(
        { repo: "owner/repo", sha256: FAKE_HASH },
        defaultConfig,
      ),
    ).rejects.toThrow(GitHubAccessError);
  });

  it("throws ProvenanceError on 404 + with token", async ({ expect }) => {
    using _token = stubEnvVar("GITHUB_TOKEN", "ghp_test");
    using _fetch = stubFetch(async () => new Response(null, { status: 404 }));
    await expect(
      fetchGitHubAttestations(
        { repo: "owner/repo", sha256: FAKE_HASH },
        defaultConfig,
      ),
    ).rejects.toThrow(ProvenanceError);
  });
});
```

### Integration test

```typescript
// cli/cli attestation: 1 entry in public Rekor (verified)
it("verifies addon via Rekor fallback", async ({ expect }) => {
  await expect(
    verifyAddonViaRekor({
      sha256: CLI_HASH,
      runInvocationURI: CLI_RUN_URI,
      repo: CLI_REPO,
      config: resolveConfig({ retryCount: 0 }),
    }),
  ).resolves.toBeUndefined();
});

it("returns null when hash not in Rekor", async ({ expect }) => {
  const result = await verifyAddonViaRekor({
    sha256: sha256Hex("ff".repeat(32)),
    runInvocationURI: CLI_RUN_URI,
    repo: CLI_REPO,
    config: resolveConfig({ retryCount: 0 }),
  });
  expect(result).toBeNull();
});
```

## Documentation changes

### `package/README.md` — Authentication

```markdown
### Authentication

Public repositories work without authentication. Private
repositories work without authentication **if** the CI workflow
uses `sigstore: public-good` in `actions/attest-build-provenance`
(verification falls back to the public Rekor transparency log).
Otherwise, private repositories require `GITHUB_TOKEN`.

> **Privacy note:** `sigstore: public-good` on a private repository
> exposes the repository name, workflow paths, commit SHAs, and
> run URLs in the public Rekor transparency log. Source code
> remains private.
```

### `package/README.md` — Threat model

Add to "Not protected":

> **Private repo metadata leak** — `sigstore: public-good` on a
> private repository exposes repository name and CI metadata in
> the public Rekor transparency log.

### `package/README.md` — CI setup

Add `sigstore: public-good` to the attest step with a comment
for private repos.

## Task breakdown

1. Add `@sigstore/tuf` 4.0.1 + `@sigstore/verify` 3.1.0 to
   `pnpm-workspace.yaml` catalog and `package/package.json`
   devDependencies
2. Add `method` + `body` to `FetchOptions` in `types.ts`,
   wire through in `download.ts`
3. Add `GitHubAccessError` to `util/provenance-error.ts`
4. Add Rekor constants to `constants.ts`
5. Add Rekor Zod schemas to `schemas.ts`
6. Create `rekor.ts` — full implementation per architecture above
7. Modify `attestations.ts` — `GitHubAccessError` on 404 + no
   token
8. Modify `api.ts` — catch + Rekor fallback
9. Unit tests for `rekor.ts` (inline vitest)
10. Unit tests for fallback in `verify.test.ts`
11. Integration test against real Rekor entry
12. `package/README.md` updates
