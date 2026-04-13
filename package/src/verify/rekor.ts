// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Rekor transparency log verification internals.
 * Searches entries by artifact hash, verifies tlog inclusion
 * proofs and certificate chains, checks OIDs.
 * Called by {@link verifyAddonProvenance} in verify.ts.
 */

import { X509Certificate } from "@sigstore/core";
import { verifyCertificateChain, verifyTLogInclusion, type TrustMaterial } from "@sigstore/verify";
import type { TransparencyLogEntry } from "@sigstore/bundle";
import dedent from "dedent";

import { fetchWithRetry } from "../http.ts";
import type { GitHubRepo, RunInvocationURI, Sha256Hex } from "../types.ts";
import { readJsonBounded } from "../util/json.ts";
import { log } from "../util/log.ts";
import { ProvenanceError, isProvenanceError } from "../util/provenance-error.ts";
import { evalTemplate } from "../util/template.ts";
import { getExtensionValue, verifyCertificateOIDs } from "./certificates.ts";
import type { ResolvedConfig } from "./config.ts";
import {
  OID_RUN_INVOCATION_URI,
  REKOR_ENTRY_URL,
  REKOR_NETWORK_ADVICE,
  REKOR_SEARCH_URL,
} from "./constants.ts";
import {
  RekorDsseBodySchema,
  RekorLogEntrySchema,
  RekorSearchResponseSchema,
  type RekorLogEntry,
} from "./schemas.ts";

// --- Rekor search + fetch ---

async function searchRekorEntries(sha256: Sha256Hex, config: ResolvedConfig): Promise<string[]> {
  const response = await fetchWithRetry(REKOR_SEARCH_URL, {
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
  const url = evalTemplate(REKOR_ENTRY_URL, { uuid });
  const response = await fetchWithRetry(url, config);
  if (response.statusCode >= 400) {
    await response.body.dump();
    throw new Error(dedent`
      failed to fetch Rekor entry ${uuid}: ${response.statusCode}.
      ${REKOR_NETWORK_ADVICE}
    `);
  }
  const data = RekorLogEntrySchema.parse(
    await readJsonBounded(response.body, config.maxJsonResponseBytes),
  );
  const entry = Object.values(data)[0];
  if (!entry) {
    throw new Error(dedent`
      empty Rekor response for entry ${uuid}.
      This may indicate a Rekor API change.
      Report this issue to the package maintainer.
    `);
  }
  return entry;
}

// --- Entry parsing ---

/**
 * Parse a Rekor entry into the TransparencyLogEntry protobuf type
 * (for @sigstore/verify) and extract the Fulcio leaf certificate.
 * Decodes the base64 body once for both operations.
 */
function parseRekorEntry(entry: RekorLogEntry): {
  tlogEntry: TransparencyLogEntry;
  cert: X509Certificate;
} {
  const bodyBuf = Buffer.from(entry.body, "base64");
  const parsed = RekorDsseBodySchema.parse(JSON.parse(bodyBuf.toString("utf8")));
  const sig = parsed.spec.signatures[0];
  if (!sig) {
    throw new Error("Rekor DSSE entry has no signatures");
  }

  return {
    tlogEntry: {
      logIndex: String(entry.logIndex),
      logId: {
        keyId: Buffer.from(entry.logID, "hex"),
      },
      kindVersion: {
        kind: parsed.kind,
        version: parsed.apiVersion,
      },
      integratedTime: String(entry.integratedTime),
      inclusionPromise: {
        signedEntryTimestamp: Buffer.from(entry.verification.signedEntryTimestamp, "base64"),
      },
      inclusionProof: {
        logIndex: String(entry.verification.inclusionProof.logIndex),
        rootHash: Buffer.from(entry.verification.inclusionProof.rootHash, "hex"),
        treeSize: String(entry.verification.inclusionProof.treeSize),
        hashes: entry.verification.inclusionProof.hashes.map((h) => Buffer.from(h, "hex")),
        checkpoint: {
          envelope: entry.verification.inclusionProof.checkpoint,
        },
      },
      canonicalizedBody: bodyBuf,
    },
    cert: X509Certificate.parse(Buffer.from(sig.verifier, "base64").toString("utf8")),
  };
}

// --- Main verification ---

/**
 * Verify addon provenance against the Rekor transparency log.
 * Searches for entries matching the artifact hash, verifies
 * inclusion proof and certificate chain, then checks certificate
 * OIDs match the expected workflow run and source repository.
 *
 * @throws {@link ProvenanceError} if no entry matches the expected
 *   workflow run or source repository.
 * @throws `Error` on transient failures (network, Rekor unavailable)
 *   — safe to retry.
 */
export async function verifyRekorAttestations(options: {
  sha256: Sha256Hex;
  runInvocationURI: RunInvocationURI;
  repo: GitHubRepo;
  config: ResolvedConfig;
  trustMaterial: TrustMaterial;
}): Promise<void> {
  const { sha256, runInvocationURI, repo, config, trustMaterial } = options;

  log(`searching Rekor for ${sha256}`);
  const uuids = await searchRekorEntries(sha256, config);

  if (uuids.length === 0) {
    throw new ProvenanceError(dedent`
      No Rekor entry found for artifact hash ${sha256}.
      The artifact may have been tampered with, or the publish workflow
      may not use the attest-public action from vadimpiven/node-addon-slsa.
    `);
  }

  // Rekor returns oldest-first. Take the newest N — most likely to match
  // the current release. If an attacker floods entries past this window,
  // verification fails closed (rejects install, does not accept malicious artifacts).
  const capped = config.maxRekorEntries > 0 ? uuids.slice(-config.maxRekorEntries) : uuids;
  let verifyFailures = 0;

  for (const uuid of capped) {
    try {
      const entry = await fetchRekorEntry(uuid, config);
      const { tlogEntry, cert } = parseRekorEntry(entry);
      verifyTLogInclusion(tlogEntry, trustMaterial.tlogs);
      verifyCertificateChain(
        new Date(entry.integratedTime * 1000),
        cert,
        trustMaterial.certificateAuthorities,
      );
      const certRunURI = getExtensionValue(cert, OID_RUN_INVOCATION_URI);
      if (certRunURI === runInvocationURI) {
        verifyCertificateOIDs(cert, repo);
        return;
      }
    } catch (err) {
      if (isProvenanceError(err)) throw err;
      verifyFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      log(`Rekor entry ${uuid} failed verification: ${msg}`);
    }
  }

  const n = capped.length;
  const detail =
    verifyFailures === n
      ? dedent`
          All ${n} Rekor entries failed verification.
          This may indicate a sigstore trust root issue.
          If this persists, report it to the package maintainer.
        `
      : dedent`
          ${n} Rekor entries found, none matched workflow run ${runInvocationURI}.
          The addon may have been rebuilt without re-attesting,
          or the npm package and addon were produced by different workflow runs.
          Verify that both are from the same release.
        `;
  throw new ProvenanceError(dedent`
    Addon provenance verification failed.
    ${detail}
  `);
}

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;
  const { sha256Hex, runInvocationURI: runInvocationURIFn } = await import("../types.ts");
  const { mockFetch } = await import("../../tests/helpers.ts");
  const { resolveConfig } = await import("./config.ts");
  const { OID_SOURCE_REPO_URI } = await import("./constants.ts");

  // Stub trust material for tests where verification never reaches
  // the crypto layer (e.g. all entries fail with HTTP 500).
  const stubTrustMaterial: TrustMaterial = {
    tlogs: [],
    certificateAuthorities: [],
    ctlogs: [],
    timestampAuthorities: [],
    publicKey: () => {
      throw new Error("stubTrustMaterial: publicKey should not be called");
    },
  };

  // Serialized copy of real Rekor entry 108e9186e8... for cli/cli.
  // Immutable (append-only log).
  const FIXTURE_ENTRY: RekorLogEntry = {
    body: "eyJhcGlWZXJzaW9uIjoiMC4wLjEiLCJraW5kIjoiZHNzZSIsInNwZWMiOnsiZW52ZWxvcGVIYXNoIjp7ImFsZ29yaXRobSI6InNoYTI1NiIsInZhbHVlIjoiNzJjZDliMjQ5YTAwOWIyOWZiN2MxMTVhNjVlMzIxMjc0ZjVhMzllNmFhZTlhYmQyMDQxYTdmZWYzZDMxN2QyNSJ9LCJwYXlsb2FkSGFzaCI6eyJhbGdvcml0aG0iOiJzaGEyNTYiLCJ2YWx1ZSI6IjM4MzI1NjU0OTY2MWYwOGY3N2Q0MmM0YzJjNTBhNWMwZmVlZWI4NTZjNjU2NTExY2EzNGE2Nzk1ZGRkNTJjZmYifSwic2lnbmF0dXJlcyI6W3sic2lnbmF0dXJlIjoiTUVVQ0lRRE5ySEVuM2VKbTRZcTZJeTd6ZmsvVFVSRGJpNDhIZTBZUTA0OTgydjdBbUFJZ09KN3ByOHZ4QXhYWkcxR1p2b29sbGF0NHJlV0ptTGlqMW0xQW14UjVVVXc9IiwidmVyaWZpZXIiOiJMUzB0TFMxQ1JVZEpUaUJEUlZKVVNVWkpRMEZVUlMwdExTMHRDazFKU1VkeFJFTkRRbWtyWjBGM1NVSkJaMGxWWlVsME16RmlaM1ZqUlZkVmNuQlVTbkZNY1V0VUt6aFJhelJaZDBObldVbExiMXBKZW1vd1JVRjNUWGNLVG5wRlZrMUNUVWRCTVZWRlEyaE5UV015Ykc1ak0xSjJZMjFWZFZwSFZqSk5ValIzU0VGWlJGWlJVVVJGZUZaNllWZGtlbVJIT1hsYVV6RndZbTVTYkFwamJURnNXa2RzYUdSSFZYZElhR05PVFdwWmQwMXFTWHBOVkd0NFRVUlZlVmRvWTA1TmFsbDNUV3BKZWsxVWEzbE5SRlY1VjJwQlFVMUdhM2RGZDFsSUNrdHZXa2w2YWpCRFFWRlpTVXR2V2tsNmFqQkVRVkZqUkZGblFVVktOemgwZDBaVWFHUmtXVTlyU2pjeU5uTmlWVUV3ZGxWV2N6ZEljV1kzUW05SksxZ0tXVGRPZEc1aFUwcFlha2x6V2tOeFdHdEtVbEIzUTJSSWMzVTFlV1ppWTFjdlRWUXhaekJPVDA4NFJqRm5PVmRyUm1GUFEwSlZOSGRuWjFaTFRVRTBSd3BCTVZWa1JIZEZRaTkzVVVWQmQwbElaMFJCVkVKblRsWklVMVZGUkVSQlMwSm5aM0pDWjBWR1FsRmpSRUY2UVdSQ1owNVdTRkUwUlVablVWVm1VR0pqQ2pZeVFqQkdPRGxNUVVGcldtbERjVWh6VkRCMFVEZG5kMGgzV1VSV1VqQnFRa0puZDBadlFWVXpPVkJ3ZWpGWmEwVmFZalZ4VG1wd1MwWlhhWGhwTkZrS1drUTRkMWRuV1VSV1VqQlNRVkZJTDBKR1FYZFViMXBOWVVoU01HTklUVFpNZVRsdVlWaFNiMlJYU1hWWk1qbDBUREpPYzJGVE9XcGlSMnQyVEcxa2NBcGtSMmd4V1drNU0ySXpTbkphYlhoMlpETk5kbHBIVm5kaVJ6azFZbGRXZFdSRE5UVmlWM2hCWTIxV2JXTjVPVzlhVjBaclkzazVNR051Vm5WaGVrRTFDa0puYjNKQ1owVkZRVmxQTDAxQlJVSkNRM1J2WkVoU2QyTjZiM1pNTTFKMllUSldkVXh0Um1wa1IyeDJZbTVOZFZveWJEQmhTRlpwWkZoT2JHTnRUbllLWW01U2JHSnVVWFZaTWpsMFRVSTRSME5wYzBkQlVWRkNaemM0ZDBGUlNVVkZXR1IyWTIxMGJXSkhPVE5ZTWxKd1l6TkNhR1JIVG05TlJGbEhRMmx6UndwQlVWRkNaemM0ZDBGUlRVVkxSMDV0VDBSWmVWcEVXVEZhUjFreldtcG9iVnBxVlhsUFJFRjRUbGRWZVUxNlZtcFBSMDVxV1RKUk1FOUhUbXhaVkVrMENrNXRXWGRIUVZsTFMzZFpRa0pCUjBSMmVrRkNRa0ZSUzFKSFZuZGlSemsxWWxkV2RXUkVRVlpDWjI5eVFtZEZSVUZaVHk5TlFVVkdRa0ZrYW1KSGEzWUtXVEo0Y0UxQ05FZERhWE5IUVZGUlFtYzNPSGRCVVZsRlJVaEtiRnB1VFhaaFIxWm9Xa2hOZG1SSVNqRmliWE4zVDNkWlMwdDNXVUpDUVVkRWRucEJRZ3BEUVZGMFJFTjBiMlJJVW5kamVtOTJURE5TZG1FeVZuVk1iVVpxWkVkc2RtSnVUWFZhTW13d1lVaFdhV1JZVG14amJVNTJZbTVTYkdKdVVYVlpNamwwQ2sxR2QwZERhWE5IUVZGUlFtYzNPSGRCVVd0RlZHZDRUV0ZJVWpCalNFMDJUSGs1Ym1GWVVtOWtWMGwxV1RJNWRFd3lUbk5oVXpscVlrZHJka3h0WkhBS1pFZG9NVmxwT1ROaU0wcHlXbTE0ZG1RelRYWmFSMVozWWtjNU5XSlhWblZrUXpVMVlsZDRRV050Vm0xamVUbHZXbGRHYTJONU9UQmpibFoxWVhwQk5BcENaMjl5UW1kRlJVRlpUeTlOUVVWTFFrTnZUVXRIVG0xUFJGbDVXa1JaTVZwSFdUTmFhbWh0V21wVmVVOUVRWGhPVjFWNVRYcFdhazlIVG1wWk1sRXdDazlIVG14WlZFazBUbTFaZDBoUldVdExkMWxDUWtGSFJIWjZRVUpEZDFGUVJFRXhibUZZVW05a1YwbDBZVWM1ZW1SSFZtdE5RMjlIUTJselIwRlJVVUlLWnpjNGQwRlJkMFZJUVhkaFlVaFNNR05JVFRaTWVUbHVZVmhTYjJSWFNYVlpNamwwVERKT2MyRlRPV3BpUjJ0M1QwRlpTMHQzV1VKQ1FVZEVkbnBCUWdwRVVWRnhSRU5vYWxwcVp6Sk5iVkV5VGxkU2JVNHlXVFJhYlZreFRXcG5kMDFVVm14TmFrMHhXWHBvYWxreVRtdE9SR2hxV2xkRmVVOUVXbTFOUTBGSENrTnBjMGRCVVZGQ1p6YzRkMEZSTkVWRlozZFJZMjFXYldONU9XOWFWMFpyWTNrNU1HTnVWblZoZWtGYVFtZHZja0puUlVWQldVOHZUVUZGVUVKQmMwMEtRMVJKZUUxcVdYaE5la0V3VDFSQmJVSm5iM0pDWjBWRlFWbFBMMDFCUlZGQ1FtZE5SbTFvTUdSSVFucFBhVGgyV2pKc01HRklWbWxNYlU1MllsTTVhZ3BpUjJ0M1IwRlpTMHQzV1VKQ1FVZEVkbnBCUWtWUlVVdEVRV2N4VDFSamQwNUVZM2hOVkVKalFtZHZja0puUlVWQldVOHZUVUZGVTBKRk5FMVVSMmd3Q21SSVFucFBhVGgyV2pKc01HRklWbWxNYlU1MllsTTVhbUpIYTNaWk1uaHdUSGsxYm1GWVVtOWtWMGwyWkRJNWVXRXlXbk5pTTJSNlRESlNiR05IZUhZS1pWY3hiR0p1VVhWbFZ6RnpVVWhLYkZwdVRYWmhSMVpvV2toTmRtUklTakZpYlhOM1QwRlpTMHQzV1VKQ1FVZEVkbnBCUWtWM1VYRkVRMmhxV21wbk1ncE5iVkV5VGxkU2JVNHlXVFJhYlZreFRXcG5kMDFVVm14TmFrMHhXWHBvYWxreVRtdE9SR2hxV2xkRmVVOUVXbTFOUTBWSFEybHpSMEZSVVVKbk56aDNDa0ZTVVVWRmQzZFNaREk1ZVdFeVduTmlNMlJtV2tkc2VtTkhSakJaTW1kM1ZHZFpTMHQzV1VKQ1FVZEVkbnBCUWtaUlVrRkVSRFZ2WkVoU2QyTjZiM1lLVERKa2NHUkhhREZaYVRWcVlqSXdkbGt5ZUhCTU1rNXpZVk01YUZrelVuQmlNalY2VEROS01XSnVUWFpOYWtsNlRWUkpNRTE2UVhkTlZGRjJXVmhTTUFwYVZ6RjNaRWhOZGs1RVFWZENaMjl5UW1kRlJVRlpUeTlOUVVWWVFrRm5UVUp1UWpGWmJYaHdXWHBCWVVKbmIzSkNaMFZGUVZsUEwwMUJSVmhDUVhkTkNrTnVRbmxpTWxJeFdUTlNjR0l5TkhkbldXdEhRMmx6UjBGUlVVSXhibXREUWtGSlJXVjNValZCU0dOQlpGRkVaRkJVUW5GNGMyTlNUVzFOV2tob2VWb0tXbnBqUTI5cmNHVjFUalE0Y21ZclNHbHVTMEZNZVc1MWFtZEJRVUZhZVV3MlZuazBRVUZCUlVGM1FrZE5SVkZEU1VZemVqSjZZakkyVDJKeGJuVTVPUXBKYkV3M1ZUSlROWHBZZDNreldHZEhLMmhrU0VKa1QxbE1Vako1UVdsQ1RVMUdXRmczVkM5WlJVTmFiV3BwVldrd1kzUXZRbmdyT1M5U05WQlhkWHB0Q21FMU5XVmFjazlhUVZSQlMwSm5aM0ZvYTJwUFVGRlJSRUYzVG01QlJFSnJRV3BDZERKbkwwSXJWR2xOY0RKSFpXZDFTQzlVZGtOV1JYSnNZMlJDUlZZS01XRldSMkZLWTBocFVUSlJVekp3V0ZaWFlqVktTbmh4Y0VoUk9YTmxXakp2Y1VsRFRVZFNVazlDTW1nMGNFTm1jR3BTT0hNdlZrbGliREJGYldaMlRRb3pWa1JGT1hsbU9VeGthR2xpVjNCUFZreGpTM2RqZWtGTWEyNUtZbUp1WldOb1NITTBaejA5Q2kwdExTMHRSVTVFSUVORlVsUkpSa2xEUVZSRkxTMHRMUzBLIn1dfX0=",
    integratedTime: 1771873852,
    logID: "c0d23d6ad406973f9559f3ba2d1ca01f84147d8ffc5b8445c224f98b9591801d",
    logIndex: 983591891,
    verification: {
      inclusionProof: {
        checkpoint:
          "rekor.sigstore.dev - 1193050959916656506\n1120642670\n7Hls74TqEq0UEN+UNBcQUY6OfI7KORlLuvNh6TRkPok=\n\n— rekor.sigstore.dev wNI9ajBGAiEAimn7axFbJCodNtWxtA4vxelkoY4MJocSsM9GqMYUtpwCIQDi0wLSCO/qYqKnTTvO38SvcqgYDnWEThatn7P823zO9g==\n",
        hashes: [
          "6a3bda2eae48670477cebf6fd52965cd43bd467f2776ea5fc252dd4dcc14f63d",
          "205da102b411be7ee4720f423956e78e4bdf0e9b34a849c56548f4bbaca3d618",
          "ee22b15a1f4b5c0f37fc481bc437d756810619f491fd80fe4916fb6d0647cdcc",
          "d60abe30dc982671cd3831ff9490e49dc056fef3914a16243dd169675953d6c5",
          "8ffafa66c4ce65305935dbfe361765fe6182bd674e8ca03e973c1d4b4f059cfd",
          "3a94cdd8915090675eb865a3a71c2d2c4b5d64eb37825752a057f78b6b33007a",
          "2138e8934d93e2d1840935f4a836ccb614f9bdc87ab6e45b1b093beabcca6a46",
          "82293f8861c0495054bb5153c190d70c921bffc8e16857b084f87373c198a1e0",
          "5ff5bc3222a5388fe6f9c4b7312c2dab1895f3b240aa88a437c259651f2100ce",
          "d3b7d9fc6ba25aaf425ad1af1fc6a7b0b46c4664f522085f44363f54e53ac12f",
          "554acd7e79bd90577c6b8ba094e86280b481266659e5881f4e785399aff35b0c",
          "14568d7cd1a82fae22e4f8df3a8b4bdeb26927f3df38bc59ad6e8718f380b86d",
          "8749089a10feca53c521129920fdcea8b80f510737cb2022d0557b304eb34e9b",
          "593e81aee089d10281fcaf6ac4f67ec0cf60fdbe4c4b92a3bd2bff7654f338c6",
          "594816965876a86ad191dbb82f0e5025838806a4784569c0e34964f06544defc",
          "03b3ec2956db971b6a42d646065b5276359cf86f62cba0e1f7ebd6dfbec457f0",
          "d7178a5849c04a3bb058ae39120eee5117368765e2e40613ae803f3efba509a7",
          "80247920a3a5f375fe2d42dc3a13f375e6e6747f037bd62791be751586f907e7",
          "76544171aa62222eccc72aac7b9b32ee77a7484d49eb245d90658b7257aa1dd5",
          "76a60ce18737c1416069aff40daef37b8f601b636a9428a16765faa73bba3324",
          "03c9bfc361bd3fb195d86e0e5df17d9692ceb4ee9f143528d67ac0576ef5fea6",
          "170b99ec65f1ce3ea7b011f9fea6f401300b4955c5497245cc116a2305fa2731",
          "0459d1ee789e8fcc7bc2b0e2ec173ab04c4351ed193746eb3ad4a7bc14d2b2e1",
          "a0c17d63b1f5a9afcc0c666c63497dd9199741227dea56ffa0499d0c357a4d61",
          "4475c34405b47e64e992a4b7f0881f7631befccd2d08969da65172b3ee4c325d",
          "09fdd0b1e7bb726b404e2e7a905aafa06b24a51c766efc79aa1ca18aaa1b2f45",
          "7d474b6528709e28db937198f9a73574bf0f20da1965fcb992a55790f8262367",
          "482b266513ca7db545294d2397add391094ebad47cdb1fcca03a9e11c1b1b874",
          "7cb02f138e8da82555f3a129076a4a9302651638c593b9ed5f7942f8f899b88a",
          "4f80ea583e36840b4dfaf5fc8ca096aa80b899e13825e908f4bc5818270fcb53",
          "d09afe27ebfc281bcf24da9d65d720aac6efb4ed4cf91a576ad589b827e083c6",
        ],
        logIndex: 861687629,
        rootHash: "ec796cef84ea12ad1410df94341710518e8e7c8eca39194bbaf361e934643e89",
        treeSize: 1120642670,
      },
      signedEntryTimestamp:
        "MEQCIA2dKmQXiKjWAhhdgSUYa5DutHlKdKqrIoECEbrAWJbWAiBVoODhyTtopcxkcS7P+SvhgpoKsGqptEveTEXTfHEiOw==",
    },
  };

  describe("parseRekorEntry", () => {
    it("extracts cert with correct OIDs", ({ expect }) => {
      const { cert } = parseRekorEntry(FIXTURE_ENTRY);
      expect(getExtensionValue(cert, OID_RUN_INVOCATION_URI)).toBe(
        "https://github.com/cli/cli/actions/runs/22312430014/attempts/4",
      );
      expect(getExtensionValue(cert, OID_SOURCE_REPO_URI)).toBe("https://github.com/cli/cli");
    });

    it("rejects non-dsse entry kind", ({ expect }) => {
      const bad: RekorLogEntry = {
        ...FIXTURE_ENTRY,
        body: btoa(
          JSON.stringify({
            apiVersion: "0.0.1",
            kind: "hashedrekord",
            spec: {},
          }),
        ),
      };
      expect(() => parseRekorEntry(bad)).toThrow();
    });

    it("maps all tlogEntry fields", ({ expect }) => {
      const { tlogEntry: tlog } = parseRekorEntry(FIXTURE_ENTRY);
      expect(tlog.logIndex).toBe(String(FIXTURE_ENTRY.logIndex));
      expect(tlog.logId?.keyId).toEqual(Buffer.from(FIXTURE_ENTRY.logID, "hex"));
      expect(tlog.canonicalizedBody).toEqual(Buffer.from(FIXTURE_ENTRY.body, "base64"));
      expect(tlog.kindVersion?.kind).toBe("dsse");
      expect(tlog.kindVersion?.version).toBe("0.0.1");
      expect(tlog.integratedTime).toBe(String(FIXTURE_ENTRY.integratedTime));
      expect(tlog.inclusionPromise?.signedEntryTimestamp).toEqual(
        Buffer.from(FIXTURE_ENTRY.verification.signedEntryTimestamp, "base64"),
      );
      const ip = tlog.inclusionProof!;
      const fip = FIXTURE_ENTRY.verification.inclusionProof;
      expect(ip.logIndex).toBe(String(fip.logIndex));
      expect(ip.rootHash).toEqual(Buffer.from(fip.rootHash, "hex"));
      expect(ip.treeSize).toBe(String(fip.treeSize));
      expect(ip.hashes).toEqual(fip.hashes.map((h) => Buffer.from(h, "hex")));
      expect(ip.checkpoint?.envelope).toBe(fip.checkpoint);
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
        resolveConfig({ retryCount: 0, dispatcher }),
      );
      expect(JSON.parse(String(body))).toEqual({ hash: `sha256:${"a".repeat(64)}` });
    });

    it("throws on non-ok response", async ({ expect }) => {
      await using dispatcher = mockFetch(() => ({ statusCode: 500, data: "" }));
      await expect(
        searchRekorEntries(sha256Hex("a".repeat(64)), resolveConfig({ retryCount: 0, dispatcher })),
      ).rejects.toThrow(/Rekor search failed/);
    });
  });

  describe("verifyRekorAttestations", () => {
    it("respects maxRekorEntries cap", async ({ expect }) => {
      let fetchCount = 0;
      await using dispatcher = mockFetch((opts) => {
        if (opts.path.includes("/index/retrieve")) {
          return {
            statusCode: 200,
            data: JSON.stringify(
              Array.from(
                { length: 15 },
                (_, i) => "aa".repeat(39) + i.toString(16).padStart(2, "0"),
              ),
            ),
          };
        }
        fetchCount++;
        return { statusCode: 500, data: "" };
      }, 20);
      await expect(
        verifyRekorAttestations({
          sha256: sha256Hex("a".repeat(64)),
          runInvocationURI: runInvocationURIFn("https://github.com/o/r/actions/runs/1/attempts/1"),
          repo: "o/r",
          config: resolveConfig({ retryCount: 0, maxRekorEntries: 3, dispatcher }),
          // All entries fail with HTTP 500, so trust material is never used.
          // All entries fail with HTTP 500 before trust material is used.
          trustMaterial: stubTrustMaterial,
        }),
      ).rejects.toThrow(ProvenanceError);
      expect(fetchCount).toBe(3);
    });
  });

  describe("fetchRekorEntry", () => {
    it("throws on empty response object", async ({ expect }) => {
      await using dispatcher = mockFetch(() => ({
        statusCode: 200,
        data: JSON.stringify({}),
      }));
      await expect(
        fetchRekorEntry("deadbeef", resolveConfig({ retryCount: 0, dispatcher })),
      ).rejects.toThrow(/empty Rekor response/);
    });
  });

  it("throws when DSSE body has empty signatures array", ({ expect }) => {
    const noSigs: RekorLogEntry = {
      ...FIXTURE_ENTRY,
      body: btoa(
        JSON.stringify({
          apiVersion: "0.0.1",
          kind: "dsse",
          spec: {
            envelopeHash: { algorithm: "sha256", value: "aaa" },
            payloadHash: { algorithm: "sha256", value: "bbb" },
            signatures: [],
          },
        }),
      ),
    };
    expect(() => parseRekorEntry(noSigs)).toThrow();
  });
}
