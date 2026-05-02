// SPDX-License-Identifier: Apache-2.0 OR MIT

import { describe, it } from "vitest";

import { aggregate } from "../../../.github/actions/aggregate-descriptors/index.ts";

const BASE = "https://cdn.example.com/v1/";

function descriptor(platform: string, arch: string, name: string): unknown {
  return {
    platform,
    arch,
    url: `${BASE}${name}`,
    bundleUrl: `${BASE}${name}.sigstore`,
    sha256: "a".repeat(64),
  };
}

describe("aggregate-descriptors", () => {
  it("builds nested addons map from valid descriptors", ({ expect }) => {
    const json = JSON.stringify([
      descriptor("linux", "x64", "a.node.gz"),
      descriptor("darwin", "arm64", "b.node.gz"),
    ]);
    const out = JSON.parse(aggregate(json, BASE));
    expect(out).toEqual({
      linux: { x64: { url: `${BASE}a.node.gz`, bundleUrl: `${BASE}a.node.gz.sigstore` } },
      darwin: { arm64: { url: `${BASE}b.node.gz`, bundleUrl: `${BASE}b.node.gz.sigstore` } },
    });
  });

  it("rejects empty array", ({ expect }) => {
    expect(() => aggregate("[]", BASE)).toThrow();
  });

  it("rejects non-array JSON", ({ expect }) => {
    expect(() => aggregate('{"foo": 1}', BASE)).toThrow();
  });

  it("rejects malformed JSON", ({ expect }) => {
    expect(() => aggregate("not json at all", BASE)).toThrow(/not valid JSON/);
  });

  it("auto-appends trailing slash to release-base-url", ({ expect }) => {
    const json = JSON.stringify([descriptor("linux", "x64", "a.node.gz")]);
    const out = JSON.parse(aggregate(json, "https://cdn.example.com/v1"));
    expect(out).toEqual({
      linux: { x64: { url: `${BASE}a.node.gz`, bundleUrl: `${BASE}a.node.gz.sigstore` } },
    });
  });

  it("rejects http release-base-url", ({ expect }) => {
    const json = JSON.stringify([descriptor("linux", "x64", "a.node.gz")]);
    expect(() => aggregate(json, "http://cdn.example.com/v1/")).toThrow(
      /must start with https:\/\//,
    );
  });

  it("rejects descriptor whose url does not start with release-base-url", ({ expect }) => {
    const d = {
      platform: "linux",
      arch: "x64",
      url: "https://evil.example.com/a.node.gz",
      bundleUrl: `${BASE}a.node.gz.sigstore`,
      sha256: "a".repeat(64),
    };
    expect(() => aggregate(JSON.stringify([d]), BASE)).toThrow(/url '.*evil.* does not start with/);
  });

  it("rejects descriptor whose bundleUrl does not start with release-base-url", ({ expect }) => {
    const d = {
      platform: "linux",
      arch: "x64",
      url: `${BASE}a.node.gz`,
      bundleUrl: "https://evil.example.com/a.node.gz.sigstore",
      sha256: "a".repeat(64),
    };
    expect(() => aggregate(JSON.stringify([d]), BASE)).toThrow(
      /bundleUrl '.*evil.* does not start with/,
    );
  });

  it("rejects prefix-substring attack (no trailing slash on stored url)", ({ expect }) => {
    // Even if release-base-url ends with `/`, the descriptor URL must
    // genuinely live under it. This test mostly guards the signature side
    // where a future change might drop the trailing-slash requirement.
    const json = JSON.stringify([descriptor("linux", "x64", "a.node.gz")]);
    expect(() => aggregate(json, "https://cdn.example.com/v1-evil/")).toThrow();
  });

  it("rejects duplicate (platform, arch) descriptors", ({ expect }) => {
    const json = JSON.stringify([
      descriptor("linux", "x64", "a.node.gz"),
      descriptor("linux", "x64", "duplicate.node.gz"),
    ]);
    expect(() => aggregate(json, BASE)).toThrow(/duplicate/);
  });

  it("rejects descriptor with invalid platform", ({ expect }) => {
    const bad = { ...(descriptor("linux", "x64", "a.node.gz") as object), platform: "freebsd" };
    expect(() => aggregate(JSON.stringify([bad]), BASE)).toThrow();
  });

  it("rejects descriptor with non-.node.gz url", ({ expect }) => {
    const bad = {
      platform: "linux",
      arch: "x64",
      url: `${BASE}a.node`,
      bundleUrl: `${BASE}a.node.sigstore`,
      sha256: "a".repeat(64),
    };
    expect(() => aggregate(JSON.stringify([bad]), BASE)).toThrow();
  });
});
