// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Asserts that `verifyPackage` / `verifyPackageAt` walk the full pipeline
 * down to the Rekor search call: real filesystem fixtures, real HTTP via
 * MockAgent, real @sigstore/verify cert parsing. A `BundleVerifier` stub
 * is injected via `VerifyOptions.verifier` to force every verification
 * to throw (avoids decaying TUF fixtures); assertions key on the Rekor
 * search body the MockAgent observed (URL-encoded sha256), which proves
 * the hash made it end-to-end without needing a happy-path round trip.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import {
  SLSA_MANIFEST_V1_SCHEMA_URL,
  tempDir,
  verifyPackage,
  verifyPackageAt,
  type BundleVerifier,
} from "@node-addon-slsa/internal";

const failingVerifier: BundleVerifier = {
  verify: () => {
    throw new Error("synthetic: forced sigstore failure for integration test");
  },
};

// Build `attestation.data` whose in-toto Statement subject digest is `sha`.
// Lets fixtures pass `parseRekorEntry`'s subject-digest binding so the flow
// reaches the stubbed Verifier (which then fails).
function attestationDataFor(sha: string): string {
  const statement = {
    _type: "https://in-toto.io/Statement/v0.1",
    subject: [{ name: "addon", digest: { sha256: sha } }],
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

// Real Fulcio cert bytes so X509Certificate.parse accepts them; the cert's
// OIDs don't matter because the stubbed Verifier throws before they're read.
const REAL_ENTRY_BODY =
  "eyJhcGlWZXJzaW9uIjoiMC4wLjEiLCJraW5kIjoiZHNzZSIsInNwZWMiOnsiZW52ZWxvcGVIYXNoIjp7ImFsZ29yaXRobSI6InNoYTI1NiIsInZhbHVlIjoiNzJjZDliMjQ5YTAwOWIyOWZiN2MxMTVhNjVlMzIxMjc0ZjVhMzllNmFhZTlhYmQyMDQxYTdmZWYzZDMxN2QyNSJ9LCJwYXlsb2FkSGFzaCI6eyJhbGdvcml0aG0iOiJzaGEyNTYiLCJ2YWx1ZSI6IjM4MzI1NjU0OTY2MWYwOGY3N2Q0MmM0YzJjNTBhNWMwZmVlZWI4NTZjNjU2NTExY2EzNGE2Nzk1ZGRkNTJjZmYifSwic2lnbmF0dXJlcyI6W3sic2lnbmF0dXJlIjoiTUVVQ0lRRE5ySEVuM2VKbTRZcTZJeTd6ZmsvVFVSRGJpNDhIZTBZUTA0OTgydjdBbUFJZ09KN3ByOHZ4QXhYWkcxR1p2b29sbGF0NHJlV0ptTGlqMW0xQW14UjVVVXc9IiwidmVyaWZpZXIiOiJMUzB0TFMxQ1JVZEpUaUJEUlZKVVNVWkpRMEZVUlMwdExTMHRDazFKU1VkeFJFTkRRbWtyWjBGM1NVSkJaMGxWWlVsME16RmlaM1ZqUlZkVmNuQlVTbkZNY1V0VUt6aFJhelJaZDBObldVbExiMXBKZW1vd1JVRjNUWGNLVG5wRlZrMUNUVWRCTVZWRlEyaE5UV015Ykc1ak0xSjJZMjFWZFZwSFZqSk5ValIzU0VGWlJGWlJVVVJGZUZaNllWZGtlbVJIT1hsYVV6RndZbTVTYkFwamJURnNXa2RzYUdSSFZYZElhR05PVFdwWmQwMXFTWHBOVkd0NFRVUlZlVmRvWTA1TmFsbDNUV3BKZWsxVWEzbE5SRlY1VjJwQlFVMUdhM2RGZDFsSUNrdHZXa2w2YWpCRFFWRlpTVXR2V2tsNmFqQkVRVkZqUkZGblFVVktOemgwZDBaVWFHUmtXVTlyU2pjeU5uTmlWVUV3ZGxWV2N6ZEljV1kzUW05SksxZ0tXVGRPZEc1aFUwcFlha2x6V2tOeFdHdEtVbEIzUTJSSWMzVTFlV1ppWTFjdlRWUXhaekJPVDA4NFJqRm5PVmRyUm1GUFEwSlZOSGRuWjFaTFRVRTBSd3BCTVZWa1JIZEZRaTkzVVVWQmQwbElaMFJCVkVKblRsWklVMVZGUkVSQlMwSm5aM0pDWjBWR1FsRmpSRUY2UVdSQ1owNVdTRkUwUlVablVWVm1VR0pqQ2pZeVFqQkdPRGxNUVVGcldtbERjVWh6VkRCMFVEZG5kMGgzV1VSV1VqQnFRa0puZDBadlFWVXpPVkJ3ZWpGWmEwVmFZalZ4VG1wd1MwWlhhWGhwTkZrS1drUTRkMWRuV1VSV1VqQlNRVkZJTDBKR1FYZFViMXBOWVVoU01HTklUVFpNZVRsdVlWaFNiMlJYU1hWWk1qbDBUREpPYzJGVE9XcGlSMnQyVEcxa2NBcGtSMmd4V1drNU0ySXpTbkphYlhoMlpETk5kbHBIVm5kaVJ6azFZbGRXZFdSRE5UVmlWM2hCWTIxV2JXTjVPVzlhVjBaclkzazVNR051Vm5WaGVrRTFDa0puYjNKQ1owVkZRVmxQTDAxQlJVSkNRM1J2WkVoU2QyTjZiM1pNTTFKMllUSldkVXh0Um1wa1IyeDJZbTVOZFZveWJEQmhTRlpwWkZoT2JHTnRUbllLWW01U2JHSnVVWFZaTWpsMFRVSTRSME5wYzBkQlVWRkNaemM0ZDBGUlNVVkZXR1IyWTIxMGJXSkhPVE5ZTWxKd1l6TkNhR1JIVG05TlJGbEhRMmx6UndwQlVWRkNaemM0ZDBGUlRVVkxSMDV0VDBSWmVWcEVXVEZhUjFreldtcG9iVnBxVlhsUFJFRjRUbGRWZVUxNlZtcFBSMDVxV1RKUk1FOUhUbXhaVkVrMENrNXRXWGRIUVZsTFMzZFpRa0pCUjBSMmVrRkNRa0ZSUzFKSFZuZGlSemsxWWxkV2RXUkVRVlpDWjI5eVFtZEZSVUZaVHk5TlFVVkdRa0ZrYW1KSGEzWUtXVEo0Y0UxQ05FZERhWE5IUVZGUlFtYzNPSGRCVVZsRlJVaEtiRnB1VFhaaFIxWm9Xa2hOZG1SSVNqRmliWE4zVDNkWlMwdDNXVUpDUVVkRWRucEJRZ3BEUVZGMFJFTjBiMlJJVW5kamVtOTJURE5TZG1FeVZuVk1iVVpxWkVkc2RtSnVUWFZhTW13d1lVaFdhV1JZVG14amJVNTJZbTVTYkdKdVVYVlpNamwwQ2sxR2QwZERhWE5IUVZGUlFtYzNPSGRCVVd0RlZHZDRUV0ZJVWpCalNFMDJUSGs1Ym1GWVVtOWtWMGwxV1RJNWRFd3lUbk5oVXpscVlrZHJka3h0WkhBS1pFZG9NVmxwT1ROaU0wcHlXbTE0ZG1RelRYWmFSMVozWWtjNU5XSlhWblZrUXpVMVlsZDRRV050Vm0xamVUbHZXbGRHYTJONU9UQmpibFoxWVhwQk5BcENaMjl5UW1kRlJVRlpUeTlOUVVWTFFrTnZUVXRIVG0xUFJGbDVXa1JaTVZwSFdUTmFhbWh0V21wVmVVOUVRWGhPVjFWNVRYcFdhazlIVG1wWk1sRXdDazlIVG14WlZFazBUbTFaZDBoUldVdExkMWxDUWtGSFJIWjZRVUpDZDFGUVJFRXhibUZZVW05a1YwbDBZVWM1ZW1SSFZtdE5RMjlIUTJselIwRlJVVUlLWnpjNGQwRlJkMFZJUVhkaFlVaFNNR05JVFRaTWVUbHVZVmhTYjJSWFNYVlpNamwwVERKT2MyRlRPV3BpUjJ0M1QwRlpTMHQzV1VKQ1FVZEVkbnBCUWdwRVVWRnhSRU5vYWxwcVp6Sk5iVkV5VGxkU2JVNHlXVFJhYlZreFRXcG5kMDFVVm14TmFrMHhXWHBvYWxreVRtdE9SR2hxV2xkRmVVOUVXbTFOUTBGSENrTnBjMGRCVVZGQ1p6YzRkMEZSTkVWRlozZFJZMjFXYldONU9XOWFWMFpyWTNrNU1HTnVWblZoZWtGYVFtZHZja0puUlVWQldVOHZUVUZGVUVKQmMwMEtRMVJKZUUxcVdYaE5la0V3VDFSQmJVSm5iM0pDWjBWRlFWbFBMMDFCUlZGQ1FtZE5SbTFvTUdSSVFucFBhVGgyV2pKc01HRklWbWxNYlU1MllsTTVhZ3BpUjJ0M1IwRlpTMHQzV1VKQ1FVZEVkbnBCUWtWUlVVdEVRV2N4VDFSamQwNUVZM2hOVkVKalFtZHZja0puUlVWQldVOHZUVUZGVTBKRk5FMVVSMmd3Q21SSVFucFBhVGgyV2pKc01HRklWbWxNYlU1MllsTTVhbUpIYTNaWk1uaHdUSGsxYm1GWVVtOWtWMGwyWkRJNWVXRXlXbk5pTTJSNlRESlNiR05IZUhZS1pWY3hiR0p1VVhWbFZ6RnpVVWhLYkZwdVRYWmhSMVpvV2toTmRtUklTakZpYlhOM1QwRlpTMHQzV1VKQ1FVZEVkbnBCUWtWM1VYRkVRMmhxV21wbk1ncE5iVkV5VGxkU2JVNHlXVFJhYlZreFRXcG5kMDFVVm14TmFrMHhXWHBvYWxreVRtdE9SR2hxV2xkRmVVOUVXbTFOUTBWSFEybHpSMEZSVVVKbk56aDNDa0ZTVVVWRmQzZFNaREk1ZVdFeVduTmlNMlJtV2tkc2VtTkhSakJaTW1kM1ZHZFpTMHQzV1VKQ1FVZEVkbnBCUWtaUlVrRkVSRFZ2WkVoU2QyTjZiM1lLVERKa2NHUkhhREZaYVRWcVlqSXdkbGt5ZUhCTU1rNXpZVk01YUZrelVuQmlNalY2VEROS01XSnVUWFpOYWtsNlRWUkpNRTE2UVhkTlZGRjJXVmhTTUFwYVZ6RjNaRWhOZGs1RVFWZENaMjl5UW1kRlJVRlpUeTlOUVVWWVFrRm5UVUp1UWpGWmJYaHdXWHBCWVVKbmIzSkNaMFZGUVZsUEwwMUJSVmhDUVhkTkNrTnVRbmxpTWxJeFdUTlNjR0l5TkhkbldXdEhRMmx6UjBGUlVVSXhibXREUWtGSlJXVjNValZCU0dOQlpGRkVaRkJVUW5GNGMyTlNUVzFOV2tob2VWb0tXbnBqUTI5cmNHVjFUalE0Y21ZclNHbHVTMEZNZVc1MWFtZEJRVUZhZVV3MlZuazBRVUZCUlVGM1FrZE5SVkZEU1VZemVqSjZZakkyVDJKeGJuVTVPUXBKYkV3M1ZUSlROWHBZZDNreldHZEhLMmhrU0VKa1QxbE1Vako1UVdsQ1RVMUdXRmczVkM5WlJVTmFiV3BwVldrd1kzUXZRbmdyT1M5U05WQlhkWHB0Q21FMU5XVmFjazlhUVZSQlMwSm5aM0ZvYTJwUFVGRlJSRUYzVG01QlJFSnJRV3BDZERKbkwwSXJWR2xOY0RKSFpXZDFTQzlVZGtOV1JYSnNZMlJDUlZZS01XRldSMkZLWTBocFVUSlJVekp3V0ZaWFlqVktTbmh4Y0VoUk9YTmxXakp2Y1VsRFRVZFNVazlDTW1nMGNFTm1jR3BTT0hNdlZrbGliREJGYldaMlRRb3pWa1JGT1hsbU9VeGthR2xpVjNCUFZreGpTM2RqZWtGTWEyNUtZbUp1WldOb1NITTBaejA5Q2kwdExTMHRSVTVFSUVORlVsUkpSa2xEUVZSRkxTMHRMUzBLIn1dfX0=";

const BASE_MANIFEST = {
  $schema: SLSA_MANIFEST_V1_SCHEMA_URL,
  packageName: "my-pkg",
  runInvocationURI: "https://github.com/owner/repo/actions/runs/1/attempts/1",
  sourceRepo: "owner/repo",
  sourceCommit: "a".repeat(40),
  sourceRef: "refs/tags/v1.2.3",
  addons: {
    linux: { x64: { url: "https://e.com/a.node.gz", sha256: "b".repeat(64) } },
  },
};

async function makePackage(): Promise<{ path: string } & AsyncDisposable> {
  const tmp = await tempDir();
  await writeFile(
    join(tmp.path, "package.json"),
    JSON.stringify({
      name: "my-pkg",
      version: "1.2.3",
      addon: { path: "./dist/my.node", manifest: "./slsa-manifest.json" },
    }),
  );
  await writeFile(join(tmp.path, "slsa-manifest.json"), JSON.stringify(BASE_MANIFEST));
  return tmp;
}

let agent: MockAgent;
const rekorSearchBodies: string[] = [];
let lastSearchedSha = "";

beforeEach(() => {
  rekorSearchBodies.length = 0;
  lastSearchedSha = "";
  agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get("https://rekor.sigstore.dev")
    .intercept({ path: (p) => p.includes("/index/retrieve"), method: () => true })
    .reply((opts) => {
      const body = String(opts.body ?? "");
      rekorSearchBodies.push(body);
      // Capture the hex sha so the entry reply can embed a matching subject
      // digest — satisfies parseRekorEntry's subject-digest binding.
      lastSearchedSha = /"sha256:([a-f0-9]{64})"/.exec(body)?.[1] ?? "";
      return { statusCode: 200, data: JSON.stringify(["aa".repeat(32)]) };
    })
    .times(10);
  agent
    .get("https://rekor.sigstore.dev")
    .intercept({ path: (p) => p.includes("/log/entries/"), method: () => true })
    .reply((opts) => {
      // `fetchRekorEntry` looks the entry up by the requested UUID, not by
      // `Object.values()[0]`, so the mock must key under that same UUID.
      const uuid = (opts.path as string).split("/").pop() ?? "unknown";
      return {
        statusCode: 200,
        data: JSON.stringify({
          [uuid]: {
            body: REAL_ENTRY_BODY,
            integratedTime: 1_700_000_000,
            logID: "00".repeat(32),
            logIndex: 1,
            attestation: { data: attestationDataFor(lastSearchedSha) },
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
        }),
      };
    })
    .times(10);
});

afterEach(async () => {
  await agent.close();
});

describe("verifyPackageAt → PackageProvenance addon handle", () => {
  it("verifyAddonBySha256 sends the supplied hash to Rekor's index", async ({ expect }) => {
    await using tmp = await makePackage();
    const p = await verifyPackageAt(tmp.path, {
      repo: "owner/repo",
      dispatcher: agent,
      verifier: failingVerifier,
    });
    const sha = "c".repeat(64);
    await expect(p.verifyAddonBySha256(sha)).rejects.toThrow(/Addon provenance/);
    expect(rekorSearchBodies.some((body) => body.includes(sha))).toBe(true);
  });

  it("verifyAddonFromFile hashes the file and forwards that hash to Rekor", async ({ expect }) => {
    await using tmp = await makePackage();
    await mkdir(join(tmp.path, "dist"), { recursive: true });
    const binaryPath = join(tmp.path, "dist", "my.node");
    const bytes = Buffer.from("the quick brown fox jumps over the lazy dog");
    await writeFile(binaryPath, bytes);
    const expected = createHash("sha256").update(bytes).digest("hex");

    const p = await verifyPackageAt(tmp.path, {
      repo: "owner/repo",
      dispatcher: agent,
      verifier: failingVerifier,
    });
    await expect(p.verifyAddonFromFile(binaryPath)).rejects.toThrow(/Addon provenance/);
    expect(rekorSearchBodies.some((body) => body.includes(expected))).toBe(true);
  });

  it("accepts a URL-prefix `attestSignerPattern` override without throwing on construction", async ({
    expect,
  }) => {
    // Exercises the prefix-to-regex builder for a custom signer pattern.
    // The Rekor round-trip still fails (sigstore is mocked), but reaching
    // it proves the override composed without throwing.
    await using tmp = await makePackage();
    const p = await verifyPackageAt(tmp.path, {
      repo: "owner/repo",
      dispatcher: agent,
      verifier: failingVerifier,
      attestSignerPattern: "https://github.com/fork/repo/.github/workflows/publish.yaml",
    });
    await expect(p.verifyAddonBySha256("d".repeat(64))).rejects.toThrow(/Addon provenance/);
  });
});

describe("verifyPackage (top-level)", () => {
  it("resolves packageName via createRequire from cwd, then walks the full flow", async ({
    expect,
  }) => {
    await using root = await tempDir();
    const nm = join(root.path, "node_modules", "my-pkg");
    await mkdir(nm, { recursive: true });
    await writeFile(
      join(nm, "package.json"),
      JSON.stringify({
        name: "my-pkg",
        version: "1.2.3",
        addon: { path: "./dist/my.node", manifest: "./slsa-manifest.json" },
      }),
    );
    await writeFile(join(nm, "slsa-manifest.json"), JSON.stringify(BASE_MANIFEST));

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root.path);
    try {
      const p = await verifyPackage({
        packageName: "my-pkg",
        repo: "owner/repo",
        dispatcher: agent,
        verifier: failingVerifier,
      });
      expect(p.packageName).toBe("my-pkg");
      expect(p.sourceRepo).toBe("owner/repo");
      await expect(p.verifyAddonBySha256("e".repeat(64))).rejects.toThrow(/Addon provenance/);
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
