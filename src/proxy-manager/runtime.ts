/** Composition-root adapter. Never import this module from the core transport seam. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { OcxConfig } from "../types";
import { getConfigDir } from "../config/paths";
import { registerAccountEgress } from "../lib/account-egress";
import { registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { ProxyManager } from "./service";
import { ProxyStore } from "./store";
import { upstreamAccounts } from "./accounts";
import { ManagedProxyCore } from "./core";
let active:
  | {
      path: string;
      config: OcxConfig;
      manager: ProxyManager;
    }
  | undefined;
let exitHookInstalled = false;
function closeAccountProxies(): void {
  active?.manager.close();
  active = undefined;
  registerAccountEgress(undefined);
}
export function getProxyManager(config: OcxConfig, create = false): ProxyManager | undefined {
  const path = join(getConfigDir(), "proxy-manager", "state.sqlite");
  if (active && active.path !== path) {
    active.manager.close();
    active = undefined;
  }
  if (active) active.config = config;
  if (!active && (create || existsSync(path))) {
    assertNotRealHomeUnderTest(path);
    const store = new ProxyStore(path);
    active = {
      path,
      config,
      manager: new ProxyManager(
        store,
        upstreamAccounts(() => active?.config ?? config),
        new ManagedProxyCore(join(getConfigDir(), "proxy-manager"), () => store.profiles()),
      ),
    };
    if (!exitHookInstalled) {
      process.once("exit", closeAccountProxies);
      exitHookInstalled = true;
    }
  }
  return active?.manager;
}
export function configureAccountProxies(config: OcxConfig): void {
  registerAccountEgress({
    send: (input, init, next, scope) => getProxyManager(config)?.send(input, init, next, scope) ?? next(input, init),
    explicit: (input, init, scope) => getProxyManager(config)?.explicit(input, init, scope) ?? false,
  });
  registerOptionalShutdownHook("account-proxies", closeAccountProxies);
}
