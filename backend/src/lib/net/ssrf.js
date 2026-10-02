// Server-side fetches of operator-supplied URLs.
//
// A URL that arrives from a request is attacker-controlled input. Fetching it
// verbatim lets whoever can reach the endpoint use the server as a proxy into
// whatever the server itself can reach: the cloud metadata service on
// 169.254.169.254, a private range, the container's own neighbours. That is the
// SSRF class, and it is why these checks live in one place rather than being
// re-derived per route.
//
// Three things are checked, because each alone leaves a hole:
//
//   1. Scheme — http/https only. file:, ftp: and gopher: are not fetchable
//      targets but are all things a caller might try.
//   2. Host — an explicit allowlist when the caller has one, and never a
//      substring match, so "evil-replicate.com" cannot pass as
//      "replicate.com". A literal IP is checked directly against the ranges
//      below rather than being treated as a hostname.
//   3. Address — the hostname is resolved and every address it resolves to must
//      be public. Without this, an allowlisted name that resolves into a private
//      range still reaches it, which is the whole DNS-rebinding trick.
//
// Redirects are the fourth, and the reason a route that validates its input
// URL can still end up somewhere else: fetch follows them by default. Callers
// get fetchWithRedirectChecks(), which walks the chain itself and revalidates
// every hop.

import dns from "node:dns/promises";
import net from "node:net";

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

// Ranges that are not routable on the public internet. Metadata endpoints sit in
// link-local; databases and dashboards run in private and loopback space.
function isPrivateAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    const [a, b] = p;
    if (a === 0) return true;                       // 0.0.0.0/8
    if (a === 10) return true;                      // 10.0.0.0/8
    if (a === 127) return true;                     // loopback
    if (a === 169 && b === 254) return true;        // link-local, incl. 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;        // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
    if (a === 192 && b === 0) return true;          // 192.0.0.0/24 + IETF protocol
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true;                      // multicast and reserved
    return false;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::1" || s === "::") return true;     // loopback / unspecified
    if (s.startsWith("fe80") || s.startsWith("fc") || s.startsWith("fd")) return true;
    // IPv4-mapped, e.g. ::ffff:169.254.169.254 — check the v4 part.
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // not an IP we recognise — refuse
}

async function resolvesToPublicAddress(hostname) {
  // A literal IP never goes to DNS; the range check above is the whole answer.
  if (net.isIP(hostname)) return { ok: !isPrivateAddress(hostname) };

  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    // Unresolvable is not "allowed" — fail closed.
    return { ok: false, reason: "hostname does not resolve" };
  }
  if (!records.length) return { ok: false, reason: "hostname resolved to nothing" };
  // Every address must be public. One private answer is enough to reach it, and
  // a caller that controls DNS can hand back a mix.
  for (const { address } of records) {
    if (isPrivateAddress(address)) {
      return { ok: false, reason: `resolves to a non-public address (${address})` };
    }
  }
  return { ok: true };
}

/** Host matches an allowlist entry exactly, or as a subdomain of it. */
function hostAllowed(hostname, allowedDomains) {
  const h = hostname.toLowerCase();
  return allowedDomains.some((d) => {
    const domain = d.toLowerCase().replace(/^\*\./, "");
    return h === domain || h.endsWith(`.${domain}`);
  });
}

/**
 * Validate a URL the server is about to fetch.
 * @returns {Promise<{ok: true, url: URL} | {ok: false, status: number, error: string}>}
 */
export async function checkFetchableUrl(rawUrl, { allowedDomains } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, status: 400, error: "Invalid URL" };
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return { ok: false, status: 400, error: `Scheme ${url.protocol} is not fetchable` };
  }

  if (!url.hostname) {
    return { ok: false, status: 400, error: "URL has no hostname" };
  }

  if (allowedDomains && !hostAllowed(url.hostname, allowedDomains)) {
    return { ok: false, status: 403, error: "Domain not allowed" };
  }

  const address = await resolvesToPublicAddress(url.hostname);
  if (!address.ok) {
    return { ok: false, status: 403, error: address.reason };
  }

  return { ok: true, url };
}

const MAX_REDIRECTS = 3;

/**
 * fetch() with every redirect hop revalidated. Without redirect: "manual" a
 * checked URL can hand off to 169.254.169.254 and the allowlist never sees it.
 */
export async function fetchWithRedirectChecks(rawUrl, { allowedDomains, init = {}, headers } = {}) {
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const checked = await checkFetchableUrl(current, { allowedDomains });
    if (!checked.ok) {
      const err = new Error(checked.error);
      err.status = checked.status;
      throw err;
    }

    const res = await fetch(checked.url, {
      ...init,
      headers,
      redirect: "manual",
    });

    if (res.status !== 301 && res.status !== 302 && res.status !== 303 && res.status !== 307 && res.status !== 308) {
      return res;
    }

    const location = res.headers.get("location");
    if (!location) return res;
    current = new URL(location, checked.url).toString();
  }

  const err = new Error("Too many redirects");
  err.status = 502;
  throw err;
}