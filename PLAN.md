# Rekor-based addon verification

## Problem

```typescript
// actions/attest src/main.ts — sigstore instance selection
const sigstoreInstance: SigstoreInstance =
  github.context.payload.repository?.visibility === "public" &&
  !inputs.privateSigning // undocumented
    ? "public-good" // → fulcio.sigstore.dev + rekor.sigstore.dev
    : "github"; // → fulcio.githubapp.com + timestamp.githubapp.com
```

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

## Solution: replace GitHub API with Rekor

```text
Before:
  fetchGitHubAttestations          // GET api.github.com
    → resolve bundles → verifier.verify(bundle)
    → extractCertFromBundle → check OIDs

After:
  fetchRekorAttestations(sha256)   // POST rekor.sigstore.dev
    → for each entry UUID:
        fetchRekorEntry(uuid) → verifyTLogInclusion()
        → extractCertFromEntry() → check OIDs
```

| Scenario                                             | Rekor |
| ---------------------------------------------------- | ----- |
| Public repo (default `actions/attest` → public-good) | ✅    |
| Private repo + `attest-public` action from this repo | ✅    |

Private repos using standard `actions/attest` are out of scope
— their attestations use GitHub's private Fulcio + TSA, no
Rekor entry.

## `attest-public` action (repo root)

`actions/attest` hardcodes instance selection with no override.
The `@actions/attest` npm package accepts
`sigstore: 'public-good'` programmatically. This repo provides
a root-level action that hardcodes it:

```yaml
# action.yaml
name: "Attest (public-good sigstore)"
description: >-
  Attest build provenance via the public-good sigstore instance.
  Logs to the public Rekor transparency log for tokenless
  verification.
inputs:
  subject-path:
    description: "Path to artifact(s) to attest. Supports globs."
    required: true
  github-token:
    description: "GitHub token for authenticated API requests."
    default: "${{ github.token }}"
    required: false
outputs:
  attestation-id:
    description: "The ID of the attestation."
runs:
  using: "node24"
  main: "action/index.mjs"
```

```javascript
// action/index.mjs
import * as core from "@actions/core";
import { attestProvenance } from "@actions/attest";
import { glob } from "@actions/glob";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const subjectPath = core.getInput("subject-path", {
  required: true,
});
const token = core.getInput("github-token", { required: true });

const globber = await glob.create(subjectPath);
const files = await globber.glob();
if (files.length === 0) {
  throw new Error(`no files matched: ${subjectPath}`);
}

const subjects = await Promise.all(
  files.map(async (file) => {
    const content = await readFile(file);
    const sha256 = createHash("sha256").update(content).digest("hex");
    return { name: file, digest: { sha256 } };
  }),
);

const result = await attestProvenance({
  subjects,
  token,
  sigstore: "public-good", // hardcoded — the whole point
});

core.setOutput("attestation-id", result.attestationID);
```

```yaml
# consumer workflow usage
- name: "Attest build provenance"
  uses: "vadimpiven/node-addon-slsa@v1"
  with:
    subject-path: "dist/*.gz"
```

## Public API changes

`verifyAddonProvenance` signature unchanged — same options,
same `ProvenanceError` / `Error` throw contract.

Removed:

- `GITHUB_TOKEN` for addon verification — Rekor needs no auth
- `fetchGitHubAttestations` — replaced entirely

## New dependencies

```jsonc
// pnpm-workspace.yaml — pin to versions from sigstore 4.1.0
"@sigstore/tuf": "4.0.1",    // getTrustedRoot() → TrustedRoot
"@sigstore/verify": "3.1.0", // toTrustMaterial() → TrustMaterial
```

pnpm strict hoisting blocks transitive dep access.
`TrustMaterial.tlogs` → `TLogAuthority[]` with Rekor public
keys for SET and checkpoint verification.

## Architecture

### `package/src/verify/rekor.ts` (new)

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { crypto, json, X509Certificate } from "@sigstore/core";
import type { TLogAuthority, TrustMaterial } from "@sigstore/verify";

/**
 * Verify addon provenance via the public Rekor transparency log.
 * Searches for attestation entries matching the artifact hash,
 * verifies each entry's inclusion proof, and checks that the
 * Fulcio certificate matches the expected workflow run and
 * source repository.
 *
 * @throws {@link ProvenanceError} if no attestation matches the
 *   expected workflow run or source repository.
 * @throws `Error` on transient failures (network, Rekor
 *   unavailable) — safe to retry.
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
  const uuids = await searchRekorIndex(sha256, config);

  if (uuids.length === 0) {
    throw new ProvenanceError(dedent`
      No attestation found in Rekor for artifact hash ${sha256}.
      The artifact may have been tampered with, or the CI
      workflow may not have used the attest-public action.
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

### Internals: TUF, Rekor API, tlog verification

```typescript
// --- TUF trust material (lazy singleton) ---

let trustMaterialCache: TrustMaterial | undefined;

async function loadTrustMaterial(): Promise<TrustMaterial> {
  if (!trustMaterialCache) {
    const root = await getTrustedRoot();
    trustMaterialCache = toTrustMaterial(root);
  }
  return trustMaterialCache;
}

// --- Rekor API ---

async function searchRekorIndex(
  sha256: Sha256Hex,
  config: ResolvedConfig,
): Promise<string[]> {
  // POST rekor.sigstore.dev/api/v1/index/retrieve
  // { "hash": "sha256:{hash}" }
  const response = await postWithRetry(REKOR_SEARCH_URL, {
    body: JSON.stringify({ hash: `sha256:${sha256}` }),
    config,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(dedent`
      Rekor search failed:
      ${response.status} ${response.statusText}
    `);
  }
  return RekorSearchResponseSchema.parse(
    await readJsonBounded(response, config.maxJsonResponseBytes),
  );
}

async function fetchRekorEntry(
  uuid: string,
  config: ResolvedConfig,
): Promise<RekorLogEntry> {
  // GET rekor.sigstore.dev/api/v1/log/entries/{uuid}
  // Response: { [uuid]: entry } — extract single value
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
// crypto. @sigstore/verify exports TrustMaterial but not the
// individual tlog verification functions.

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

  // Same payload structure as @sigstore/verify tlog/set.js
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
  if (!validTLogs.some((t) => crypto.verify(data, t.publicKey, signature))) {
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

  // Format: <note>\n\n— <identity> <keyhint+sig>\n
  const sepIdx = envelope.indexOf("\n\n");
  if (sepIdx === -1) {
    throw new Error("invalid checkpoint: missing separator");
  }
  const note = envelope.slice(0, sepIdx + 1);
  const sigs = envelope.slice(sepIdx + 2);

  // Parse: origin\nsize\nbase64(rootHash)\n
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
  // Format: "— <name> <base64(4-byte-hint + sig)>\n"
  const sigRegex = /\u2014 (\S+) (\S+)\n/g;
  const noteData = Buffer.from(note, "utf-8");
  let anyVerified = false;

  for (const match of sigs.matchAll(sigRegex)) {
    const sigBytes = Buffer.from(match[2]!, "base64");
    const keyHint = sigBytes.subarray(0, 4);
    const sig = sigBytes.subarray(4);
    // includes() not match() — match() treats '.' as wildcard
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

// Merkle: RFC 6962 §2.1.1 inclusion proof
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

// Certificate from Rekor DSSE entry body
function extractCertFromEntry(entry: RekorLogEntry): X509Certificate {
  const body = JSON.parse(Buffer.from(entry.body, "base64").toString("utf8"));
  const parsed = RekorDsseBodySchema.parse(body);
  const certB64 = parsed.spec.signatures[0]!.verifier;
  const certPem = Buffer.from(certB64, "base64").toString("utf8");
  return X509Certificate.parse(certPem);
}
```

### `postWithRetry` in `rekor.ts`

`fetchWithRetry` is GET-only (stall guards for binary streams).
Private `postWithRetry` with same timeout/retry/jitter:

```typescript
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

`jitteredDelay` — extract from `download.ts` to shared location
or duplicate (~3 lines).

### `package/src/verify/api.ts` — replace

```typescript
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
  return fetchRekorAttestations({
    sha256,
    runInvocationURI,
    repo,
    config,
  });
}
```

### Files to delete or simplify

- **`attestations.ts`** — remove `fetchGitHubAttestations`,
  `throwGitHubApiError`, `resolveBundle`, `mapSettled`, Snappy
  decompression. Keep `fetchNpmAttestations`.
- **`schemas.ts`** — remove `GitHubAttestationsApiSchema`.
  Keep `NpmAttestationsSchema`, `BundleSchema`.
- **`constants.ts`** — remove `GITHUB_ATTESTATIONS_URL`. Add
  `REKOR_SEARCH_URL`, `REKOR_ENTRY_URL`, `MAX_REKOR_ENTRIES`.
- **`certificates.ts`** — remove `extractCertFromBundle`. Keep
  `verifyCertificateOIDs`, `getExtensionValue`.

### New schemas in `schemas.ts`

```typescript
/** Rekor search-by-hash: array of entry UUIDs. */
export const RekorSearchResponseSchema = z.array(z.string());

/** Rekor GET /log/entries/{uuid}: { [uuid]: entry }. */
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

/** Decoded Rekor DSSE entry body. */
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

### Unchanged files

`types.ts`, `config.ts`, `commands.ts`, `index.ts`

## Security analysis

### Trust model

| Property              | Verification               |
| --------------------- | -------------------------- |
| Certificate authority | public-good Fulcio         |
| Transparency proof    | inclusion proof + SET      |
| Same-run binding      | RunInvocationURI in cert   |
| Source repo check     | OID 1.3.6.1.4.1.57264.1.12 |
| Issuer check          | OID 1.3.6.1.4.1.57264.1.8  |
| Artifact binding      | SHA-256 Rekor search key   |

The removed GitHub API path verified the full DSSE signature
(proves certificate holder signed this exact in-toto statement).
The Rekor path verifies the inclusion proof (proves signing event
was logged) + certificate OIDs. Both require Fulcio compromise or
Rekor forgery to bypass.

### Threats

**Attacker submits Rekor entries for the same hash.**
Rekor is append-only and publicly writable.
`verifyCertificateOIDs` rejects certificates with wrong
`RunInvocationURI` or source repo.

**Rekor entry flood (DoS).** Cap at `MAX_REKOR_ENTRIES` (50).
Apply `maxJsonResponseBytes`. Sequential fetch with early-exit
on first match (typical: 1 entry, verified: `cli/cli` → 1).

**Private repo metadata in Rekor.** The `attest-public` action
on a private repo exposes repository name, workflow path, run
URL, commit SHA. Source code stays private.

**Certificate validity window.** Fulcio certs valid ~10 min.
`verifySET` checks `integratedTime` against
`TLogAuthority.validFor`.

## Testing

### Remove: `verify.test.ts` `fetchGitHubAttestations` tests

All `fetchGitHubAttestations` tests removed with the function:
404 behavior, rate-limit handling, auth header, bundle_url
resolution, Snappy decompression.

### Update: `api.test.ts`

```typescript
vi.mock("../src/verify/rekor.ts", () => ({
  fetchRekorAttestations: vi.fn(),
}));
const { fetchRekorAttestations } =
  await import("../src/verify/rekor.ts");

describe("verifyAddonProvenance", () => {
  it("delegates to fetchRekorAttestations",
    async ({ expect }) => {
      vi.mocked(fetchRekorAttestations)
        .mockResolvedValueOnce(undefined);
      await verifyAddonProvenance({
        sha256: sha256Hex("a".repeat(64)),
        runInvocationURI:
          "https://github.com/o/r/actions/runs/1/attempts/1"
            as RunInvocationURI,
        repo: "owner/repo",
      });
      expect(fetchRekorAttestations).toHaveBeenCalledWith(
        expect.objectContaining({
          sha256: "a".repeat(64),
          repo: "owner/repo",
        }),
      );
    },
  );

  it("propagates ProvenanceError", async ({ expect }) => {
    vi.mocked(fetchRekorAttestations)
      .mockRejectedValueOnce(
        new ProvenanceError("no matching entries"),
      );
    await expect(verifyAddonProvenance({
      sha256: sha256Hex("a".repeat(64)),
      runInvocationURI:
        "https://github.com/o/r/actions/runs/1/attempts/1"
          as RunInvocationURI,
      repo: "owner/repo",
    })).rejects.toThrow(ProvenanceError);
  });
});
```

### Update: `verify.integration.test.ts`

```typescript
// cli/cli attestation: 1 entry in public Rekor (verified)
describe("verifyAddonProvenance (integration)", () => {
  it("succeeds with correct hash, repo, and run URI", async ({ expect }) => {
    await expect(
      verifyAddonProvenance({
        sha256: CLI_HASH,
        runInvocationURI: CLI_RUN_URI,
        repo: CLI_REPO,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects when repo does not match", async ({ expect }) => {
    await expect(
      verifyAddonProvenance({
        sha256: CLI_HASH,
        runInvocationURI: CLI_RUN_URI,
        repo: "wrong/repo",
      }),
    ).rejects.toThrow(ProvenanceError);
  });

  it("rejects when run URI does not match", async ({ expect }) => {
    await expect(
      verifyAddonProvenance({
        sha256: CLI_HASH,
        runInvocationURI: runInvocationURI(
          "https://github.com/cli/cli/actions/runs/1/attempts/1",
        ),
        repo: CLI_REPO,
      }),
    ).rejects.toThrow(ProvenanceError);
  });
});

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

  it("throws for unknown hash", async ({ expect }) => {
    await expect(
      fetchRekorAttestations({
        sha256: sha256Hex("ff".repeat(32)),
        runInvocationURI: CLI_RUN_URI,
        repo: CLI_REPO,
        config: resolveConfig({ retryCount: 0 }),
      }),
    ).rejects.toThrow(ProvenanceError);
  });

  it("throws when run URI mismatches", async ({ expect }) => {
    await expect(
      fetchRekorAttestations({
        sha256: CLI_HASH,
        runInvocationURI: runInvocationURI(
          "https://github.com/cli/cli/actions/runs/1/attempts/1",
        ),
        repo: CLI_REPO,
        config: resolveConfig({ retryCount: 0 }),
      }),
    ).rejects.toThrow(ProvenanceError);
  });

  it("throws when repo mismatches", async ({ expect }) => {
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

### New: `rekor.ts` inline vitest

```typescript
describe("extractCertFromEntry", () => {
  it("extracts cert with correct OIDs", ({ expect }) => {
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

describe("verifyMerkleProof", () => {
  it("accepts valid fixture proof", ({ expect }) => {
    expect(() =>
      verifyMerkleProof(FIXTURE_ENTRY, FIXTURE_CHECKPOINT),
    ).not.toThrow();
  });

  it("rejects tampered root hash", ({ expect }) => {
    expect(() =>
      verifyMerkleProof(FIXTURE_ENTRY, {
        ...FIXTURE_CHECKPOINT,
        logHash: Buffer.alloc(32),
      }),
    ).toThrow(/Merkle/);
  });
});

describe("decompInclProof", () => {
  it("index=3, size=7 → inner=2, border=1", ({ expect }) => {
    expect(decompInclProof(3n, 7n)).toEqual({ inner: 2, border: 1 });
  });
  it("index=0, size=1 → inner=0, border=0", ({ expect }) => {
    expect(decompInclProof(0n, 1n)).toEqual({ inner: 0, border: 0 });
  });
});

describe("verifySET", () => {
  it("rejects with no matching tlog authority", ({ expect }) => {
    expect(() => verifySET(FIXTURE_ENTRY, [])).toThrow(/SET/);
  });
});

describe("searchRekorIndex", () => {
  it("POSTs correct body", async ({ expect }) => {
    let body: string | undefined;
    using _f = stubFetch(async (_: unknown, init?: RequestInit) => {
      body = init?.body as string;
      return new Response("[]", { status: 200 });
    });
    await searchRekorIndex(
      sha256Hex("a".repeat(64)),
      resolveConfig({ retryCount: 0 }),
    );
    expect(JSON.parse(body!)).toEqual({
      hash: `sha256:${"a".repeat(64)}`,
    });
  });
});
```

## Documentation changes

### `package/README.md` — Authentication

```markdown
### Authentication

No authentication required. Addon attestations are verified
via the public Rekor transparency log. npm attestations are
verified via the public npm registry and sigstore.

Private repositories must use the `attest-public` action
(`vadimpiven/node-addon-slsa@v1`) in their CI workflow.

> **Privacy note:** the `attest-public` action on a private
> repository exposes the repository name, workflow paths,
> commit SHAs, and run URLs in the public Rekor transparency
> log. Source code remains private.
```

### `package/README.md` — Environment variables

Remove `GITHUB_TOKEN`. Keep `SLSA_DEBUG`.

### `package/README.md` — Threat model

Add: **Private repo metadata leak** — using the `attest-public`
action on a private repository exposes repository name and CI
metadata in the public Rekor transparency log.

### `package/README.md` — CI setup

Replace `actions/attest` with `vadimpiven/node-addon-slsa@v1`.

## Task breakdown

1. `action.yaml` + `action/index.mjs` at repo root
2. `@sigstore/tuf` 4.0.1 + `@sigstore/verify` 3.1.0 in catalog
   and `package/package.json`
3. `constants.ts` — add Rekor URLs + `MAX_REKOR_ENTRIES`, remove
   `GITHUB_ATTESTATIONS_URL`
4. `schemas.ts` — add Rekor schemas, remove
   `GitHubAttestationsApiSchema`
5. `rekor.ts` — full implementation + inline vitest
6. `api.ts` — replace with `fetchRekorAttestations` call
7. `attestations.ts` — remove GitHub API logic
8. `certificates.ts` — remove `extractCertFromBundle`
9. `verify.test.ts` — remove `fetchGitHubAttestations` tests
10. `api.test.ts` — mock `fetchRekorAttestations`
11. `verify.integration.test.ts` — Rekor-based tests
12. `package/README.md` updates
