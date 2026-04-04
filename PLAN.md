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
  fetchRekorAttestations(sha256)   // POST rekor.sigstore.dev
    → for each entry UUID:
        fetchRekorEntry(uuid)
        → verifyTLogInclusion()    // SET + checkpoint + merkle
        → extractCertFromEntry()   // from entry body
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

## Public API changes

No public API changes. The Rekor fallback is transparent:

- `verifyAddonProvenance` signature unchanged — same options,
  same `ProvenanceError` / `Error` contract
- `FetchOptions`, `VerifyOptions` unchanged — no new fields
- `index.ts` exports unchanged — no new public symbols
- Existing callers see no behavioral difference unless they
  relied on the specific error message for 404 + no token
  (which included "set GITHUB_TOKEN" hint — now attempts
  Rekor first, mentions both options on failure)

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

### New file: `package/src/verify/rekor.ts`

Contains all Rekor-specific logic: search, entry fetching,
tlog inclusion proof verification, certificate extraction,
and orchestration. Single public export consumed by `api.ts`.

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { crypto, json, X509Certificate } from "@sigstore/core";
import type { TLogAuthority, TrustMaterial } from "@sigstore/verify";

import type { GitHubRepo, RunInvocationURI, Sha256Hex } from "../types.ts";
import type { ResolvedConfig } from "./config.ts";

/**
 * Search the public Rekor transparency log for attestation entries
 * matching the artifact hash, then verify each entry's inclusion
 * proof and certificate OIDs.
 *
 * Used as a fallback when the GitHub Attestations API is not
 * accessible (e.g. private repository without `GITHUB_TOKEN`).
 *
 * @throws {@link ProvenanceError} if entries exist but none match
 *   the expected workflow run or source repository.
 * @throws `Error` on transient failures (network, Rekor unavailable)
 *   — safe to retry.
 */
export async function fetchRekorAttestations(options: {
  sha256: Sha256Hex;
  runInvocationURI: RunInvocationURI;
  repo: GitHubRepo;
  config: ResolvedConfig;
  trustMaterial?: TrustMaterial; // injectable for testing
}): Promise<void> {
  const { sha256, runInvocationURI, repo, config } = options;
  const trustMaterial = options.trustMaterial ?? (await loadTrustMaterial());

  log(`searching Rekor for attestations`);

  // POST /api/v1/index/retrieve { "hash": "sha256:{hash}" }
  const uuids = await searchRekorIndex(sha256, config);

  if (uuids.length === 0) {
    throw new ProvenanceError(dedent`
      No attestation found on GitHub API or Rekor for artifact
      hash ${sha256}.
      For private repos, either set GITHUB_TOKEN or use
      sigstore: public-good in attest-build-provenance.
    `);
  }

  const capped = uuids.slice(0, MAX_REKOR_ENTRIES);
  let verifyFailures = 0;

  for (const uuid of capped) {
    try {
      const entry = await fetchRekorEntry(uuid, config);
      verifyTLogInclusion(entry, trustMaterial);
      const cert = extractCertFromEntry(entry);
      const certRunURI = getExtensionValue(cert, OID_RUN_INVOCATION_URI);
      if (certRunURI === runInvocationURI) {
        verifyCertificateOIDs(cert, repo);
        log(`Rekor verification passed (entry ${uuid})`);
        return;
      }
    } catch (err) {
      if (isProvenanceError(err)) throw err;
      verifyFailures++;
      log(`Rekor entry ${uuid}: ${err}`);
    }
  }

  // Same error structure as verifyAddonProvenance in api.ts
  const total = capped.length;
  const detail =
    verifyFailures === total
      ? dedent`
        All ${total} Rekor entry/entries failed verification.
        This may indicate a sigstore trust root issue rather
        than tampering.
      `
      : dedent`
        ${total} Rekor entry/entries found but none matched
        workflow run ${runInvocationURI}.
        This can happen if the addon was rebuilt without
        re-attesting, or if the npm package and addon were
        produced by different workflow runs.
      `;
  throw new ProvenanceError(dedent`
    Addon provenance verification failed.
    ${detail}
  `);
}
```

Key design decisions:

- **Throws, never returns null.** Matches the project pattern:
  void on success, `ProvenanceError` on security failure,
  `Error` on transient failure. The "no entries found" case
  throws `ProvenanceError` with guidance, not a sentinel.
- **`trustMaterial` injectable.** Avoids module-level mutable
  state. Tests inject a mock; production uses `loadTrustMaterial`
  which caches internally.
- **Error messages mirror `api.ts`.** Same `dedent` structure,
  same "failed verification" vs "none matched" distinction.
- **Single public export.** `api.ts` calls
  `fetchRekorAttestations`; internals (`searchRekorIndex`,
  `verifyTLogInclusion`, etc.) are private, tested via inline
  vitest.

### Internal functions in `rekor.ts`

```typescript
// --- TUF trust material ---

let trustMaterialCache: TrustMaterial | undefined;

/** Load and cache the sigstore TUF trust root. */
async function loadTrustMaterial(): Promise<TrustMaterial> {
  // Lazy singleton — avoids TUF fetch when GitHub API succeeds.
  // Cache is process-lifetime; safe because the TUF root rotates
  // on the order of months, not seconds.
  if (!trustMaterialCache) {
    const root = await getTrustedRoot();
    trustMaterialCache = toTrustMaterial(root);
  }
  return trustMaterialCache;
}

// --- Rekor API ---

/**
 * POST rekor.sigstore.dev/api/v1/index/retrieve
 *
 * fetchWithRetry only supports GET. This function calls fetch()
 * directly with manual timeout + retry logic matching the
 * project's FetchOptions contract.
 */
async function searchRekorIndex(
  sha256: Sha256Hex,
  config: ResolvedConfig,
): Promise<string[]> {
  // Manual fetch with POST body — cannot use fetchWithRetry
  // because it doesn't support request bodies.
  // Apply same timeout/retry/signal semantics.
  const response = await postWithRetry(REKOR_SEARCH_URL, {
    body: JSON.stringify({ hash: `sha256:${sha256}` }),
    config,
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(dedent`
      Rekor search failed: ${response.status} ${response.statusText}
    `);
  }

  return RekorSearchResponseSchema.parse(
    await readJsonBounded(response, config.maxJsonResponseBytes),
  );
}

/** GET rekor.sigstore.dev/api/v1/log/entries/{uuid} */
async function fetchRekorEntry(
  uuid: string,
  config: ResolvedConfig,
): Promise<RekorLogEntry> {
  const url = evalTemplate(REKOR_ENTRY_URL, { uuid });
  const response = await fetchWithRetry(url, config);

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(dedent`
      failed to fetch Rekor entry ${uuid}:
      ${response.status} ${response.statusText}
    `);
  }

  const data = RekorLogEntrySchema.parse(
    await readJsonBounded(response, config.maxJsonResponseBytes),
  );

  // API returns { [uuid]: entry } — extract the single value
  const entries = Object.values(data);
  if (entries.length === 0) {
    throw new Error(`empty Rekor entry response for ${uuid}`);
  }
  return entries[0]!;
}
```

```typescript
// --- Transparency log inclusion verification ---
// Reimplements @sigstore/verify internals using @sigstore/core
// crypto primitives. The @sigstore/verify package exports Verifier
// and TrustMaterial but not the individual tlog verification
// functions (verifyTLogSET, verifyCheckpoint, verifyMerkleInclusion).

/**
 * Verify Rekor entry authenticity: signed entry timestamp,
 * checkpoint signature, and Merkle inclusion proof.
 */
function verifyTLogInclusion(
  entry: RekorLogEntry,
  trustMaterial: TrustMaterial,
): void {
  const tlogs = trustMaterial.tlogs;
  verifySET(entry, tlogs);
  const checkpoint = verifyCheckpointSignature(entry, tlogs);
  verifyMerkleProof(entry, checkpoint);
}

// SET: prove entry was acknowledged by a trusted Rekor instance
function verifySET(entry: RekorLogEntry, tlogs: TLogAuthority[]): void {
  const logIdBuf = Buffer.from(entry.logID, "hex");
  const timestamp = new Date(entry.integratedTime * 1000);
  const validTLogs = tlogs.filter(
    (t) =>
      crypto.bufferEqual(t.logID, logIdBuf) &&
      timestamp >= t.validFor.start &&
      timestamp <= t.validFor.end,
  );

  // Re-create the SET verification payload
  // (same structure as @sigstore/verify tlog/set.js)
  const payload = {
    body: entry.body,
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

// Checkpoint: prove the log root is signed by a trusted key
interface LogCheckpoint {
  origin: string;
  logSize: bigint;
  logHash: Buffer;
}

function verifyCheckpointSignature(
  entry: RekorLogEntry,
  tlogs: TLogAuthority[],
): LogCheckpoint {
  const envelope = entry.verification.inclusionProof.checkpoint;
  const sepIdx = envelope.indexOf("\n\n");
  if (sepIdx === -1) {
    throw new Error("invalid checkpoint: missing separator");
  }
  const note = envelope.slice(0, sepIdx + 1);
  const sigs = envelope.slice(sepIdx + 2);

  const lines = note.trimEnd().split("\n");
  if (lines.length < 3) {
    throw new Error("invalid checkpoint: expected at least 3 lines");
  }
  const checkpoint: LogCheckpoint = {
    origin: lines[0]!,
    logSize: BigInt(lines[1]!),
    logHash: Buffer.from(lines[2]!, "base64"),
  };

  // Verify signature(s)
  // Format: "\u2014 <name> <base64(4-byte-hint + sig)>\n"
  const sigRegex = /\u2014 (\S+) (\S+)\n/g;
  const noteData = Buffer.from(note, "utf-8");
  let anyVerified = false;

  for (const match of sigs.matchAll(sigRegex)) {
    const sigBytes = Buffer.from(match[2]!, "base64");
    const keyHint = sigBytes.subarray(0, 4);
    const sig = sigBytes.subarray(4);
    // Use includes() not match() — match() treats the
    // identity string as regex, turning '.' into wildcards
    const tlog = tlogs.find(
      (t) =>
        crypto.bufferEqual(t.logID.subarray(0, 4), keyHint) &&
        t.baseURL.includes(match[1]!),
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

// Merkle: prove the entry is included in the log at the
// checkpoint's root hash (RFC 6962 §2.1.1)
function verifyMerkleProof(
  entry: RekorLogEntry,
  checkpoint: LogCheckpoint,
): void {
  const proof = entry.verification.inclusionProof;
  const index = BigInt(proof.logIndex);
  const size = checkpoint.logSize;

  const { inner, border } = decompInclProof(index, size);
  const hashes = proof.hashes.map((h) => Buffer.from(h, "hex"));

  const LEAF = Buffer.from([0x00]);
  const NODE = Buffer.from([0x01]);

  const leafHash = crypto.digest(
    "sha256",
    LEAF,
    Buffer.from(entry.body, "base64"),
  );
  const root = chainBorderRight(
    chainInner(leafHash, hashes.slice(0, inner), index),
    hashes.slice(inner),
  );

  if (!crypto.bufferEqual(root, checkpoint.logHash)) {
    throw new Error("Merkle inclusion proof failed");
  }

  // --- helpers ---
  function chainInner(seed: Buffer, h: Buffer[], idx: bigint): Buffer {
    return h.reduce(
      (acc, v, i) =>
        (idx >> BigInt(i)) & 1n
          ? crypto.digest("sha256", NODE, v, acc)
          : crypto.digest("sha256", NODE, acc, v),
      seed,
    );
  }

  function chainBorderRight(seed: Buffer, h: Buffer[]): Buffer {
    return h.reduce((acc, v) => crypto.digest("sha256", NODE, v, acc), seed);
  }
}

// --- Certificate extraction ---

/** Extract Fulcio certificate from Rekor DSSE entry body. */
function extractCertFromEntry(entry: RekorLogEntry): X509Certificate {
  const body = JSON.parse(Buffer.from(entry.body, "base64").toString("utf8"));
  const parsed = RekorDsseBodySchema.parse(body);
  const certB64 = parsed.spec.signatures[0]!.verifier;
  const certPem = Buffer.from(certB64, "base64").toString("utf8");
  return X509Certificate.parse(certPem);
}
```

### POST support: `postWithRetry` in `rekor.ts`

`fetchWithRetry` in `download.ts` is GET-only by design — it
supports stall guards on streamed response bodies (binary
downloads). Adding `method`/`body` to the public `FetchOptions`
type would pollute the API for one internal caller.

Instead, `rekor.ts` implements a private `postWithRetry` that
reuses the same timeout/retry/signal/jitter semantics but supports
POST:

```typescript
/**
 * POST with timeout, retry, and exponential backoff.
 * Mirrors fetchWithRetry semantics but supports request bodies.
 * Does not apply stall guards (JSON responses are small).
 */
async function postWithRetry(
  url: string,
  options: { body: string; config: ResolvedConfig },
): Promise<Response> {
  const { config } = options;
  const maxAttempts = 1 + config.retryCount;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    config.signal?.throwIfAborted();
    const ac = new AbortController();
    const timer = globalThis.setTimeout(() => ac.abort(), config.timeoutMs);
    const signal = AbortSignal.any([ac.signal, config.signal].filter(Boolean));

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: options.body,
        signal,
      });
      if (response.status >= 500 && attempt < maxAttempts) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      return response;
    } catch (err) {
      if (config.signal?.aborted) throw err;
      lastError = err;
      if (attempt < maxAttempts) {
        const delay = jitteredDelay(attempt, config.retryBaseMs);
        log(`retrying Rekor search in ${delay}ms`);
        await sleep(delay, undefined, { signal: config.signal });
      }
    } finally {
      globalThis.clearTimeout(timer);
    }
  }
  throw lastError;
}
```

`jitteredDelay` is currently private to `download.ts`. Extract it
to a shared location or duplicate the ~3 lines in `rekor.ts`.

### Changes to `package/src/verify/attestations.ts`

The 404 + no-token path currently throws `ProvenanceError`.
Change it to throw a non-security `Error` so `api.ts` can
distinguish "no access" from "no attestation":

```typescript
// In throwGitHubApiError:

if (response.status === 404) {
  if (token) {
    // Authenticated request got 404 — artifact genuinely missing
    throw new ProvenanceError(noAttestationMsg);
  }
  // Unauthenticated 404 — could be private repo access denial.
  // Throw plain Error (not ProvenanceError) so api.ts can attempt
  // the Rekor fallback before concluding it's a security issue.
  throw new AttestationAccessError(dedent`
    GitHub API returned 404 without authentication.
    This may indicate a private repository or missing attestation.
  `);
}
```

`AttestationAccessError` — an internal error class in
`attestations.ts` (not exported, not in `provenance-error.ts`):

```typescript
/**
 * Thrown when the GitHub Attestations API denies access in a way
 * that might be resolved by an alternative attestation source.
 * Not a security error — the caller should attempt fallback
 * verification before failing.
 */
class AttestationAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttestationAccessError";
  }
}

/** @internal */
export function isAttestationAccessError(
  err: unknown,
): err is AttestationAccessError {
  return err instanceof AttestationAccessError;
}
```

Why not in `provenance-error.ts`:
`provenance-error.ts` contains `ProvenanceError` — a branded,
publicly exported security error. `AttestationAccessError` is an
internal flow-control signal between `attestations.ts` and
`api.ts`, not a security error. Colocating them conflates
security errors with access errors.

### Changes to `package/src/verify/api.ts`

```typescript
import { isAttestationAccessError } from "./attestations.ts";
import { fetchRekorAttestations } from "./rekor.ts";

export async function verifyAddonProvenance(
  options: {
    sha256: Sha256Hex;
    runInvocationURI: RunInvocationURI;
    repo: GitHubRepo;
  } & VerifyOptions,
): Promise<void> {
  const { sha256, runInvocationURI, repo } = options;
  const config = resolveConfig(options);

  log(`verifying addon provenance`);

  let ghAttestations: GitHubAttestations;
  try {
    ghAttestations = await fetchGitHubAttestations({ repo, sha256 }, config);
  } catch (err) {
    if (isAttestationAccessError(err)) {
      // GitHub API inaccessible without token — try public Rekor
      log(`GitHub API inaccessible, trying Rekor fallback`);
      return fetchRekorAttestations({
        sha256,
        runInvocationURI,
        repo,
        config,
      });
    }
    throw err;
  }

  // ... existing bundle verification loop (unchanged) ...
}
```

### Changes to `package/src/verify/index.ts`

No change. `fetchRekorAttestations` is not re-exported — it's
an internal implementation detail of `verifyAddonProvenance`.

### Unchanged files

- `certificates.ts` — `verifyCertificateOIDs` works on any
  `X509Certificate`
- `types.ts` — no new public types or fields
- `config.ts` — no changes
- `commands.ts` — calls through `PackageProvenance` handle
- `index.ts` — no new exports

### New constants in `constants.ts`

```typescript
export const REKOR_SEARCH_URL =
  "https://rekor.sigstore.dev/api/v1/index/retrieve";
export const REKOR_ENTRY_URL =
  "https://rekor.sigstore.dev/api/v1/log/entries/{uuid}";

/** Max Rekor search results to process before giving up. */
export const MAX_REKOR_ENTRIES = 50;
```

### New schemas in `schemas.ts`

```typescript
/** Rekor search-by-hash response: array of entry UUIDs. */
export const RekorSearchResponseSchema = z.array(z.string());

/** Rekor GET /log/entries/{uuid} response: { [uuid]: entry }. */
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

/** Decoded Rekor DSSE entry body (base64-decoded from entry.body). */
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

The GitHub API path verifies the DSSE signature (certificate
holder signed this in-toto statement). The Rekor path verifies
the inclusion proof (signing event was logged). Both require
Fulcio compromise or Rekor forgery to bypass.

### Threat: attacker submits Rekor entries for the same hash

Rekor is append-only and publicly writable.
`verifyCertificateOIDs` rejects certificates with wrong
`RunInvocationURI` or source repo.

### Threat: Rekor entry flood (DoS)

Cap at `MAX_REKOR_ENTRIES` (50). Apply `maxJsonResponseBytes`
to responses. Entries are fetched sequentially with early-exit
on first match (typical case: 1 entry), so parallelism is
unnecessary. Real artifact hashes have 1–5 entries (verified:
`cli/cli` hash → 1).

### Information leak: private repo metadata in Rekor

`sigstore: public-good` on a private repo exposes in the public
Rekor log: repository name, workflow path, run URL, commit SHA.
Source code stays private.

### Certificate validity window

Fulcio certificates are valid ~10 minutes. The SET proves the
signing occurred within the validity window. `verifySET` checks
`integratedTime` against `TLogAuthority.validFor`.

## Testing

### Existing tests to update

#### `verify.test.ts` — fetchGitHubAttestations 404 behavior

The existing test "returns ProvenanceError on 404" will break.
The 404 + no-token case now throws `AttestationAccessError`.
Split into two tests:

```typescript
// REPLACE existing "returns ProvenanceError on 404":

it("throws AttestationAccessError on 404 without token", async ({ expect }) => {
  using _fetch = stubFetch(
    async () => new Response(null, { status: 404, statusText: "Not Found" }),
  );
  await expect(
    fetchGitHubAttestations(
      { repo: "owner/repo", sha256: FAKE_HASH },
      defaultConfig,
    ),
  ).rejects.toThrow(AttestationAccessError);
});

it("throws ProvenanceError on 404 with token", async ({ expect }) => {
  using _token = stubEnvVar("GITHUB_TOKEN", "ghp_test");
  using _fetch = stubFetch(
    async () => new Response(null, { status: 404, statusText: "Not Found" }),
  );
  await expect(
    fetchGitHubAttestations(
      { repo: "owner/repo", sha256: FAKE_HASH },
      defaultConfig,
    ),
  ).rejects.toThrow(ProvenanceError);
});
```

#### `api.test.ts` — verifyAddonProvenance fallback

Add tests for the `AttestationAccessError` → Rekor fallback
path:

```typescript
vi.mock("../src/verify/rekor.ts", () => ({
  fetchRekorAttestations: vi.fn(),
}));

const { fetchRekorAttestations } =
  await import("../src/verify/rekor.ts");

describe("verifyAddonProvenance Rekor fallback", () => {
  it("falls back to Rekor when GitHub API throws "
    + "AttestationAccessError", async ({ expect }) => {
    vi.mocked(fetchGitHubAttestations).mockRejectedValueOnce(
      new AttestationAccessError("no access"),
    );
    vi.mocked(fetchRekorAttestations).mockResolvedValueOnce(
      undefined,
    );

    await expect(
      verifyAddonProvenance({
        sha256: sha256Hex("a".repeat(64)),
        runInvocationURI: "https://github.com/o/r/actions/runs/1/attempts/1"
          as RunInvocationURI,
        repo: "owner/repo",
        verifier: fakeVerifier(),
      }),
    ).resolves.toBeUndefined();

    expect(fetchRekorAttestations).toHaveBeenCalled();
  });

  it("does not fall back on ProvenanceError",
    async ({ expect }) => {
      vi.mocked(fetchGitHubAttestations).mockRejectedValueOnce(
        new ProvenanceError("tampered"),
      );

      await expect(
        verifyAddonProvenance({
          sha256: sha256Hex("a".repeat(64)),
          runInvocationURI: "https://github.com/o/r/actions/runs/1/attempts/1"
            as RunInvocationURI,
          repo: "owner/repo",
          verifier: fakeVerifier(),
        }),
      ).rejects.toThrow(ProvenanceError);

      expect(fetchRekorAttestations).not.toHaveBeenCalled();
    },
  );

  it("propagates ProvenanceError from Rekor fallback",
    async ({ expect }) => {
      vi.mocked(fetchGitHubAttestations).mockRejectedValueOnce(
        new AttestationAccessError("no access"),
      );
      vi.mocked(fetchRekorAttestations).mockRejectedValueOnce(
        new ProvenanceError("no matching entries"),
      );

      await expect(
        verifyAddonProvenance({
          sha256: sha256Hex("a".repeat(64)),
          runInvocationURI: "https://github.com/o/r/actions/runs/1/attempts/1"
            as RunInvocationURI,
          repo: "owner/repo",
          verifier: fakeVerifier(),
        }),
      ).rejects.toThrow(ProvenanceError);
    },
  );
});
```

### New unit tests: `rekor.ts` inline vitest

```typescript
// --- Certificate extraction ---

describe("extractCertFromEntry", () => {
  // FIXTURE_ENTRY: captured from cli/cli Rekor lookup
  it("extracts cert with correct OID values", ({ expect }) => {
    const cert = extractCertFromEntry(FIXTURE_ENTRY);
    expect(getExtensionValue(cert, OID_RUN_INVOCATION_URI)).toBe(
      "https://github.com/cli/cli/actions/runs/" + "22312430014/attempts/4",
    );
    expect(getExtensionValue(cert, OID_SOURCE_REPO_URI)).toBe(
      "https://github.com/cli/cli",
    );
  });

  it("rejects non-dsse entry kind", ({ expect }) => {
    const bad = {
      ...FIXTURE_ENTRY,
      body: btoa(
        JSON.stringify({
          apiVersion: "0.0.1",
          kind: "hashedrekord",
          spec: {},
        }),
      ),
    };
    expect(() => extractCertFromEntry(bad)).toThrow();
  });
});

// --- Merkle inclusion ---

describe("verifyMerkleProof", () => {
  it("accepts valid proof from fixture", ({ expect }) => {
    expect(() =>
      verifyMerkleProof(FIXTURE_ENTRY, FIXTURE_CHECKPOINT),
    ).not.toThrow();
  });

  it("rejects tampered root hash", ({ expect }) => {
    const bad = {
      ...FIXTURE_CHECKPOINT,
      logHash: Buffer.alloc(32),
    };
    expect(() => verifyMerkleProof(FIXTURE_ENTRY, bad)).toThrow(/Merkle/);
  });
});

describe("decompInclProof", () => {
  // Known values from RFC 6962 examples
  it("index=3, size=7 → inner=2, border=1", ({ expect }) => {
    expect(decompInclProof(3n, 7n)).toEqual({ inner: 2, border: 1 });
  });

  it("index=0, size=1 → inner=0, border=0", ({ expect }) => {
    expect(decompInclProof(0n, 1n)).toEqual({ inner: 0, border: 0 });
  });
});

// --- SET verification ---

describe("verifySET", () => {
  it("rejects when no matching tlog authority", ({ expect }) => {
    const emptyTlogs: TLogAuthority[] = [];
    expect(() => verifySET(FIXTURE_ENTRY, emptyTlogs)).toThrow(/SET/);
  });
});

// --- Search / fetch (mocked) ---

describe("searchRekorIndex", () => {
  it("sends POST with correct body", async ({ expect }) => {
    let capturedBody: string | undefined;
    using _fetch = stubFetch(async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response("[]", { status: 200 });
    });
    await searchRekorIndex(
      sha256Hex("a".repeat(64)),
      resolveConfig({ retryCount: 0 }),
    );
    expect(JSON.parse(capturedBody!)).toEqual({
      hash: `sha256:${"a".repeat(64)}`,
    });
  });
});
```

### New integration tests: `verify.integration.test.ts`

```typescript
// cli/cli attestation: 1 entry in public Rekor (verified)
describe("fetchRekorAttestations (integration)", () => {
  it("succeeds for known public attestation", async ({ expect }) => {
    await expect(
      fetchRekorAttestations({
        sha256: CLI_HASH,
        runInvocationURI: CLI_RUN_URI,
        repo: CLI_REPO,
        config: resolveConfig({ retryCount: 0 }),
      }),
    ).resolves.toBeUndefined();
  });

  it("throws ProvenanceError for hash with no Rekor entries", async ({
    expect,
  }) => {
    await expect(
      fetchRekorAttestations({
        sha256: sha256Hex("ff".repeat(32)),
        runInvocationURI: CLI_RUN_URI,
        repo: CLI_REPO,
        config: resolveConfig({ retryCount: 0 }),
      }),
    ).rejects.toThrow(ProvenanceError);
  });

  it("throws ProvenanceError when run URI does not match", async ({
    expect,
  }) => {
    const wrongRunURI = runInvocationURI(
      "https://github.com/cli/cli/actions/runs/1/attempts/1",
    );
    await expect(
      fetchRekorAttestations({
        sha256: CLI_HASH,
        runInvocationURI: wrongRunURI,
        repo: CLI_REPO,
        config: resolveConfig({ retryCount: 0 }),
      }),
    ).rejects.toThrow(ProvenanceError);
  });

  it("throws ProvenanceError when repo does not match", async ({ expect }) => {
    await expect(
      fetchRekorAttestations({
        sha256: CLI_HASH,
        runInvocationURI: CLI_RUN_URI,
        repo: "wrong/repo",
        config: resolveConfig({ retryCount: 0 }),
      }),
    ).rejects.toThrow(ProvenanceError);
  });
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

> **Privacy note:** `sigstore: public-good` on a private
> repository exposes the repository name, workflow paths, commit
> SHAs, and run URLs in the public Rekor transparency log.
> Source code remains private.
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
2. Add Rekor constants to `constants.ts`
3. Add Rekor Zod schemas to `schemas.ts`
4. Add `AttestationAccessError` + `isAttestationAccessError`
   to `attestations.ts`
5. Modify `throwGitHubApiError` in `attestations.ts` — throw
   `AttestationAccessError` on 404 + no token
6. Create `rekor.ts` — full implementation per architecture
   above, including inline vitest
7. Modify `verifyAddonProvenance` in `api.ts` — catch
   `AttestationAccessError`, call `fetchRekorAttestations`
8. Update `verify.test.ts` — split 404 test into
   with-token/without-token variants
9. Update `api.test.ts` — add Rekor fallback tests
10. Add integration tests for `fetchRekorAttestations`
11. `package/README.md` updates
