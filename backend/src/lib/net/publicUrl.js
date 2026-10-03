/**
 * Work out the public address this router is reachable at.
 *
 * The Host header is chosen by whoever sent the request. `webhook-register` sends it to
 * the mail Worker, which then POSTs every OTP delivery to whatever address was named —
 * so deriving a registered webhook from Host lets a caller point the OTP feed at a host
 * they control, signed with the real secret.
 *
 * Two jobs, deliberately separated:
 *
 *   `displayBaseUrl` — for showing a URL in the dashboard. It falls back to the Host
 *   header, because a wrong-looking value on screen is a nuisance, not a breach. It is
 *   returned with `trusted: false` so callers can say so.
 *
 *   `registrationBaseUrl` — for registering a webhook. It refuses to fall back to Host.
 *   The operator has to set `AMMAIL_PUBLIC_URL` or enable a tunnel. That is the one
 *   deliberate behaviour change here: registering without one is a 400 naming the
 *   variable, instead of a webhook silently bound to whatever the request claimed.
 */

const DEFAULT_ENV_KEYS = ["AMMAIL_PUBLIC_URL", "ROUTER_PUBLIC_URL", "PUBLIC_URL"];

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const IPV6_HOSTNAME = /^\[[0-9a-f:]+\]$/i;

/**
 * A Host header is only usable for display if it is a bare hostname or IP literal.
 * Anything carrying userinfo, a port we did not expect, whitespace, or a path is not a
 * host, and string-concatenating one into a URL is how `evil.com/#` style values end up
 * in settings and logs.
 */
export function isPlausibleHostHeader(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (/[\s\\@/?#]/.test(value)) return false;
  const host = value.replace(/:\d+$/, "");
  if (!host) return false;
  if (IPV6_HOSTNAME.test(host)) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || HOSTNAME.test(host);
}

function readConfiguredBaseUrl(env = process.env) {
  for (const key of DEFAULT_ENV_KEYS) {
    const raw = env[key];
    if (typeof raw === "string" && raw.trim()) return { baseUrl: raw.trim(), source: key };
  }
  return { baseUrl: "", source: "" };
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

/**
 * The address to show in the dashboard. Falls back to the request's own headers so the
 * page is useful on a fresh install, and reports whether that fallback was used.
 */
export function displayBaseUrl(req, env = process.env) {
  const configured = readConfiguredBaseUrl(env);
  const fromEnv = normaliseBaseUrl(configured.baseUrl);
  if (fromEnv) return { baseUrl: fromEnv, trusted: true, source: configured.source };

  const tunnelUrl = typeof req?.ammailTunnelUrl === "string" ? req.ammailTunnelUrl.trim() : "";
  const fromTunnel = normaliseBaseUrl(tunnelUrl);
  if (fromTunnel) return { baseUrl: fromTunnel, trusted: true, source: "tunnel" };

  const forwardedProto = firstHeader(req?.headers?.["x-forwarded-proto"]);
  const host = firstHeader(req?.headers?.host) ?? firstHeader(req?.headers?.[":authority"]);
  if (isPlausibleHostHeader(host)) {
    const scheme = forwardedProto === "https" ? "https" : forwardedProto === "http" ? "http" : "http";
    return { baseUrl: `${scheme}://${stripTrailingSlash(host)}`, trusted: false, source: "host-header" };
  }

  return { baseUrl: "", trusted: false, source: "none" };
}

/**
 * The address to register a webhook at. Never falls back to the Host header.
 *
 * Returns `{ ok: false, reason }` when nothing trustworthy is configured; the caller
 * turns that into a 400 rather than registering a webhook to an unverified address.
 */
export function registrationBaseUrl({ tunnelUrl, env = process.env } = {}) {
  const configured = readConfiguredBaseUrl(env);
  const fromEnv = normaliseBaseUrl(configured.baseUrl);
  if (fromEnv) return { ok: true, baseUrl: fromEnv, source: configured.source };

  const fromTunnel = normaliseBaseUrl(typeof tunnelUrl === "string" ? tunnelUrl.trim() : "");
  if (fromTunnel) return { ok: true, baseUrl: fromTunnel, source: "tunnel" };

  return {
    ok: false,
    reason:
      `Registering a webhook needs an address you trust, because the Worker will POST ` +
      `every OTP delivery to it. Set ${DEFAULT_ENV_KEYS[0]} to this router's public URL, ` +
      `or enable a tunnel, then try again.`,
  };
}

function firstHeader(value) {
  if (Array.isArray(value)) return value[0];
  if (typeof value === "string") return value.split(",")[0].trim();
  return undefined;
}

function safeHostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * Normalise an address to what should actually be used.
 *
 * The host was validated separately, so returning the raw string would hand back
 * something that is not what was checked: `https://user@evil.example` parses to the host
 * `evil.example` and passes, but string-concatenating the original would keep the
 * userinfo. This rebuilds from the parsed parts and drops credentials, path, query and
 * fragment, which have no business in a webhook address.
 */
function normaliseBaseUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (!isPlausibleHostHeader(parsed.host)) return "";
    return stripTrailingSlash(`${parsed.protocol}//${parsed.host}`);
  } catch {
    return "";
  }
}