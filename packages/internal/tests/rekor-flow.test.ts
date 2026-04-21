// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * End-to-end-shape coverage: real Rekor JSON + real Fulcio cert bytes
 * flowing through {@link RekorClient} into `verifyRekorAttestations`,
 * with a stubbed {@link BundleVerifier} that forces every verification
 * to throw. Catches regressions in the pipeline wiring without needing
 * TUF state or a real Fulcio chain.
 */
import { describe, it } from "vitest";

import { createHttpClient } from "../src/http.ts";
import { runInvocationURI, sha256Hex, type BundleVerifier } from "../src/types.ts";
import { DEFAULT_ATTEST_SIGNER_PATTERN } from "../src/verify/constants.ts";
import { createRekorClient } from "../src/verify/rekor-client.ts";
import { verifyRekorAttestations } from "../src/verify/rekor.ts";
import { mockFetch } from "./helpers/mock-fetch.ts";

const REAL_ENTRY_BODY =
  "eyJhcGlWZXJzaW9uIjoiMC4wLjEiLCJraW5kIjoiZHNzZSIsInNwZWMiOnsiZW52ZWxvcGVIYXNoIjp7ImFsZ29yaXRobSI6InNoYTI1NiIsInZhbHVlIjoiNzJjZDliMjQ5YTAwOWIyOWZiN2MxMTVhNjVlMzIxMjc0ZjVhMzllNmFhZTlhYmQyMDQxYTdmZWYzZDMxN2QyNSJ9LCJwYXlsb2FkSGFzaCI6eyJhbGdvcml0aG0iOiJzaGEyNTYiLCJ2YWx1ZSI6IjM4MzI1NjU0OTY2MWYwOGY3N2Q0MmM0YzJjNTBhNWMwZmVlZWI4NTZjNjU2NTExY2EzNGE2Nzk1ZGRkNTJjZmYifSwic2lnbmF0dXJlcyI6W3sic2lnbmF0dXJlIjoiTUVVQ0lRRE5ySEVuM2VKbTRZcTZJeTd6ZmsvVFVSRGJpNDhIZTBZUTA0OTgydjdBbUFJZ09KN3ByOHZ4QXhYWkcxR1p2b29sbGF0NHJlV0ptTGlqMW0xQW14UjVVVXc9IiwidmVyaWZpZXIiOiJMUzB0TFMxQ1JVZEpUaUJEUlZKVVNVWkpRMEZVUlMwdExTMHRDazFKU1VkeFJFTkRRbWtyWjBGM1NVSkJaMGxWWlVsME16RmlaM1ZqUlZkVmNuQlVTbkZNY1V0VUt6aFJhelJaZDBObldVbExiMXBKZW1vd1JVRjNUWGNLVG5wRlZrMUNUVWRCTVZWRlEyaE5UV015Ykc1ak0xSjJZMjFWZFZwSFZqSk5ValIzU0VGWlJGWlJVVVJGZUZaNllWZGtlbVJIT1hsYVV6RndZbTVTYkFwamJURnNXa2RzYUdSSFZYZElhR05PVFdwWmQwMXFTWHBOVkd0NFRVUlZlVmRvWTA1TmFsbDNUV3BKZWsxVWEzbE5SRlY1VjJwQlFVMUdhM2RGZDFsSUNrdHZXa2w2YWpCRFFWRlpTVXR2V2tsNmFqQkVRVkZqUkZGblFVVktOemgwZDBaVWFHUmtXVTlyU2pjeU5uTmlWVUV3ZGxWV2N6ZEljV1kzUW05SksxZ0tXVGRPZEc1aFUwcFlha2x6V2tOeFdHdEtVbEIzUTJSSWMzVTFlV1ppWTFjdlRWUXhaekJPVDA4NFJqRm5PVmRyUm1GUFEwSlZOSGRuWjFaTFRVRTBSd3BCTVZWa1JIZEZRaTkzVVVWQmQwbElaMFJCVkVKblRsWklVMVZGUkVSQlMwSm5aM0pDWjBWR1FsRmpSRUY2UVdSQ1owNVdTRkUwUlVablVWVm1VR0pqQ2pZeVFqQkdPRGxNUVVGcldtbERjVWh6VkRCMFVEZG5kMGgzV1VSV1VqQnFRa0puZDBadlFWVXpPVkJ3ZWpGWmEwVmFZalZ4VG1wd1MwWlhhWGhwTkZrS1drUTRkMWRuV1VSV1VqQlNRVkZJTDBKR1FYZFViMXBOWVVoU01HTklUVFpNZVRsdVlWaFNiMlJYU1hWWk1qbDBUREpPYzJGVE9XcGlSMnQyVEcxa2NBcGtSMmd4V1drNU0ySXpTbkphYlhoMlpETk5kbHBIVm5kaVJ6azFZbGRXZFdSRE5UVmlWM2hCWTIxV2JXTjVPVzlhVjBaclkzazVNR051Vm5WaGVrRTFDa0puYjNKQ1owVkZRVmxQTDAxQlJVSkNRM1J2WkVoU2QyTjZiM1pNTTFKMllUSldkVXh0Um1wa1IyeDJZbTVOZFZveWJEQmhTRlpwWkZoT2JHTnRUbllLWW01U2JHSnVVWFZaTWpsMFRVSTRSME5wYzBkQlVWRkNaemM0ZDBGUlNVVkZXR1IyWTIxMGJXSkhPVE5ZTWxKd1l6TkNhR1JIVG05TlJGbEhRMmx6UndwQlVWRkNaemM0ZDBGUlRVVkxSMDV0VDBSWmVWcEVXVEZhUjFreldtcG9iVnBxVlhsUFJFRjRUbGRWZVUxNlZtcFBSMDVxV1RKUk1FOUhUbXhaVkVrMENrNXRXWGRIUVZsTFMzZFpRa0pCUjBSMmVrRkNRa0ZSUzFKSFZuZGlSemsxWWxkV2RXUkVRVlpDWjI5eVFtZEZSVUZaVHk5TlFVVkdRa0ZrYW1KSGEzWUtXVEo0Y0UxQ05FZERhWE5IUVZGUlFtYzNPSGRCVVZsRlJVaEtiRnB1VFhaaFIxWm9Xa2hOZG1SSVNqRmliWE4zVDNkWlMwdDNXVUpDUVVkRWRucEJRZ3BEUVZGMFJFTjBiMlJJVW5kamVtOTJURE5TZG1FeVZuVk1iVVpxWkVkc2RtSnVUWFZhTW13d1lVaFdhV1JZVG14amJVNTJZbTVTYkdKdVVYVlpNamwwQ2sxR2QwZERhWE5IUVZGUlFtYzNPSGRCVVd0RlZHZDRUV0ZJVWpCalNFMDJUSGs1Ym1GWVVtOWtWMGwxV1RJNWRFd3lUbk5oVXpscVlrZHJka3h0WkhBS1pFZG9NVmxwT1ROaU0wcHlXbTE0ZG1RelRYWmFSMVozWWtjNU5XSlhWblZrUXpVMVlsZDRRV050Vm0xamVUbHZXbGRHYTJONU9UQmpibFoxWVhwQk5BcENaMjl5UW1kRlJVRlpUeTlOUVVWTFFrTnZUVXRIVG0xUFJGbDVXa1JaTVZwSFdUTmFhbWh0V21wVmVVOUVRWGhPVjFWNVRYcFdhazlIVG1wWk1sRXdDazlIVG14WlZFazBUbTFaZDBoUldVdExkMWxDUWtGSFJIWjZRVUpEZDFGUVJFRXhibUZZVW05a1YwbDBZVWM1ZW1SSFZtdE5RMjlIUTJselIwRlJVVUlLWnpjNGQwRlJkMFZJUVhkaFlVaFNNR05JVFRaTWVUbHVZVmhTYjJSWFNYVlpNamwwVERKT2MyRlRPV3BpUjJ0M1QwRlpTMHQzV1VKQ1FVZEVkbnBCUWdwRVVWRnhSRU5vYWxwcVp6Sk5iVkV5VGxkU2JVNHlXVFJhYlZreFRXcG5kMDFVVm14TmFrMHhXWHBvYWxreVRtdE9SR2hxV2xkRmVVOUVXbTFOUTBGSENrTnBjMGRCVVZGQ1p6YzRkMEZSTkVWRlozZFJZMjFXYldONU9XOWFWMFpyWTNrNU1HTnVWblZoZWtGYVFtZHZja0puUlVWQldVOHZUVUZGVUVKQmMwMEtRMVJKZUUxcVdYaE5la0V3VDFSQmJVSm5iM0pDWjBWRlFWbFBMMDFCUlZGQ1FtZE5SbTFvTUdSSVFucFBhVGgyV2pKc01HRklWbWxNYlU1MllsTTVhZ3BpUjJ0M1IwRlpTMHQzV1VKQ1FVZEVkbnBCUWtWUlVVdEVRV2N4VDFSamQwNUVZM2hOVkVKalFtZHZja0puUlVWQldVOHZUVUZGVTBKRk5FMVVSMmd3Q21SSVFucFBhVGgyV2pKc01HRklWbWxNYlU1MllsTTVhbUpIYTNaWk1uaHdUSGsxYm1GWVVtOWtWMGwyWkRJNWVXRXlXbk5pTTJSNlRESlNiR05IZUhZS1pWY3hiR0p1VVhWbFZ6RnpVVWhLYkZwdVRYWmhSMVpvV2toTmRtUklTakZpYlhOM1QwRlpTMHQzV1VKQ1FVZEVkbnBCUWtWM1VYRkVRMmhxV21wbk1ncE5iVkV5VGxkU2JVNHlXVFJhYlZreFRXcG5kMDFVVm14TmFrMHhXWHBvYWxreVRtdE9SR2hxV2xkRmVVOUVXbTFOUTBWSFEybHpSMEZSVVVKbk56aDNDa0ZTVVVWRmQzZFNaREk1ZVdFeVduTmlNMlJtV2tkc2VtTkhSakJaTW1kM1ZHZFpTMHQzV1VKQ1FVZEVkbnBCUWtaUlVrRkVSRFZ2WkVoU2QyTjZiM1lLVERKa2NHUkhhREZaYVRWcVlqSXdkbGt5ZUhCTU1rNXpZVk01YUZrelVuQmlNalY2VEROS01XSnVUWFpOYWtsNlRWUkpNRTE2UVhkTlZGRjJXVmhTTUFwYVZ6RjNaRWhOZGs1RVFWZENaMjl5UW1kRlJVRlpUeTlOUVVWWVFrRm5UVUp1UWpGWmJYaHdXWHBCWVVKbmIzSkNaMFZGUVZsUEwwMUJSVmhDUVhkTkNrTnVRbmxpTWxJeFdUTlNjR0l5TkhkbldXdEhRMmx6UjBGUlVVSXhibXREUWtGSlJXVjNValZCU0dOQlpGRkVaRkJVUW5GNGMyTlNUVzFOV2tob2VWb0tXbnBqUTI5cmNHVjFUalE0Y21ZclNHbHVTMEZNZVc1MWFtZEJRVUZhZVV3MlZuazBRVUZCUlVGM1FrZE5SVkZEU1VZemVqSjZZakkyVDJKeGJuVTVPUXBKYkV3M1ZUSlROWHBZZDNreldHZEhLMmhrU0VKa1QxbE1Vako1UVdsQ1RVMUdXRmczVkM5WlJVTmFiV3BwVldrd1kzUXZRbmdyT1M5U05WQlhkWHB0Q21FMU5XVmFjazlhUVZSQlMwSm5aM0ZvYTJwUFVGRlJSRUYzVG01QlJFSnJRV3BDZERKbkwwSXJWR2xOY0RKSFpXZDFTQzlVZGtOV1JYSnNZMlJDUlZZS01XRldSMkZLWTBocFVUSlJVekp3V0ZaWFlqVktTbmh4Y0VoUk9YTmxXakp2Y1VsRFRVZFNVazlDTW1nMGNFTm1jR3BTT0hNdlZrbGliREJGYldaMlRRb3pWa1JGT1hsbU9VeGthR2xpVjNCUFZreGpTM2RqZWtGTWEyNUtZbUp1WldOb1NITTBaejA5Q2kwdExTMHRSVTVFSUVORlVsUkpSa2xEUVZSRkxTMHRMUzBLIn1dfX0=";

const SEARCH_SHA = "b".repeat(64);

function attestationData(): string {
  const statement = {
    _type: "https://in-toto.io/Statement/v0.1",
    subject: [{ name: "addon", digest: { sha256: SEARCH_SHA } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {},
  };
  const envelope = {
    payloadType: "application/vnd.in-toto+json",
    payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
    signatures: [{ sig: Buffer.from("fake-sig").toString("base64"), keyid: "" }],
  };
  return Buffer.from(JSON.stringify(envelope)).toString("base64");
}

function makeRekorEntry(uuid: string): Record<string, unknown> {
  return {
    [uuid]: {
      body: REAL_ENTRY_BODY,
      integratedTime: 1_700_000_000,
      logID: "00".repeat(32),
      logIndex: 1,
      attestation: { data: attestationData() },
      verification: {
        signedEntryTimestamp: "AA==",
        inclusionProof: {
          checkpoint: "x\n1\nr=\n\n— k v==\n",
          hashes: ["aa".repeat(32)],
          logIndex: 1,
          rootHash: "aa".repeat(32),
          treeSize: 2,
        },
      },
    },
  };
}

const failingVerifier: BundleVerifier = {
  verify: () => {
    throw new Error("synthetic: forced bundle verification failure");
  },
};

describe("verifyRekorAttestations aggregate-failure branch", () => {
  it("throws the 'none matched' aggregate error when every entry fails", async ({ expect }) => {
    await using dispatcher = mockFetch((opts) => {
      if (opts.path.includes("/index/retrieve")) {
        return { statusCode: 200, data: JSON.stringify(["aa".repeat(32), "bb".repeat(32)]) };
      }
      const uuid = opts.path.split("/").pop() ?? "unknown";
      return { statusCode: 200, data: JSON.stringify(makeRekorEntry(uuid)) };
    }, 20);

    const http = createHttpClient({ dispatcher });
    const client = createRekorClient({
      http,
      searchUrl: "https://rekor.example/api/v1/index/retrieve",
      entryUrl: "https://rekor.example/api/v1/log/entries/{uuid}",
      maxJsonResponseBytes: 50 * 1024 * 1024,
    });

    await expect(
      verifyRekorAttestations({
        sha256: sha256Hex(SEARCH_SHA),
        repo: "owner/repo",
        expect: {
          sourceCommit: "a".repeat(40),
          sourceRef: "refs/tags/v1.2.3",
          runInvocationURI: runInvocationURI(
            "https://github.com/owner/repo/actions/runs/1/attempts/1",
          ),
          attestSignerPattern: DEFAULT_ATTEST_SIGNER_PATTERN,
        },
        client,
        verifier: failingVerifier,
        maxEntries: 100,
      }),
    ).rejects.toThrow(/Addon provenance verification failed|none matched|All \d+ Rekor entries/);
  });
});
