/** First-use container configuration; never replace an operator-owned file. */
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertConfigWriteDestination,
  configWriteLockFailureMessage,
  withConfigWriteLock,
} from "../../src/codex/config-write-lock";

export function ensureDefaultCodexConfig(home: string): boolean {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const directory = lstatSync(home);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error("Unsafe Codex configuration directory");
  const path = join(home, "config.toml");
  const outcome = withConfigWriteLock(path, (held) => {
    const previous = lstatSync(path, { throwIfNoEntry: false });
    if (previous) {
      if (!previous.isFile() || previous.isSymbolicLink())
        throw new Error("Unsafe existing Codex configuration");
      return false;
    }
    const destination = assertConfigWriteDestination(path, held);
    writeFileSync(destination, readFileSync(new URL("./codex-config.toml", import.meta.url)), {
      mode: 0o600,
      flag: "wx",
    });
    return true;
  });
  if (!outcome.ok) throw new Error(configWriteLockFailureMessage(outcome));
  return outcome.value;
}
