
import { FILTERS } from "./filters.js";
import { fetchWithRedirectChecks } from "../../../lib/net/ssrf.js";

// Which host each catalogue entry may read from, keyed by the same `type` the
// filter uses. Every entry in filters.js needs one: a type missing here is
// refused outright rather than fetched unchecked.
//
// These two match the modelsFetcher hosts in the frontend provider constants
// (opencode.ai, openrouter.ai). A third provider would need its host added here
// as well as its filter, and the suite fails if a filter has no host — that is
// the point, so the list cannot quietly fall behind the catalogue.
const FETCHER_HOSTS = {
  "opencode-free": ["opencode.ai"],
  "openrouter-free": ["openrouter.ai"],
};

export const dynamic = "force-dynamic";

/** Lowercased hostname, or null when the value is not a URL. */
function safeHostname(raw) {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export async function GET_handler(req, res) {
  const { searchParams } = new URL('http://localhost' + req.originalUrl);
  const url = searchParams.get("url");
  const type = searchParams.get("type");

  if (!url || !type) {
    return res.status(400).json({ error: "Missing url or type" });
  }

  const filter = FILTERS[type];
  if (!filter) {
    return res.status(400).json({ error: "Unknown filter type" });
  }

  // `url` arrives in the query string, so it is caller-controlled. Only the
  // catalogue's own hosts are fetched: without this the endpoint will retrieve
  // anything the server can reach, including the cloud metadata service.
  const allowedDomains = FETCHER_HOSTS[type];
  if (!allowedDomains || !allowedDomains.includes(safeHostname(url))) {
    return res.status(403).json({ error: "Host not in the catalogue allowlist" });
  }

  try {
    const fetchRes = await fetchWithRedirectChecks(url, {
      allowedDomains,
      headers: {
        // Upstream Cloudflare answers a request with no User-Agent at all with
        // 403 (error code 1010), which silently emptied this catalogue. Sending
        // a real one identifies the caller instead.
        "User-Agent": "SYNS4033ROUTER/3.0 (+model discovery)",
      },
    });
    if (!fetchRes.ok) {
      return res.json({ data: [] });
    }
    const json = await fetchRes.json();
    const raw = json.data ?? json.models ?? json;
    const data = filter(Array.isArray(raw) ? raw : []);
    return res.json({ data });
  } catch {
    return res.json({ data: [] });
  }
}
