// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Rekor transparency log verification internals.
 * Searches entries by artifact sha256, reconstructs a sigstore Bundle
 * from the Rekor response, hands it to `@sigstore/verify.Verifier` for
 * signature + tlog + cert-chain checks, then pins cert OIDs on top.
 *
 * Two trust-binding steps are explicit in this file:
 *   1. Subject-digest binding — the in-toto Statement's `subject.digest`
 *      must equal the artifact sha we searched for. Without this check,
 *      Rekor's multi-hash index could return an entry for a different
 *      artifact whose envelope hash collided with our search key.
 *   2. OID pinning — see `certificates.ts`.
 */

import { X509Certificate as NodeX509 } from "node:crypto";

import type { SerializedBundle } from "@sigstore/bundle";
import { X509Certificate } from "@sigstore/core";
import dedent from "dedent";

import { fetchWithRetry } from "../http.ts";
import type { BundleVerifier, GitHubRepo, Sha256Hex } from "../types.ts";
import { errorMessage } from "../util/error.ts";
import { readJsonBounded } from "../util/json.ts";
import { log, warn } from "../util/log.ts";
import { ProvenanceError, isProvenanceError } from "../util/provenance-error.ts";
import { evalTemplate } from "../util/template.ts";
import {
  getExtensionValue,
  verifyCertificateOIDs,
  type CertificateOIDExpectations,
} from "./certificates.ts";
import type { ResolvedConfig } from "./config.ts";
import { REKOR_NETWORK_ADVICE } from "./constants.ts";
import {
  DsseEnvelopeSchema,
  InTotoStatementSchema,
  RekorDsseBodySchema,
  RekorLogEntrySchema,
  RekorSearchResponseSchema,
  type RekorLogEntry,
} from "./schemas.ts";

const BUNDLE_V03_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json";
const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";

/**
 * Extract the HTTP status code from an error raised by `fetchRekorEntry`
 * or `fetchWithRetry`, if present. Both paths attach `statusCode` on
 * `err.cause` (see http.ts retry path and `fetchRekorEntry`'s throw).
 * Returns `undefined` for network/timeout errors without a status.
 */
function fetchStatusCode(err: unknown): number | undefined {
  const cause = (err as { cause?: { statusCode?: unknown } })?.cause;
  return typeof cause?.statusCode === "number" ? cause.statusCode : undefined;
}

async function searchRekorEntries(sha256: Sha256Hex, config: ResolvedConfig): Promise<string[]> {
  const response = await fetchWithRetry(config.rekorSearchUrl, {
    ...config,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hash: `sha256:${sha256}` }),
  });
  if (response.statusCode >= 400) {
    await response.body.dump();
    throw new Error(dedent`
      Rekor search failed: ${response.statusCode}.
      ${REKOR_NETWORK_ADVICE}
    `);
  }
  return RekorSearchResponseSchema.parse(
    await readJsonBounded(response.body, config.maxJsonResponseBytes),
  );
}

async function fetchRekorEntry(uuid: string, config: ResolvedConfig): Promise<RekorLogEntry> {
  const url = evalTemplate(config.rekorEntryUrl, { uuid });
  // Rekor's search index commits UUIDs faster than the per-entry endpoint
  // replicates them: search returns a UUID while a subsequent GET /entries/
  // still 404s for ~seconds. `retryOn404: true` absorbs that window through
  // `fetchWithRetry`'s in-band backoff; longer lags are caught by the
  // outer `withRekorIngestionRetry` which distinguishes lag (404) from
  // server errors (5xx) on the aggregate below.
  const response = await fetchWithRetry(url, { ...config, retryOn404: true });
  if (response.statusCode >= 400) {
    await response.body.dump();
    // Attach statusCode on the cause so the aggregate can split lag (404)
    // from server errors (5xx) without parsing the message.
    const cause = new Error(`HTTP ${response.statusCode}`);
    Object.assign(cause, { statusCode: response.statusCode });
    throw new Error(
      dedent`
        failed to fetch Rekor entry ${uuid}: ${response.statusCode}.
        ${REKOR_NETWORK_ADVICE}
      `,
      { cause },
    );
  }
  const data = RekorLogEntrySchema.parse(
    await readJsonBounded(response.body, config.maxJsonResponseBytes),
  );
  // Look up by the UUID we requested rather than taking the first value:
  // an MITM or future Rekor schema change that returns multiple keys in
  // one response must not let an attacker-reordered entry win. The
  // response-key-order-matters assumption is fragile.
  const entry = data[uuid];
  if (!entry) {
    throw new Error(dedent`
      Rekor response did not contain the requested entry ${uuid}.
      Keys returned: ${Object.keys(data).join(", ") || "(none)"}.
      ${REKOR_NETWORK_ADVICE}
    `);
  }
  return entry;
}

/**
 * Decode and validate a Rekor entry into the shape the sigstore Verifier
 * expects, and enforce the subject-digest binding that Rekor's search
 * index alone does not guarantee.
 *
 * Returns the reconstructed Bundle plus the Fulcio cert for downstream
 * OID pinning. Throws on any shape mismatch or subject-digest mismatch.
 */
function parseRekorEntry(
  entry: RekorLogEntry,
  expectedSha256: Sha256Hex,
): {
  bundle: SerializedBundle;
  cert: X509Certificate;
} {
  // 1. Decode the canonicalized body to learn the entry kind and grab the
  //    embedded Fulcio cert. Cert is base64(PEM) inside signatures[0].verifier.
  const bodyBuf = Buffer.from(entry.body, "base64");
  const parsed = RekorDsseBodySchema.parse(JSON.parse(bodyBuf.toString("utf8")));
  const sig = parsed.spec.signatures[0];
  if (!sig) {
    throw new Error("Rekor DSSE entry has no signatures");
  }
  const certPem = Buffer.from(sig.verifier, "base64").toString("utf8");
  const certDerB64 = new NodeX509(certPem).raw.toString("base64");

  // 2. Decode the full DSSE envelope from `attestation.data`. Rekor's body
  //    carries only hashes, so the Statement payload lives here.
  const envelopeJson = JSON.parse(Buffer.from(entry.attestation.data, "base64").toString("utf8"));
  const envelope = DsseEnvelopeSchema.parse(envelopeJson);

  // 3. Subject-digest binding. Parse the in-toto Statement and require at
  //    least one subject whose sha256 digest equals the artifact sha we
  //    searched Rekor for. This is the single defence against a hash
  //    collision in Rekor's multi-hash index landing us on a DSSE entry
  //    that attests a different artifact.
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

  // 4. Build a sigstore Bundle from the Rekor response. The Verifier then
  //    performs DSSE-signature + Rekor SET + Fulcio-chain checks in one
  //    pass, using the TUF-anchored trust material loaded by the caller.
  const serialized: SerializedBundle = {
    mediaType: BUNDLE_V03_MEDIA_TYPE,
    verificationMaterial: {
      // OneOf enforces mutual exclusivity with explicit undefined siblings.
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

  // `in-toto` is the only envelope shape we attest. Belt-and-suspenders
  // check — the DSSE signature covers payloadType via PAE, so a mismatch
  // would also fail Verifier, but we want a clear error earlier.
  if (envelope.payloadType !== IN_TOTO_PAYLOAD_TYPE) {
    throw new Error(`Rekor entry DSSE payloadType is not in-toto: got ${envelope.payloadType}`);
  }

  return {
    bundle: serialized,
    // `X509Certificate.parse` accepts a PEM string or a DER Buffer; pass PEM
    // so the pem→der conversion happens inside @sigstore/core, not here.
    cert: X509Certificate.parse(certPem),
  };
}

/**
 * Verify that a Rekor entry exists for the given sha256 whose signing
 * certificate matches all expected OIDs — issuer, source repo, commit,
 * ref, run invocation URI, and Build Signer URI.
 *
 * @throws {@link ProvenanceError} when no Rekor entry matches.
 * @throws `Error` on transient failures (network, Rekor unavailable)
 *   — safe to retry.
 */
export async function verifyRekorAttestations(options: {
  sha256: Sha256Hex;
  repo: GitHubRepo;
  expect: CertificateOIDExpectations;
  config: ResolvedConfig;
  verifier: BundleVerifier;
}): Promise<void> {
  const { sha256, repo, expect, config, verifier } = options;

  log(`searching Rekor for ${sha256}`);
  const uuids = await searchRekorEntries(sha256, config);

  if (uuids.length === 0) {
    throw new ProvenanceError(
      dedent`
        No Rekor entry found for artifact hash ${sha256}.
        The artifact may have been tampered with, or the publish workflow
        did not attest it via the reusable publish.yaml.
      `,
      { kind: "rekor-not-found" },
    );
  }

  // Rekor returns oldest-first. Take the newest N — most likely to match
  // the current release. If an attacker floods entries past this window,
  // verification fails closed (see MAX_REKOR_ENTRIES doc comment for the
  // threat-model rationale).
  const capped = config.maxRekorEntries > 0 ? uuids.slice(-config.maxRekorEntries) : uuids;
  if (uuids.length > capped.length) {
    warn(
      `Rekor returned ${uuids.length} entries for ${sha256}; only checking the newest ` +
        `${capped.length}. If verification fails, this may indicate an attacker ` +
        `is flooding the log with fake entries for this hash.`,
    );
  }
  let lagFailures = 0; // 404 on the per-entry endpoint — ingestion lag.
  let serverFailures = 0; // 5xx / network / other non-404 fetch errors.
  let verifyFailures = 0;

  for (const uuid of capped) {
    let entry: RekorLogEntry;
    try {
      entry = await fetchRekorEntry(uuid, config);
    } catch (err) {
      if (fetchStatusCode(err) === 404) lagFailures++;
      else serverFailures++;
      log(`Rekor entry ${uuid} fetch failed: ${errorMessage(err)}`);
      continue;
    }

    try {
      // Parse + subject-digest binding (throws if the Statement's subjects
      // don't claim the artifact sha we searched for).
      const { bundle, cert } = parseRekorEntry(entry, sha256);

      // DSSE signature + Rekor SET + Fulcio cert chain, all at once. No
      // policy argument: identity pinning is done by our OID check below,
      // which applies a stricter Build Signer URI pattern than Verifier's
      // simple SAN exact-match would.
      verifier.verify(bundle);

      // Tight OID pins on top of the sigstore-side checks.
      verifyCertificateOIDs(cert, repo, expect);
      return;
    } catch (err) {
      if (isProvenanceError(err)) {
        // OID mismatch: log but keep trying — multiple Rekor entries may
        // share a hash (rebuilds) and only one needs to match.
        verifyFailures++;
        log(`Rekor entry ${uuid} OID check failed: ${err.message}`);
        continue;
      }
      verifyFailures++;
      log(`Rekor entry ${uuid} failed verification: ${errorMessage(err)}`);
    }
  }

  const n = capped.length;
  if (lagFailures > 0) {
    // At least one candidate UUID 404'd after exhausting in-band retries
    // — matches the ingestion-lag shape. Must trigger even when some
    // entries fetched and verify-failed: workflow re-runs produce multiple
    // attestations for the same hash, and the new (correct) one may still
    // be lagging while an older (mismatched-OID) one verify-fails. Surface
    // as `rekor-not-found` so the outer `withRekorIngestionRetry` waits
    // and retries.
    throw new ProvenanceError(
      dedent`
        Failed to fetch ${lagFailures} of ${n} Rekor transparency log entries for this artifact (404, likely ingestion lag).
        ${REKOR_NETWORK_ADVICE}
      `,
      { kind: "rekor-not-found" },
    );
  }
  if (serverFailures > 0 && verifyFailures === 0) {
    // Pure server/network unreachability — not a verification failure.
    // Don't mislabel as `rekor-not-found` (would trigger 30s of retries
    // under a wrong diagnosis); the outer layer already retried on 5xx.
    throw new Error(
      dedent`
        Rekor unavailable: ${serverFailures} of ${n} entries failed to fetch (non-404).
        ${REKOR_NETWORK_ADVICE}
      `,
    );
  }

  const totalFailures = verifyFailures + serverFailures;
  const detail =
    totalFailures === n
      ? dedent`
          All ${n} Rekor entries failed verification.
          This may indicate an outdated sigstore trust root, a tampered
          attestation, or a wrong Build Signer URI pin.
        `
      : dedent`
          ${n} Rekor entries found, none matched the expected workflow run
          (${expect.runInvocationURI}) or signer pattern.
        `;
  throw new ProvenanceError(dedent`
    Addon provenance verification failed.
    ${detail}
  `);
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;
  const { sha256Hex, runInvocationURI: runInvocationURIFn } = await import("../types.ts");
  const { mockFetch } = await import("../../tests/helpers/mock-fetch.ts");
  const { resolveConfig } = await import("./config.ts");
  const { DEFAULT_ATTEST_SIGNER_PATTERN, OID_SOURCE_REPO_URI } = await import("./constants.ts");

  /** Verifier stub that never runs: tests here don't reach the crypto path. */
  const stubVerifier: BundleVerifier = {
    verify: () => {
      throw new Error("stubVerifier: verify should not be called");
    },
  };

  const expect_fixture = {
    sourceCommit: "deadbeef".repeat(5),
    sourceRef: "refs/tags/v0.0.0",
    runInvocationURI: runInvocationURIFn(
      "https://github.com/cli/cli/actions/runs/22312430014/attempts/4",
    ),
    attestSignerPattern: DEFAULT_ATTEST_SIGNER_PATTERN,
  };

  // Serialized copy of real Rekor entry 108e9186e8... for cli/cli (immutable).
  // `attestation.data` is supplied by `fixtureEntry()` below with a Statement
  // synthesized per-test; the real captured attestation lives in the
  // SLSA_LIVE_INTEGRATION test suite.
  const FIXTURE_ENTRY: Omit<RekorLogEntry, "attestation"> = {
    body: "eyJhcGlWZXJzaW9uIjoiMC4wLjEiLCJraW5kIjoiZHNzZSIsInNwZWMiOnsiZW52ZWxvcGVIYXNoIjp7ImFsZ29yaXRobSI6InNoYTI1NiIsInZhbHVlIjoiNzJjZDliMjQ5YTAwOWIyOWZiN2MxMTVhNjVlMzIxMjc0ZjVhMzllNmFhZTlhYmQyMDQxYTdmZWYzZDMxN2QyNSJ9LCJwYXlsb2FkSGFzaCI6eyJhbGdvcml0aG0iOiJzaGEyNTYiLCJ2YWx1ZSI6IjM4MzI1NjU0OTY2MWYwOGY3N2Q0MmM0YzJjNTBhNWMwZmVlZWI4NTZjNjU2NTExY2EzNGE2Nzk1ZGRkNTJjZmYifSwic2lnbmF0dXJlcyI6W3sic2lnbmF0dXJlIjoiTUVVQ0lRRE5ySEVuM2VKbTRZcTZJeTd6ZmsvVFVSRGJpNDhIZTBZUTA0OTgydjdBbUFJZ09KN3ByOHZ4QXhYWkcxR1p2b29sbGF0NHJlV0ptTGlqMW0xQW14UjVVVXc9IiwidmVyaWZpZXIiOiJMUzB0TFMxQ1JVZEpUaUJEUlZKVVNVWkpRMEZVUlMwdExTMHRDazFKU1VkeFJFTkRRbWtyWjBGM1NVSkJaMGxWWlVsME16RmlaM1ZqUlZkVmNuQlVTbkZNY1V0VUt6aFJhelJaZDBObldVbExiMXBKZW1vd1JVRjNUWGNLVG5wRlZrMUNUVWRCTVZWRlEyaE5UV015Ykc1ak0xSjJZMjFWZFZwSFZqSk5ValIzU0VGWlJGWlJVVVJGZUZaNllWZGtlbVJIT1hsYVV6RndZbTVTYkFwamJURnNXa2RzYUdSSFZYZElhR05PVFdwWmQwMXFTWHBOVkd0NFRVUlZlVmRvWTA1TmFsbDNUV3BKZWsxVWEzbE5SRlY1VjJwQlFVMUdhM2RGZDFsSUNrdHZXa2w2YWpCRFFWRlpTVXR2V2tsNmFqQkVRVkZqUkZGblFVVktOemgwZDBaVWFHUmtXVTlyU2pjeU5uTmlWVUV3ZGxWV2N6ZEljV1kzUW05SksxZ0tXVGRPZEc1aFUwcFlha2x6V2tOeFdHdEtVbEIzUTJSSWMzVTFlV1ppWTFjdlRWUXhaekJPVDA4NFJqRm5PVmRyUm1GUFEwSlZOSGRuWjFaTFRVRTBSd3BCTVZWa1JIZEZRaTkzVVVWQmQwbElaMFJCVkVKblRsWklVMVZGUkVSQlMwSm5aM0pDWjBWR1FsRmpSRUY2UVdSQ1owNVdTRkUwUlVablVWVm1VR0pqQ2pZeVFqQkdPRGxNUVVGcldtbERjVWh6VkRCMFVEZG5kMGgzV1VSV1VqQnFRa0puZDBadlFWVXpPVkJ3ZWpGWmEwVmFZalZ4VG1wd1MwWlhhWGhwTkZrS1drUTRkMWRuV1VSV1VqQlNRVkZJTDBKR1FYZFViMXBOWVVoU01HTklUVFpNZVRsdVlWaFNiMlJYU1hWWk1qbDBUREpPYzJGVE9XcGlSMnQyVEcxa2NBcGtSMmd4V1drNU0ySXpTbkphYlhoMlpETk5kbHBIVm5kaVJ6azFZbGRXZFdSRE5UVmlWM2hCWTIxV2JXTjVPVzlhVjBaclkzazVNR051Vm5WaGVrRTFDa0puYjNKQ1owVkZRVmxQTDAxQlJVSkNRM1J2WkVoU2QyTjZiM1pNTTFKMllUSldkVXh0Um1wa1IyeDJZbTVOZFZveWJEQmhTRlpwWkZoT2JHTnRUbllLWW01U2JHSnVVWFZaTWpsMFRVSTRSME5wYzBkQlVWRkNaemM0ZDBGUlNVVkZXR1IyWTIxMGJXSkhPVE5ZTWxKd1l6TkNhR1JIVG05TlJGbEhRMmx6UndwQlVWRkNaemM0ZDBGUlRVVkxSMDV0VDBSWmVWcEVXVEZhUjFreldtcG9iVnBxVlhsUFJFRjRUbGRWZVUxNlZtcFBSMDVxV1RKUk1FOUhUbXhaVkVrMENrNXRXWGRIUVZsTFMzZFpRa0pCUjBSMmVrRkNRa0ZSUzFKSFZuZGlSemsxWWxkV2RXUkVRVlpDWjI5eVFtZEZSVUZaVHk5TlFVVkdRa0ZrYW1KSGEzWUtXVEo0Y0UxQ05FZERhWE5IUVZGUlFtYzNPSGRCVVZsRlJVaEtiRnB1VFhaaFIxWm9Xa2hOZG1SSVNqRmliWE4zVDNkWlMwdDNXVUpDUVVkRWRucEJRZ3BEUVZGMFJFTjBiMlJJVW5kamVtOTJURE5TZG1FeVZuVk1iVVpxWkVkc2RtSnVUWFZhTW13d1lVaFdhV1JZVG14amJVNTJZbTVTYkdKdVVYVlpNamwwQ2sxR2QwZERhWE5IUVZGUlFtYzNPSGRCVVd0RlZHZDRUV0ZJVWpCalNFMDJUSGs1Ym1GWVVtOWtWMGwxV1RJNWRFd3lUbk5oVXpscVlrZHJka3h0WkhBS1pFZG9NVmxwT1ROaU0wcHlXbTE0ZG1RelRYWmFSMVozWWtjNU5XSlhWblZrUXpVMVlsZDRRV050Vm0xamVUbHZXbGRHYTJONU9UQmpibFoxWVhwQk5BcENaMjl5UW1kRlJVRlpUeTlOUVVWTFFrTnZUVXRIVG0xUFJGbDVXa1JaTVZwSFdUTmFhbWh0V21wVmVVOUVRWGhPVjFWNVRYcFdhazlIVG1wWk1sRXdDazlIVG14WlZFazBUbTFaZDBoUldVdExkMWxDUWtGSFJIWjZRVUpEZDFGUVJFRXhibUZZVW05a1YwbDBZVWM1ZW1SSFZtdE5RMjlIUTJselIwRlJVVUlLWnpjNGQwRlJkMFZJUVhkaFlVaFNNR05JVFRaTWVUbHVZVmhTYjJSWFNYVlpNamwwVERKT2MyRlRPV3BpUjJ0M1QwRlpTMHQzV1VKQ1FVZEVkbnBCUWdwRVVWRnhSRU5vYWxwcVp6Sk5iVkV5VGxkU2JVNHlXVFJhYlZreFRXcG5kMDFVVm14TmFrMHhXWHBvYWxreVRtdE9SR2hxV2xkRmVVOUVXbTFOUTBGSENrTnBjMGRCVVZGQ1p6YzRkMEZSTkVWRlozZFJZMjFXYldONU9XOWFWMFpyWTNrNU1HTnVWblZoZWtGYVFtZHZja0puUlVWQldVOHZUVUZGVUVKQmMwMEtRMVJKZUUxcVdYaE5la0V3VDFSQmJVSm5iM0pDWjBWRlFWbFBMMDFCUlZGQ1FtZE5SbTFvTUdSSVFucFBhVGgyV2pKc01HRklWbWxNYlU1MllsTTVhZ3BpUjJ0M1IwRlpTMHQzV1VKQ1FVZEVkbnBCUWtWUlVVdEVRV2N4VDFSamQwNUVZM2hOVkVKalFtZHZja0puUlVWQldVOHZUVUZGVTBKRk5FMVVSMmd3Q21SSVFucFBhVGgyV2pKc01HRklWbWxNYlU1MllsTTVhbUpIYTNaWk1uaHdUSGsxYm1GWVVtOWtWMGwyWkRJNWVXRXlXbk5pTTJSNlRESlNiR05IZUhZS1pWY3hiR0p1VVhWbFZ6RnpVVWhLYkZwdVRYWmhSMVpvV2toTmRtUklTakZpYlhOM1QwRlpTMHQzV1VKQ1FVZEVkbnBCUWtWM1VYRkVRMmhxV21wbk1ncE5iVkV5VGxkU2JVNHlXVFJhYlZreFRXcG5kMDFVVm14TmFrMHhXWHBvYWxreVRtdE9SR2hxV2xkRmVVOUVXbTFOUTBWSFEybHpSMEZSVVVKbk56aDNDa0ZTVVVWRmQzZFNaREk1ZVdFeVduTmlNMlJtV2tkc2VtTkhSakJaTW1kM1ZHZFpTMHQzV1VKQ1FVZEVkbnBCUWtaUlVrRkVSRFZ2WkVoU2QyTjZiM1lLVERKa2NHUkhhREZaYVRWcVlqSXdkbGt5ZUhCTU1rNXpZVk01YUZrelVuQmlNalY2VEROS01XSnVUWFpOYWtsNlRWUkpNRTE2UVhkTlZGRjJXVmhTTUFwYVZ6RjNaRWhOZGs1RVFWZENaMjl5UW1kRlJVRlpUeTlOUVVWWVFrRm5UVUp1UWpGWmJYaHdXWHBCWVVKbmIzSkNaMFZGUVZsUEwwMUJSVmhDUVhkTkNrTnVRbmxpTWxJeFdUTlNjR0l5TkhkbldXdEhRMmx6UjBGUlVVSXhibXREUWtGSlJXVjNValZCU0dOQlpGRkVaRkJVUW5GNGMyTlNUVzFOV2tob2VWb0tXbnBqUTI5cmNHVjFUalE0Y21ZclNHbHVTMEZNZVc1MWFtZEJRVUZhZVV3MlZuazBRVUZCUlVGM1FrZE5SVkZEU1VZemVqSjZZakkyVDJKeGJuVTVPUXBKYkV3M1ZUSlROWHBZZDNreldHZEhLMmhrU0VKa1QxbE1Vako1UVdsQ1RVMUdXRmczVkM5WlJVTmFiV3BwVldrd1kzUXZRbmdyT1M5U05WQlhkWHB0Q21FMU5XVmFjazlhUVZSQlMwSm5aM0ZvYTJwUFVGRlJSRUYzVG01QlJFSnJRV3BDZERKbkwwSXJWR2xOY0RKSFpXZDFTQzlVZGtOV1JYSnNZMlJDUlZZS01XRldSMkZLWTBocFVUSlJVekp3V0ZaWFlqVktTbmh4Y0VoUk9YTmxXakp2Y1VsRFRVZFNVazlDTW1nMGNFTm1jR3BTT0hNdlZrbGliREJGYldaMlRRb3pWa1JGT1hsbU9VeGthR2xpVjNCUFZreGpTM2RqZWtGTWEyNUtZbUp1WldOb1NITTBaejA5Q2kwdExTMHRSVTVFSUVORlVsUkpSa2xEUVZSRkxTMHRMUzBLIn1dfX0=",
    integratedTime: 1771873852,
    logID: "c0d23d6ad406973f9559f3ba2d1ca01f84147d8ffc5b8445c224f98b9591801d",
    logIndex: 983591891,
    verification: {
      inclusionProof: {
        checkpoint: "x\n1\nr=\n\n— k v==\n",
        hashes: ["aa".repeat(32)],
        logIndex: 1,
        rootHash: "aa".repeat(32),
        treeSize: 2,
      },
      signedEntryTimestamp: "AA==",
    },
  };

  const ARTIFACT_SHA = sha256Hex("c".repeat(64));

  /**
   * Build an `attestation.data` field carrying a DSSE envelope whose
   * in-toto Statement subject digest is `subjectSha`. Signatures are
   * placeholder bytes — Verifier is stubbed in these unit tests; real
   * signature + tlog + chain checks are exercised by the integration
   * test fixtures captured from real publish runs.
   */
  function buildAttestationData(subjectSha: string, payloadType = IN_TOTO_PAYLOAD_TYPE): string {
    const statement = {
      _type: "https://in-toto.io/Statement/v0.1",
      subject: [{ name: "addon", digest: { sha256: subjectSha } }],
      predicateType: "https://slsa.dev/provenance/v1",
      predicate: {},
    };
    const envelope = {
      payloadType,
      payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
      signatures: [{ sig: Buffer.from("fake-sig").toString("base64"), keyid: "" }],
    };
    return Buffer.from(JSON.stringify(envelope)).toString("base64");
  }

  function fixtureEntry(attestationData = buildAttestationData(ARTIFACT_SHA)): RekorLogEntry {
    return { ...FIXTURE_ENTRY, attestation: { data: attestationData } };
  }

  describe("parseRekorEntry", () => {
    it("accepts an entry whose Statement subject digest matches the artifact sha", ({ expect }) => {
      const { bundle, cert } = parseRekorEntry(fixtureEntry(), ARTIFACT_SHA);
      expect(getExtensionValue(cert, OID_SOURCE_REPO_URI)).toBe("https://github.com/cli/cli");
      expect(bundle.dsseEnvelope).toBeDefined();
      expect(bundle.mediaType).toBe(BUNDLE_V03_MEDIA_TYPE);
    });

    it("rejects an entry whose Statement does not attest the requested artifact", ({ expect }) => {
      // Subject-digest binding: Rekor's multi-hash index may return an
      // entry that hashes match for some coincidental reason; the Statement
      // subject is the only field that binds the cert to *our* artifact.
      const wrongSubject = sha256Hex("0".repeat(64));
      expect(() => parseRekorEntry(fixtureEntry(), wrongSubject)).toThrow(
        /Rekor entry Statement does not attest the requested artifact/,
      );
    });

    it("rejects non-in-toto DSSE payloadType", ({ expect }) => {
      // Defense in depth. DSSE signatures cover payloadType via PAE, so a
      // tampered type would also fail the Verifier, but this check fires
      // earlier and with a clearer message.
      const attData = buildAttestationData(ARTIFACT_SHA, "application/vnd.other+json");
      expect(() => parseRekorEntry(fixtureEntry(attData), ARTIFACT_SHA)).toThrow(
        /payloadType is not in-toto/,
      );
    });

    it("rejects a Statement whose subject digest has the wrong length", ({ expect }) => {
      const badStatement = {
        _type: "https://in-toto.io/Statement/v0.1",
        subject: [{ name: "addon", digest: { sha256: "a".repeat(63) } }],
        predicateType: "https://slsa.dev/provenance/v1",
      };
      const envelope = {
        payloadType: IN_TOTO_PAYLOAD_TYPE,
        payload: Buffer.from(JSON.stringify(badStatement)).toString("base64"),
        signatures: [{ sig: "AA==", keyid: "" }],
      };
      const attData = Buffer.from(JSON.stringify(envelope)).toString("base64");
      expect(() => parseRekorEntry(fixtureEntry(attData), ARTIFACT_SHA)).toThrow();
    });

    it("rejects non-dsse entry kind", ({ expect }) => {
      const bad: RekorLogEntry = {
        ...fixtureEntry(),
        body: btoa(JSON.stringify({ apiVersion: "0.0.1", kind: "hashedrekord", spec: {} })),
      };
      expect(() => parseRekorEntry(bad, ARTIFACT_SHA)).toThrow();
    });

    it("throws when DSSE body has empty signatures array", ({ expect }) => {
      const noSigs: RekorLogEntry = {
        ...fixtureEntry(),
        body: btoa(
          JSON.stringify({
            apiVersion: "0.0.1",
            kind: "dsse",
            spec: {
              envelopeHash: { algorithm: "sha256", value: "a".repeat(64) },
              payloadHash: { algorithm: "sha256", value: "b".repeat(64) },
              signatures: [],
            },
          }),
        ),
      };
      expect(() => parseRekorEntry(noSigs, ARTIFACT_SHA)).toThrow();
    });
  });

  describe("searchRekorEntries", () => {
    it("POSTs correct body", async ({ expect }) => {
      let body: unknown;
      await using dispatcher = mockFetch((opts) => {
        body = opts.body;
        return { statusCode: 200, data: "[]" };
      });
      await searchRekorEntries(
        sha256Hex("a".repeat(64)),
        resolveConfig({ signal: undefined, dispatcher }),
      );
      expect(JSON.parse(String(body))).toEqual({ hash: `sha256:${"a".repeat(64)}` });
    });

    it("throws on non-ok response", async ({ expect }) => {
      await using dispatcher = mockFetch(() => ({ statusCode: 400, data: "" }));
      await expect(
        searchRekorEntries(sha256Hex("a".repeat(64)), resolveConfig({ dispatcher })),
      ).rejects.toThrow(/Rekor search failed/);
    });
  });

  describe("verifyRekorAttestations", () => {
    it("uses the injected BundleVerifier (no implicit sigstore.Verifier)", async ({ expect }) => {
      // Locks the `verifier` injection contract: callers can substitute a
      // verifier; the default is never silently re-created in this path.
      let called = 0;
      const injected: BundleVerifier = {
        verify: () => {
          called++;
          throw new Error("injected verifier saw the bundle");
        },
      };
      await using dispatcher = mockFetch((opts) => {
        if (opts.path.includes("/index/retrieve")) {
          return { statusCode: 200, data: JSON.stringify(["aa".repeat(32)]) };
        }
        return {
          statusCode: 200,
          data: JSON.stringify({
            ["aa".repeat(32)]: fixtureEntry(),
          }),
        };
      });
      await expect(
        verifyRekorAttestations({
          sha256: sha256Hex(ARTIFACT_SHA),
          repo: "o/r",
          expect: expect_fixture,
          config: resolveConfig({ dispatcher }),
          verifier: injected,
        }),
      ).rejects.toThrow();
      expect(called).toBe(1);
    });

    it("throws ProvenanceError when no entries found", async ({ expect }) => {
      await using dispatcher = mockFetch(() => ({ statusCode: 200, data: "[]" }));
      await expect(
        verifyRekorAttestations({
          sha256: sha256Hex("a".repeat(64)),
          repo: "o/r",
          expect: expect_fixture,
          config: resolveConfig({ dispatcher }),
          verifier: stubVerifier,
        }),
      ).rejects.toThrow(/No Rekor entry found/);
    });

    it("throws `Rekor unavailable` when every entry fetch returns 5xx", async ({ expect }) => {
      // 5xx is server-side, not ingestion lag. Must NOT be labelled
      // `rekor-not-found` — that would trigger 30s of misleading retries.
      await using dispatcher = mockFetch((opts) => {
        if (opts.path.includes("/index/retrieve")) {
          return {
            statusCode: 200,
            data: JSON.stringify(["aa".repeat(32), "bb".repeat(32)]),
          };
        }
        return { statusCode: 500, data: "" };
      }, 20);
      await expect(
        verifyRekorAttestations({
          sha256: sha256Hex("a".repeat(64)),
          repo: "o/r",
          expect: expect_fixture,
          config: resolveConfig({ dispatcher, retryBaseMs: 1 }),
          verifier: stubVerifier,
        }),
      ).rejects.toThrow(/Rekor unavailable/);
    });
  });

  describe("fetchRekorEntry", () => {
    it("throws when response lacks the requested UUID", async ({ expect }) => {
      await using dispatcher = mockFetch(() => ({
        statusCode: 200,
        data: JSON.stringify({}),
      }));
      await expect(fetchRekorEntry("deadbeef", resolveConfig({ dispatcher }))).rejects.toThrow(
        /Rekor response did not contain the requested entry deadbeef/,
      );
    });

    it("throws when response contains a DIFFERENT UUID (proxy-reorder guard)", async ({
      expect,
    }) => {
      // Security property: if an MITM or schema-change returns entries
      // keyed by UUIDs other than what we asked for, we must not blindly
      // trust the first value. Response is structurally valid (passes Zod)
      // but keyed under a UUID the caller didn't request.
      await using dispatcher = mockFetch(() => ({
        statusCode: 200,
        data: JSON.stringify({ "different-uuid": fixtureEntry() }),
      }));
      await expect(
        fetchRekorEntry("asked-for-uuid", resolveConfig({ dispatcher })),
      ).rejects.toThrow(/Rekor response did not contain the requested entry asked-for-uuid/);
    });

    it("retries past transient 404s (propagation lag after upload)", async ({ expect }) => {
      // Rekor search indexes a UUID before the per-entry endpoint serves it;
      // without retryOn404, a freshly uploaded attestation 404s on GET for
      // seconds and we give up on the first attempt.
      const uuid = "deadbeef";
      let calls = 0;
      await using dispatcher = mockFetch(() => {
        calls++;
        if (calls < 3) return { statusCode: 404, data: "" };
        return { statusCode: 200, data: JSON.stringify({ [uuid]: fixtureEntry() }) };
      });
      const entry = await fetchRekorEntry(
        uuid,
        resolveConfig({ dispatcher, retryBaseMs: 1, retryCount: 3 }),
      );
      expect(entry).toBeDefined();
      expect(calls).toBe(3);
    });
  });

  describe("verifyRekorAttestations ingestion-lag", () => {
    it("reports `rekor-not-found` when every searched UUID fetch fails", async ({ expect }) => {
      // Search returns UUIDs but the entry endpoint 404s every one of
      // them — looks like ingestion lag, not a real mismatch. Surface as
      // `rekor-not-found` so `withRekorIngestionRetry` waits and retries.
      const uuids = ["a".repeat(80), "b".repeat(80)];
      await using dispatcher = mockFetch(({ path }) => {
        if (path?.includes("index/retrieve")) {
          return { statusCode: 200, data: JSON.stringify(uuids) };
        }
        return { statusCode: 404, data: "" };
      });
      await expect(
        verifyRekorAttestations({
          sha256: ARTIFACT_SHA,
          repo: "cli/cli",
          expect: expect_fixture,
          verifier: stubVerifier,
          config: resolveConfig({ dispatcher, retryBaseMs: 1, retryCount: 0 }),
        }),
      ).rejects.toMatchObject({ kind: "rekor-not-found" });
    });

    it("reports `rekor-not-found` in the mixed case: some fetchable, some lagging", async ({
      expect,
    }) => {
      // Workflow re-runs produce multiple Rekor entries for the same hash.
      // The new (correct) attestation can still be 404ing while an older
      // (OID-mismatch) entry fetches + verify-fails. We must still bubble
      // up `rekor-not-found` so ingestion-retry waits for the new one.
      const [uuidOld, uuidNew] = ["a".repeat(80), "b".repeat(80)];
      await using dispatcher = mockFetch(({ path }) => {
        if (path?.includes("index/retrieve")) {
          return { statusCode: 200, data: JSON.stringify([uuidOld, uuidNew]) };
        }
        if (path?.includes(uuidOld)) {
          // Entry exists and parses; the stub verifier below throws,
          // simulating an OID mismatch from a rebuild or older release.
          return {
            statusCode: 200,
            data: JSON.stringify({ [uuidOld]: fixtureEntry() }),
          };
        }
        // uuidNew: ingestion lag → 404.
        return { statusCode: 404, data: "" };
      });
      const mismatchVerifier: BundleVerifier = {
        verify: () => {
          throw new Error("OID mismatch (simulated)");
        },
      };
      await expect(
        verifyRekorAttestations({
          sha256: ARTIFACT_SHA,
          repo: "cli/cli",
          expect: expect_fixture,
          verifier: mismatchVerifier,
          config: resolveConfig({ dispatcher, retryBaseMs: 1, retryCount: 0 }),
        }),
      ).rejects.toMatchObject({ kind: "rekor-not-found" });
    });
  });
}
