/** Export a locally tested image, never credentials or runtime volumes. */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const root = resolve(import.meta.dir, "../..");
const image = process.argv[2] ?? "opencodex-custom:20261030-1";
if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image))
  throw new Error("Invalid image reference");
const inspect = Bun.spawn(["docker", "image", "inspect", image], {
  stdout: "pipe",
  stderr: "inherit",
});
const raw = await new Response(inspect.stdout).text();
if (await inspect.exited) throw new Error("Build the image before exporting");
const [metadata] = JSON.parse(raw);
const acceptance = JSON.parse(
  await readFile(resolve(root, ".tmp/custom-docker-acceptance.json"), "utf8"),
);
if (
  !acceptance.passed ||
  acceptance.imageId !== metadata.Id ||
  metadata.Os !== "linux" ||
  metadata.Architecture !== "amd64"
)
  throw new Error(
    "Run scripts/custom/docker-smoke.ts against this exact Linux amd64 image first",
  );
const name = image.replace(/[^a-zA-Z0-9._-]/g, "-");
const destination = resolve(root, "dist/custom", name);
await mkdir(resolve(root, "dist/custom"), { recursive: true });
// Refuse an existing bundle rather than overwriting a user's previously tested version.
await mkdir(destination);
const archive = "opencodex-image.tar.gz";
const partial = resolve(destination, archive + ".partial");
const save = Bun.spawn(["docker", "image", "save", image], {
  stdout: "pipe",
  stderr: "inherit",
});
try {
  await pipeline(
    Readable.fromWeb(save.stdout as never),
    createGzip({ level: 6 }),
    createWriteStream(partial, { flags: "wx" }),
  );
  if (await save.exited) throw new Error("Docker image export failed");
  await rename(partial, resolve(destination, archive));
} catch (error) {
  save.kill();
  throw error;
}
await copyFile(
  resolve(root, "deploy/compose.yaml"),
  resolve(destination, "compose.yaml"),
);
const example = (
  await readFile(resolve(root, "deploy/.env.example"), "utf8")
).replace(/^OPENCODEX_IMAGE=.*$/m, `OPENCODEX_IMAGE=${image}`);
await writeFile(resolve(destination, ".env.example"), example, { flag: "wx" });
const serverExample = (await readFile(resolve(root, "deploy/.env.centos7.example"), "utf8"))
  .replace(/^OPENCODEX_IMAGE=.*$/m, `OPENCODEX_IMAGE=${image}`);
await writeFile(resolve(destination, ".env.centos7.example"), serverExample, { flag: "wx" });
await copyFile(
  resolve(root, "deploy/README.zh-CN.md"),
  resolve(destination, "README.zh-CN.md"),
);
await writeFile(
  resolve(destination, "acceptance.json"),
  JSON.stringify(acceptance, null, 2) + "\n",
  { flag: "wx" },
);
await writeFile(
  resolve(destination, "release.json"),
  JSON.stringify(
    {
      image,
      imageId: metadata.Id,
      platform: "linux/amd64",
      unpackedImageBytes: metadata.Size,
      exportedAt: new Date().toISOString(),
      mihomo: JSON.parse(
        await readFile(
          resolve(root, "docker/custom/mihomo-release.json"),
          "utf8",
        ),
      ).version,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
const files = [
  archive,
  "compose.yaml",
  ".env.example",
  ".env.centos7.example",
  "README.zh-CN.md",
  "acceptance.json",
  "release.json",
];
const sums: string[] = [];
for (const file of files) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(resolve(destination, file)))
    hash.update(chunk);
  sums.push(`${hash.digest("hex")}  ${file}`);
}
await writeFile(resolve(destination, "SHA256SUMS"), sums.join("\n") + "\n", {
  flag: "wx",
});
console.log(`Exported verified deployment bundle: dist/custom/${name}`);
