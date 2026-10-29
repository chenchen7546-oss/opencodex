import { isIP } from "node:net";

/** A single operator-approved private HTTP origin; never DNS, wildcards or public IPs. */
export function configuredHttpRememberOrigin(): string | null {
  const value = process.env.OPENCODEX_HTTP_REMEMBER_ORIGIN?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash
      || url.pathname !== "/" || isIP(url.hostname) !== 4) return null;
    const [first, second] = url.hostname.split(".").map(Number);
    if (first !== 10 && !(first === 172 && second! >= 16 && second! <= 31)
      && !(first === 192 && second === 168)) return null;
    return url.origin;
  } catch { return null; }
}
