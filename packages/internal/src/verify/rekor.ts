// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Rekor transparency log verification. `verifyRekorAttestations` walks
 * the candidate UUIDs (via {@link RekorClient}) and yields a typed
 * `Outcome` per entry; a pure `reduceOutcomes` folds the stream into
 * one of three terminal error shapes or `return`s on the first verified
 * match. The outer ingestion-lag retry (see `verify.ts`) keys on
 * `ProvenanceError { kind: "rekor-not-found" }` emitted here.
 *
 * Two trust-binding steps stay visible in `parseRekorEntry`:
 *   1. Subject-digest binding — the in-toto Statement's `subject.digest`
 *      must equal the artifact sha we searched for. Without this, the
 *      multi-hash Rekor index could surface an entry that attests a
 *      different artifact whose envelope hash collided with our key.
 *   2. OID pinning — see `certificates.ts`.
 */

import { X509Certificate as NodeX509 } from "node:crypto";

import type { SerializedBundle } from "@sigstore/bundle";
import { X509Certificate } from "@sigstore/core";

import type { BundleVerifier, GitHubRepo, Sha256Hex } from "../types.ts";
import { errorMessage } from "../util/error.ts";
import { log, warn } from "../util/log.ts";
import { ProvenanceError, isProvenanceError } from "../util/provenance-error.ts";
import { verifyCertificateOIDs, type CertificateOIDExpectations } from "./certificates.ts";
import { RekorError, type RekorClient } from "./rekor-client.ts";
import {
  DsseEnvelopeSchema,
  InTotoStatementSchema,
  RekorDsseBodySchema,
  type RekorLogEntry,
} from "./schemas.ts";

const BUNDLE_V03_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json";
const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";

/**
 * Decode and validate a Rekor entry into the shape sigstore Verifier
 * expects, and enforce the subject-digest binding that Rekor's search
 * index alone does not guarantee.
 */
function parseRekorEntry(
  entry: RekorLogEntry,
  expectedSha256: Sha256Hex,
): {
  bundle: SerializedBundle;
  cert: X509Certificate;
} {
  const bodyBuf = Buffer.from(entry.body, "base64");
  const parsed = RekorDsseBodySchema.parse(JSON.parse(bodyBuf.toString("utf8")));
  const sig = parsed.spec.signatures[0];
  if (!sig) {
    throw new Error("Rekor DSSE entry has no signatures");
  }
  const certPem = Buffer.from(sig.verifier, "base64").toString("utf8");
  const certDerB64 = new NodeX509(certPem).raw.toString("base64");

  const envelopeJson = JSON.parse(Buffer.from(entry.attestation.data, "base64").toString("utf8"));
  const envelope = DsseEnvelopeSchema.parse(envelopeJson);

  // Subject-digest binding: the single defence against a hash collision
  // in Rekor's multi-hash index landing us on a DSSE entry that attests
  // a different artifact.
  const statementJson = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  const statement = InTotoStatementSchema.parse(statementJson);
  const want = expectedSha256.toLowerCase();
  const matched = statement.subject.some((s) => s.digest.sha256.toLowerCase() === want);
  if (!matched) {
    const seen = statement.subject.map((s) => s.digest.sha256).join(", ");
    throw new Error(
      `Rekor entry Statement does not attest the requested artifact: ` +
        `want=${want} subject.digest.sha256=[${seen}]`,
    );
  }

  const serialized: SerializedBundle = {
    mediaType: BUNDLE_V03_MEDIA_TYPE,
    verificationMaterial: {
      x509CertificateChain: undefined,
      publicKey: undefined,
      certificate: { rawBytes: certDerB64 },
      tlogEntries: [
        {
          logIndex: String(entry.logIndex),
          logId: { keyId: Buffer.from(entry.logID, "hex").toString("base64") },
          kindVersion: { kind: parsed.kind, version: parsed.apiVersion },
          integratedTime: String(entry.integratedTime),
          inclusionPromise: {
            signedEntryTimestamp: entry.verification.signedEntryTimestamp,
          },
          inclusionProof: {
            logIndex: String(entry.verification.inclusionProof.logIndex),
            rootHash: Buffer.from(entry.verification.inclusionProof.rootHash, "hex").toString(
              "base64",
            ),
            treeSize: String(entry.verification.inclusionProof.treeSize),
            hashes: entry.verification.inclusionProof.hashes.map((h) =>
              Buffer.from(h, "hex").toString("base64"),
            ),
            checkpoint: { envelope: entry.verification.inclusionProof.checkpoint },
          },
          canonicalizedBody: entry.body,
        },
      ],
      timestampVerificationData: undefined,
    },
    messageSignature: undefined,
    dsseEnvelope: {
      payload: envelope.payload,
      payloadType: envelope.payloadType,
      signatures: envelope.signatures.map((s) => ({ sig: s.sig, keyid: s.keyid ?? "" })),
    },
  };

  if (envelope.payloadType !== IN_TOTO_PAYLOAD_TYPE) {
    throw new Error(`Rekor entry DSSE payloadType is not in-toto: got ${envelope.payloadType}`);
  }

  return { bundle: serialized, cert: X509Certificate.parse(certPem) };
}

/** Per-UUID result from the candidate walk. Each variant is a closed case. */
type Outcome =
  | { readonly kind: "verified" }
  | { readonly kind: "rekor-error"; readonly error: RekorError }
  | { readonly kind: "verify-error"; readonly error: unknown };

async function* walkCandidates(
  uuids: readonly string[],
  client: RekorClient,
  verifier: BundleVerifier,
  sha256: Sha256Hex,
  repo: GitHubRepo,
  expect: CertificateOIDExpectations,
): AsyncIterable<Outcome> {
  for (const uuid of uuids) {
    let entry: RekorLogEntry;
    try {
      entry = await client.fetchEntry(uuid);
    } catch (err) {
      if (err instanceof RekorError) {
        log(`Rekor entry ${uuid} fetch failed: ${err.message}`);
        yield { kind: "rekor-error", error: err };
        continue;
      }
      throw err;
    }
    try {
      const { bundle, cert } = parseRekorEntry(entry, sha256);
      verifier.verify(bundle);
      verifyCertificateOIDs(cert, repo, expect);
      yield { kind: "verified" };
      return;
    } catch (err) {
      if (isProvenanceError(err)) {
        log(`Rekor entry ${uuid} OID check failed: ${err.message}`);
      } else {
        log(`Rekor entry ${uuid} failed verification: ${errorMessage(err)}`);
      }
      yield { kind: "verify-error", error: err };
    }
  }
}

/** Pure reducer. Throws one terminal shape, never returns. */
function reduceOutcomes(outcomes: readonly Outcome[], expect: CertificateOIDExpectations): void {
  const n = outcomes.length;
  let lag = 0;
  let unavailable = 0;
  let tamper = 0;
  let malformed = 0;
  let verifyFail = 0;

  for (const o of outcomes) {
    if (o.kind === "rekor-error") {
      if (o.error.kind === "lag") lag++;
      else if (o.error.kind === "unavailable") unavailable++;
      else if (o.error.kind === "tamper") tamper++;
      else malformed++;
    } else if (o.kind === "verify-error") {
      verifyFail++;
    }
  }

  // Tamper short-circuits: a UUID-reorder response is an active-attacker
  // signal, not a race. Fail closed before any retry can mask it.
  if (tamper > 0) {
    throw new ProvenanceError(
      `Rekor returned ${tamper} of ${n} entries under a UUID we didn't request. Refusing to verify.`,
    );
  }
  // Any 404 → retry: rebuilds produce several attestations for one hash
  // and the correct one may still be replicating while older ones
  // OID-mismatch, so mixed (lag + verify-fail) must also retry.
  if (lag > 0) {
    throw new ProvenanceError(
      `${lag} of ${n} Rekor entries still replicating (404). Retrying after ingestion-lag delay.`,
      { kind: "rekor-not-found" },
    );
  }
  // Pure server/network unreachability → distinct error. A malformed or
  // verify-failed entry makes the run provenance-failing (below), since
  // the unavailability was partial and not the root cause.
  if (unavailable > 0 && verifyFail === 0 && malformed === 0) {
    throw new Error(`Rekor unavailable: ${unavailable} of ${n} entry fetches failed (non-404).`);
  }
  throw new ProvenanceError(
    `Addon provenance verification failed. ${n} Rekor entries found, none matched the expected workflow run (${expect.runInvocationURI}) or signer pattern.`,
  );
}

/**
 * Verify that a Rekor entry exists for `sha256` whose signing cert
 * matches the expected OIDs. Returns on the first matching entry;
 * throws `ProvenanceError { kind: "rekor-not-found" }` on ingestion lag
 * (safe to outer-retry), plain `Error` on Rekor unavailability, and
 * `ProvenanceError` without a kind on deterministic mismatch.
 */
export async function verifyRekorAttestations(options: {
  sha256: Sha256Hex;
  repo: GitHubRepo;
  expect: CertificateOIDExpectations;
  client: RekorClient;
  verifier: BundleVerifier;
  maxEntries: number;
}): Promise<void> {
  const { sha256, repo, expect, client, verifier, maxEntries } = options;

  log(`searching Rekor for ${sha256}`);
  const uuids = await client.search(sha256);
  if (uuids.length === 0) {
    throw new ProvenanceError(
      `No Rekor entry found for artifact hash ${sha256}. The artifact may have been tampered with, or the publish workflow did not attest it.`,
      { kind: "rekor-not-found" },
    );
  }

  // Rekor returns oldest-first. Take the newest N — most likely to match
  // the current release; if an attacker floods entries past this window,
  // verification fails closed.
  const capped = maxEntries > 0 ? uuids.slice(-maxEntries) : uuids;
  if (uuids.length > capped.length) {
    warn(
      `Rekor returned ${uuids.length} entries for ${sha256}; checking newest ${capped.length}. If verification fails, this may indicate an attacker flooding the log.`,
    );
  }

  const outcomes: Outcome[] = [];
  for await (const o of walkCandidates(capped, client, verifier, sha256, repo, expect)) {
    if (o.kind === "verified") return;
    outcomes.push(o);
  }
  reduceOutcomes(outcomes, expect);
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;
  const { sha256Hex, runInvocationURI: runInvocationURIFn } = await import("../types.ts");
  const { DEFAULT_ATTEST_SIGNER_PATTERN } = await import("./constants.ts");

  const stubVerifier: BundleVerifier = {
    verify: () => {
      throw new Error("stubVerifier: verify should not be called");
    },
  };
  const neverMatchVerifier: BundleVerifier = {
    verify: () => {
      throw new Error("OID mismatch (test)");
    },
  };

  const expect_fixture: CertificateOIDExpectations = {
    sourceCommit: "deadbeef".repeat(5),
    sourceRef: "refs/tags/v0.0.0",
    runInvocationURI: runInvocationURIFn(
      "https://github.com/cli/cli/actions/runs/22312430014/attempts/4",
    ),
    attestSignerPattern: DEFAULT_ATTEST_SIGNER_PATTERN,
  };

  const ARTIFACT_SHA = sha256Hex("c".repeat(64));

  /** In-memory RekorClient for unit tests — no HTTP, no Zod schema checks. */
  type FakeOutcome = { kind: "entry"; entry: RekorLogEntry } | { kind: "error"; error: RekorError };
  function fakeRekorClient(opts: {
    searchResult?: readonly string[];
    searchError?: RekorError;
    entries?: Map<string, FakeOutcome>;
  }): RekorClient {
    return {
      search: async (_sha) => {
        if (opts.searchError) throw opts.searchError;
        return opts.searchResult ?? [];
      },
      fetchEntry: async (uuid) => {
        const outcome = opts.entries?.get(uuid);
        if (!outcome) {
          throw new RekorError({ kind: "malformed", uuid, message: `no fake entry for ${uuid}` });
        }
        if (outcome.kind === "error") throw outcome.error;
        return outcome.entry;
      },
    };
  }

  // Minimal RekorLogEntry that will not exercise the crypto path — only
  // used in tests where the verifier is stubbed (neverMatchVerifier).
  const BOGUS_ENTRY: RekorLogEntry = {
    body: Buffer.from(
      JSON.stringify({ apiVersion: "0.0.1", kind: "dsse", spec: { signatures: [] } }),
    ).toString("base64"),
    integratedTime: 0,
    logID: "00".repeat(32),
    logIndex: 0,
    attestation: { data: Buffer.from("{}").toString("base64") },
    verification: {
      inclusionProof: {
        checkpoint: "",
        hashes: ["00".repeat(32)],
        logIndex: 1,
        rootHash: "00".repeat(32),
        treeSize: 2,
      },
      signedEntryTimestamp: "AA==",
    },
  };

  describe("verifyRekorAttestations", () => {
    it("throws `rekor-not-found` when search yields no entries", async ({ expect }) => {
      await expect(
        verifyRekorAttestations({
          sha256: ARTIFACT_SHA,
          repo: "cli/cli",
          expect: expect_fixture,
          client: fakeRekorClient({ searchResult: [] }),
          verifier: stubVerifier,
          maxEntries: 10,
        }),
      ).rejects.toMatchObject({ kind: "rekor-not-found" });
    });

    it("throws `rekor-not-found` when every entry 404s (pure lag)", async ({ expect }) => {
      const uuids = ["u1", "u2"];
      const entries = new Map<string, FakeOutcome>(
        uuids.map((u) => [
          u,
          {
            kind: "error",
            error: new RekorError({ kind: "lag", uuid: u, message: `${u} lag` }),
          } as const,
        ]),
      );
      await expect(
        verifyRekorAttestations({
          sha256: ARTIFACT_SHA,
          repo: "cli/cli",
          expect: expect_fixture,
          client: fakeRekorClient({ searchResult: uuids, entries }),
          verifier: stubVerifier,
          maxEntries: 10,
        }),
      ).rejects.toMatchObject({ kind: "rekor-not-found" });
    });

    it("throws `rekor-not-found` in mixed case: one lag + one verify-fail", async ({ expect }) => {
      // Workflow re-run: new (correct) attestation still replicating while
      // an older OID-mismatch entry fetches. Must retry, not give up.
      const entries = new Map<string, FakeOutcome>([
        ["old", { kind: "entry", entry: BOGUS_ENTRY }],
        [
          "new",
          { kind: "error", error: new RekorError({ kind: "lag", uuid: "new", message: "lag" }) },
        ],
      ]);
      await expect(
        verifyRekorAttestations({
          sha256: ARTIFACT_SHA,
          repo: "cli/cli",
          expect: expect_fixture,
          client: fakeRekorClient({ searchResult: ["old", "new"], entries }),
          verifier: neverMatchVerifier,
          maxEntries: 10,
        }),
      ).rejects.toMatchObject({ kind: "rekor-not-found" });
    });

    it("throws `Rekor unavailable` when every entry 5xx'd (no lag, no verify)", async ({
      expect,
    }) => {
      const entries = new Map<string, FakeOutcome>([
        [
          "u1",
          {
            kind: "error",
            error: new RekorError({ kind: "unavailable", uuid: "u1", message: "5xx" }),
          },
        ],
        [
          "u2",
          {
            kind: "error",
            error: new RekorError({ kind: "unavailable", uuid: "u2", message: "5xx" }),
          },
        ],
      ]);
      await expect(
        verifyRekorAttestations({
          sha256: ARTIFACT_SHA,
          repo: "cli/cli",
          expect: expect_fixture,
          client: fakeRekorClient({ searchResult: ["u1", "u2"], entries }),
          verifier: stubVerifier,
          maxEntries: 10,
        }),
      ).rejects.toThrow(/Rekor unavailable/);
    });

    it("throws plain ProvenanceError when every entry verify-failed (deterministic)", async ({
      expect,
    }) => {
      const entries = new Map<string, FakeOutcome>([
        ["u1", { kind: "entry", entry: BOGUS_ENTRY }],
        ["u2", { kind: "entry", entry: BOGUS_ENTRY }],
      ]);
      const thrown = await verifyRekorAttestations({
        sha256: ARTIFACT_SHA,
        repo: "cli/cli",
        expect: expect_fixture,
        client: fakeRekorClient({ searchResult: ["u1", "u2"], entries }),
        verifier: neverMatchVerifier,
        maxEntries: 10,
      }).catch((e) => e as unknown);
      expect(thrown).toBeInstanceOf(ProvenanceError);
      expect((thrown as ProvenanceError).kind).toBe("other");
      expect((thrown as ProvenanceError).message).toMatch(/none matched/);
    });
  });
}
