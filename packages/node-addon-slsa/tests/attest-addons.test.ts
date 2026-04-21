// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Integration tests for `.github/actions/attest-addons/index.ts`: drive
 * `main()` with undici `MockAgent` for addon URLs (incl. transient 404s
 * that exercise the CDN-propagation retry). Only
 * `@actions/attest.attestProvenance` is stubbed — it performs OIDC
 * token exchange and Sigstore signing against live infrastructure, so
 * there's nothing honest we can do with it in a unit test.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { tempDir } from "@node-addon-slsa/internal";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { main } from "../../../.github/actions/attest-addons/index.ts";

type AttestProvenance = typeof import("@actions/attest").attestProvenance;
type AttestSubject = import("@actions/attest").Subject;

const { mockAttestProvenance } = vi.hoisted(() => ({
  mockAttestProvenance: vi.fn<AttestProvenance>(),
}));

vi.mock("@actions/attest", async (orig) => {
  const actual = await orig<typeof import("@actions/attest")>();
  return { ...actual, attestProvenance: mockAttestProvenance };
});

// `@actions/core.getInput` reads `INPUT_<upper-cased, spaces→_>`; dashes
// stay as-is, which is why the env-var names below keep them.
function setInput(name: string, value: string): void {
  vi.stubEnv(`INPUT_${name.replaceAll(" ", "_").toUpperCase()}`, value);
}

let previousDispatcher: Dispatcher;
let mockAgent: MockAgent;
let bundles: { path: string } & AsyncDisposable;

beforeEach(async () => {
  mockAttestProvenance.mockReset();
  mockAttestProvenance.mockResolvedValue({
    attestationID: "stub-attestation-id",
    certificate: "stub-cert",
    // Minimal bundle shape — we only round-trip it through JSON.stringify.
    bundle: { mediaType: "x", verificationMaterial: {}, dsseEnvelope: {} } as never,
  } as Awaited<ReturnType<AttestProvenance>>);

  previousDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  bundles = await tempDir("slsa-bundles-");
  setInput("bundle-dir", bundles.path);

  // Keep retry budgets snappy so a failing test doesn't hang CI.
  setInput("retry-count", "2");
  setInput("max-binary-seconds", "5");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await mockAgent.close();
  await bundles[Symbol.asyncDispose]();
  setGlobalDispatcher(previousDispatcher);
});

describe("attest-addons main()", () => {
  it("fetches each URL, hashes the body, and forwards correct subjects", async ({ expect }) => {
    const bytesA = Buffer.from("linux-x64-bytes");
    const bytesB = Buffer.from("darwin-arm64-bytes");

    mockAgent
      .get("https://cdn.example.com")
      .intercept({ path: "/a.node.gz", method: "GET" })
      .reply(200, bytesA, { headers: { "content-length": String(bytesA.length) } });
    mockAgent
      .get("https://cdn.example.com")
      .intercept({ path: "/b.node.gz", method: "GET" })
      .reply(200, bytesB, { headers: { "content-length": String(bytesB.length) } });

    setInput(
      "addons",
      JSON.stringify({
        linux: {
          x64: {
            url: "https://cdn.example.com/a.node.gz",
            bundleUrl: "https://cdn.example.com/a.node.gz.sigstore",
          },
        },
        darwin: {
          arm64: {
            url: "https://cdn.example.com/b.node.gz",
            bundleUrl: "https://cdn.example.com/b.node.gz.sigstore",
          },
        },
      }),
    );
    setInput("github-token", "ghs_fake_token");

    await main();

    expect(mockAttestProvenance).toHaveBeenCalledOnce();
    const opts = mockAttestProvenance.mock.calls[0]![0] as {
      subjects: AttestSubject[];
      token: string;
      sigstore: string;
    };
    expect(opts.token).toBe("ghs_fake_token");
    expect(opts.sigstore).toBe("public-good");

    const bySha = new Map(opts.subjects.map((s) => [s.digest["sha256"], s.name]));
    const expectedA = createHash("sha256").update(bytesA).digest("hex");
    const expectedB = createHash("sha256").update(bytesB).digest("hex");
    expect(bySha.get(expectedA)).toBe("https://cdn.example.com/a.node.gz");
    expect(bySha.get(expectedB)).toBe("https://cdn.example.com/b.node.gz");
    expect(opts.subjects).toHaveLength(2);

    // Bundle file written per addon, same contents (single multi-subject bundle).
    const files = await readdir(bundles.path);
    expect(files).toHaveLength(2);
    const first = await readFile(join(bundles.path, files[0]!), "utf8");
    const second = await readFile(join(bundles.path, files[1]!), "utf8");
    expect(first).toBe(second);
  });

  it("retries on 404 (CDN propagation) then succeeds", async ({ expect }) => {
    const bytes = Buffer.from("ok-bytes");

    mockAgent
      .get("https://cdn.example.com")
      .intercept({ path: "/a.node.gz", method: "GET" })
      .reply(404, "")
      .times(1);
    mockAgent
      .get("https://cdn.example.com")
      .intercept({ path: "/a.node.gz", method: "GET" })
      .reply(200, bytes, { headers: { "content-length": String(bytes.length) } });

    setInput(
      "addons",
      JSON.stringify({
        linux: {
          x64: {
            url: "https://cdn.example.com/a.node.gz",
            bundleUrl: "https://cdn.example.com/a.node.gz.sigstore",
          },
        },
      }),
    );
    setInput("github-token", "ghs_fake_token");

    await main();

    expect(mockAttestProvenance).toHaveBeenCalledOnce();
  });

  it("throws when addons input is empty", async ({ expect }) => {
    setInput("addons", JSON.stringify({}));
    setInput("github-token", "ghs_fake_token");

    await expect(main()).rejects.toThrow(/no URLs/);
    expect(mockAttestProvenance).not.toHaveBeenCalled();
  });

  it("throws when required addons input is missing", async ({ expect }) => {
    setInput("github-token", "ghs_fake_token");

    await expect(main()).rejects.toThrow(/addons/i);
    expect(mockAttestProvenance).not.toHaveBeenCalled();
  });
});
