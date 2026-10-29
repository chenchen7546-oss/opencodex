/** Build-time only: fixed official release, bounded download, checksum before decompression. */
import { createHash } from "node:crypto";
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import release from "./mihomo-release.json";

export function releaseAsset(arch: string) {
  if (arch !== "amd64" && arch !== "arm64")
    throw new Error("Unsupported Mihomo image architecture");
  const asset = release.assets[arch];
  return {
    ...asset,
    url: `https://github.com/MetaCubeX/mihomo/releases/download/v${release.version}/${asset.file}`,
  };
}

export function verifiedBinary(
  compressed: Uint8Array,
  expected: string,
): Buffer {
  if (compressed.byteLength > 32 * 1024 * 1024)
    throw new Error("Mihomo archive exceeds size limit");
  if (
    !/^[a-f0-9]{64}$/.test(expected) ||
    createHash("sha256").update(compressed).digest("hex") !== expected
  )
    throw new Error("Mihomo archive checksum mismatch");
  const binary = gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 });
  if (binary.subarray(0, 4).toString("hex") !== "7f454c46")
    throw new Error("Mihomo archive is not a Linux executable");
  return binary;
}

async function install(arch: string, destination: string): Promise<void> {
  const asset = releaseAsset(arch);
  const response = await fetch(asset.url, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body)
    throw new Error("Mihomo official release download failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 32 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Mihomo archive exceeds size limit");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const binary = verifiedBinary(Buffer.concat(chunks), asset.sha256);
  const temporary = `${destination}.tmp`;
  let created = false;
  try {
    writeFileSync(temporary, binary, { flag: "wx", mode: 0o755 });
    created = true;
    chmodSync(temporary, 0o755);
    renameSync(temporary, destination);
  } finally {
    if (created) rmSync(temporary, { force: true });
  }
  console.log(`Installed verified Mihomo ${release.version} (${arch})`);
}

if (import.meta.main) {
  const [arch, destination] = process.argv.slice(2);
  if (!arch || !destination)
    throw new Error("Usage: install-mihomo.ts <amd64|arm64> <destination>");
  await install(arch, destination);
}
