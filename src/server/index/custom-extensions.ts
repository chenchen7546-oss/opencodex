import type { OcxConfig } from "../../types";
import { configureAccountProxies } from "../../proxy-manager/runtime";
import { configureNotifications } from "../../notifications/runtime";

/** Keep custom optional integrations in one composition seam to simplify upstream merges. */
export function configureCustomExtensions(config: OcxConfig): void {
  configureAccountProxies(config);
  configureNotifications(config);
}
