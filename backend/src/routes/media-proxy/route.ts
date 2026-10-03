import { fetchWithRedirectChecks } from "../../lib/net/ssrf.js";

// NextResponse was a Next.js import this Express router never had, and the
// replacement used a header table that was not in scope either.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};



// Trusted video/image CDN domains that we allow to proxy
const ALLOWED_DOMAINS = [
  "storage.googleapis.com",
  "storage.cloud.google.com",
  "cdn.weavy.ai",
  "media.weavy.ai",
  "weavy.ai",
  "fal.media",
  "v3b.fal.media",
  "v2.fal.media",
  "fal-cdn.co",
  "replicate.delivery",
  "pbxt.replicate.delivery",
  "replicate.com",
  "cloudflare-ipfs.com",
  "runway.ml",
  "runwayml.com",
  "kling.kuaishou.com",
  "api.kling.ai",
  "klingai.com",
  "hailuoai.com",
  "minimaxi.com",
];

/**
 * GET /api/media-proxy?url=<encoded_url>
 * Server-side proxy for video/image CDN URLs to bypass browser CORS restrictions.
 */
export async function GET_handler(req, res) {
  const { searchParams } = new URL('http://localhost' + req.originalUrl);
  const url = searchParams.get("url");

  if (!url) {
    return res.status(400).json({ error: "Missing url param" });
  }

  let decodedUrl;
  try {
    decodedUrl = decodeURIComponent(url);
  } catch {
    return res.status(400).json({ error: "Invalid url encoding" });
  }

  try {
    // Revalidates the host and resolves it, and does the same for every
    // redirect hop. The plain fetch this replaced followed redirects straight to
    // wherever the CDN pointed, so an allowlisted URL could still land on
    // 169.254.169.254.
    const upstream = await fetchWithRedirectChecks(decodedUrl, {
      allowedDomains: ALLOWED_DOMAINS,
      headers: {
        // Forward Range header so browser can seek
        ...(req.headers["range"]
          ? { Range: req.headers["range"] }
          : {}),
      },
    });

    if (!upstream.ok && upstream.status !== 206) {
      return new Response(null, { status: upstream.status, headers: CORS_HEADERS });
    }

    const contentType =
      upstream.headers.get("content-type") || "video/mp4";
    const contentLength = upstream.headers.get("content-length");
    const contentRange = upstream.headers.get("content-range");
    const acceptRanges = upstream.headers.get("accept-ranges") || "bytes";

    const headers = new Headers({
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
      "Accept-Ranges": acceptRanges,
    });
    if (contentLength) headers.set("Content-Length", contentLength);
    if (contentRange) headers.set("Content-Range", contentRange);

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  } catch (err) {
    // A blocked URL is a 403 from the guard, not an upstream failure — do not
    // report it as one.
    if (err?.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error("[media-proxy] Fetch error:", err.message);
    return res.json(
      { error: "Upstream fetch failed" },
      { status: 502 }
    );
  }
}

export async function HEAD(request) {
  return GET_handler(request);
}
