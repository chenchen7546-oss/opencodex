import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  releaseAsset,
  verifiedBinary,
} from "../../docker/custom/install-mihomo";

const digest = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
describe("custom image core verification", () => {
  test("selects pinned official assets and rejects unsupported architectures", () => {
    for (const arch of ["amd64", "arm64"]) {
      const asset = releaseAsset(arch);
      expect(asset.url).toStartWith(
        "https://github.com/MetaCubeX/mihomo/releases/download/v1.19.33/",
      );
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(() => releaseAsset("windows-x64")).toThrow("Unsupported");
  });
  test("only decompresses matching archives and requires a Linux binary", () => {
    const binary = Buffer.from("7f454c4600010203", "hex");
    const archive = gzipSync(binary);
    expect(verifiedBinary(archive, digest(archive))).toEqual(binary);
    expect(() => verifiedBinary(archive, "0".repeat(64))).toThrow(
      "checksum mismatch",
    );
    const text = gzipSync(Buffer.from("not an executable"));
    expect(() => verifiedBinary(text, digest(text))).toThrow(
      "not a Linux executable",
    );
    const invalid = Buffer.from("invalid gzip");
    expect(() => verifiedBinary(invalid, digest(invalid))).toThrow();
  });
  test("rejects oversized compressed input before decoding", () => {
    expect(() =>
      verifiedBinary(new Uint8Array(32 * 1024 * 1024 + 1), "0".repeat(64)),
    ).toThrow("size limit");
  });
});
