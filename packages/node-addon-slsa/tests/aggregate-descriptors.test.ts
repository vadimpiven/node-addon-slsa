// SPDX-License-Identifier: Apache-2.0 OR MIT

import { describe, it } from "vitest";

import { aggregate } from "../../../.github/actions/aggregate-descriptors/index.ts";

const BASE = "https://cdn.example.com/v1/";

function descriptor(platform: string, arch: string, name: string): object {
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
    const out = JSON.parse(
      aggregate(
        [descriptor("linux", "x64", "a.node.gz"), descriptor("darwin", "arm64", "b.node.gz")],
        BASE,
      ),
    );
    expect(out).toEqual({
      linux: { x64: { url: `${BASE}a.node.gz`, bundleUrl: `${BASE}a.node.gz.sigstore` } },
      darwin: { arm64: { url: `${BASE}b.node.gz`, bundleUrl: `${BASE}b.node.gz.sigstore` } },
    });
  });

  it("rejects empty array", ({ expect }) => {
    expect(() => aggregate([], BASE)).toThrow();
  });

  it("rejects non-array input", ({ expect }) => {
    expect(() => aggregate({ foo: 1 }, BASE)).toThrow();
  });

  it("auto-appends trailing slash to release-base-url", ({ expect }) => {
    const out = JSON.parse(
      aggregate([descriptor("linux", "x64", "a.node.gz")], "https://cdn.example.com/v1"),
    );
    expect(out).toEqual({
      linux: { x64: { url: `${BASE}a.node.gz`, bundleUrl: `${BASE}a.node.gz.sigstore` } },
    });
  });

  it("rejects http release-base-url", ({ expect }) => {
    expect(() =>
      aggregate([descriptor("linux", "x64", "a.node.gz")], "http://cdn.example.com/v1/"),
    ).toThrow(/must start with https:\/\//);
  });

  it("rejects descriptor whose url does not start with release-base-url", ({ expect }) => {
    const d = {
      platform: "linux",
      arch: "x64",
      url: "https://evil.example.com/a.node.gz",
      bundleUrl: `${BASE}a.node.gz.sigstore`,
      sha256: "a".repeat(64),
    };
    expect(() => aggregate([d], BASE)).toThrow(/url '.*evil.* does not start with/);
  });

  it("rejects descriptor whose bundleUrl does not start with release-base-url", ({ expect }) => {
    const d = {
      platform: "linux",
      arch: "x64",
      url: `${BASE}a.node.gz`,
      bundleUrl: "https://evil.example.com/a.node.gz.sigstore",
      sha256: "a".repeat(64),
    };
    expect(() => aggregate([d], BASE)).toThrow(/bundleUrl '.*evil.* does not start with/);
  });

  it("rejects prefix-substring attack (release-base-url adjacent to a sibling path)", ({
    expect,
  }) => {
    // Trailing-slash normalization means a descriptor under `/v1/` cannot
    // be accepted by an aggregator pointing at `/v1-evil/`.
    expect(() =>
      aggregate([descriptor("linux", "x64", "a.node.gz")], "https://cdn.example.com/v1-evil/"),
    ).toThrow();
  });

  it("rejects duplicate (platform, arch) descriptors", ({ expect }) => {
    expect(() =>
      aggregate(
        [descriptor("linux", "x64", "a.node.gz"), descriptor("linux", "x64", "dup.node.gz")],
        BASE,
      ),
    ).toThrow(/duplicate/);
  });

  it("rejects descriptor with invalid platform", ({ expect }) => {
    const bad = { ...descriptor("linux", "x64", "a.node.gz"), platform: "freebsd" };
    expect(() => aggregate([bad], BASE)).toThrow();
  });

  it("rejects descriptor with non-.node.gz url", ({ expect }) => {
    const bad = {
      platform: "linux",
      arch: "x64",
      url: `${BASE}a.node`,
      bundleUrl: `${BASE}a.node.sigstore`,
      sha256: "a".repeat(64),
    };
    expect(() => aggregate([bad], BASE)).toThrow();
  });
});
