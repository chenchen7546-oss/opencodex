/** First-use only. Generate inside the private volume and never print a token. */
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import {
  serviceApiTokenFilePath,
  writeServiceApiTokenFile,
} from "../../src/lib/service-secrets";
import { withConfigMutationLockSync } from "../../src/config/mutation-lock";
import { ensureDefaultCodexConfig } from "./codex-config";

const path = process.env.OCX_API_TOKEN_FILE;
if (!path) throw new Error("OCX_API_TOKEN_FILE is required");
if (resolve(path) !== resolve(serviceApiTokenFilePath()))
  throw new Error("Service token path must match the state home");
withConfigMutationLockSync(() => {
  const previous = lstatSync(path, { throwIfNoEntry: false });
  if (previous) {
    if (!previous.isFile() || previous.isSymbolicLink())
      throw new Error("Unsafe existing service token path");
    console.log("Existing service token retained; no credentials changed.");
  } else {
    writeServiceApiTokenFile(randomBytes(32).toString("hex"));
    console.log("Initialized service token in private state volume.");
  }
});

const codexHome = process.env.CODEX_HOME;
if (!codexHome) throw new Error("CODEX_HOME is required");
console.log(ensureDefaultCodexConfig(codexHome)
  ? "Initialized default config.toml in private Codex volume."
  : "Existing config.toml retained; no Codex settings changed.");
