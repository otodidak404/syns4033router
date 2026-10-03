
import { createProxyPool } from "../../../models/index.js";

// Relay worker source code deployed to Cloudflare
const RELAY_WORKER_CODE = `
// The relay fetches whatever x-relay-target names, and it runs on Vercel/Cloudflare/
// Deno infrastructure, not on this router -- so the router's SSRF guard cannot see it.
// Without a check here, deploying a relay publishes an open proxy that can reach the
// host's loopback, link-local and private ranges, on the operator's own account.
// Matched against the whole hostname, not a prefix: 127.0.0.1.nip.io is a public
// name, and a prefix match here refused it.
const PRIVATE = /^(?:10\.\d+\.\d+\.\d+|127\.\d+\.\d+\.\d+|0\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)$/;
const BLOCKED_HOST = /^(?:localhost|metadata|instance-data|.*\.internal|.*\.local)$|^\[(?:::1|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe80:|::ffff:)/i;
function isForbiddenTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { return "not a valid url"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "only http and https are allowed";
  const h = u.hostname;
  const bare = h.replace(/^\[|\]$/g, "");
  if (PRIVATE.test(bare) || /^127\.\d+\.\d+\.?\d*$/.test(bare) || bare === "::1") {
    return "private and loopback addresses are not reachable through a relay";
  }
  if (BLOCKED_HOST.test(h)) return "that host is not reachable through a relay";
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const target = request.headers.get("x-relay-target");
    const relayPath = request.headers.get("x-relay-path") || "/";
    
    if (!target) {
      return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const blocked = isForbiddenTarget(target);
    if (blocked) {
      return new Response(JSON.stringify({ error: blocked }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }

    const targetUrl = target.replace(/\\/$/, "") + relayPath;
    const relayed = isForbiddenTarget(targetUrl);
    if (relayed) {
      return new Response(JSON.stringify({ error: relayed }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    const newRequestInit = {
      method: request.method,
      headers: new Headers(request.headers),
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      newRequestInit.body = request.body;
      newRequestInit.duplex = "half";
    }

    newRequestInit.headers.delete("x-relay-target");
    newRequestInit.headers.delete("x-relay-path");
    newRequestInit.headers.delete("host");

    try {
      const response = await fetch(targetUrl, newRequestInit);
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  },
};
`;

// POST /api/proxy-pools/cloudflare-deploy
export async function POST_handler(req, res) {
  try {
    const body = req.body;
    const accountId = body.accountId?.trim();
    const apiToken = body.apiToken?.trim();
    const projectName = body.projectName?.trim() || `relay-${Date.now().toString(36)}`;

    if (!accountId || !apiToken) {
      return res.status(400).json({ error: "Cloudflare Account ID and API Token are required" });
    }

    // 1. Upload Worker Script
    const workerScriptUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${projectName}`;
    
    // Cloudflare requires multipart/form-data for worker script upload
    const formData = new FormData();
    formData.append("index.js", new Blob([RELAY_WORKER_CODE], { type: "application/javascript+module" }), "index.js");
    formData.append("metadata", new Blob([JSON.stringify({
      main_module: "index.js",
      compatibility_date: "2024-03-20",
      observability: { enabled: true }
    })], { type: "application/json" }), "metadata.json");

    const uploadRes = await fetch(workerScriptUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
      body: formData,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({}));
      console.error("Cloudflare upload error:", err);
      return res.json(
        { error: err.errors?.[0]?.message || "Failed to upload Worker to Cloudflare" },
        { status: uploadRes.status }
      );
    }

    // 2. Enable workers.dev subdomain for the script
    const enableSubdomainRes = await fetch(`${workerScriptUrl}/subdomain`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: true }),
    });

    if (!enableSubdomainRes.ok) {
      const err = await enableSubdomainRes.json().catch(() => ({}));
      console.error("Cloudflare subdomain enable error:", err);
      // We don't fail completely here, just continue
    }

    // 3. Get the workers.dev subdomain for the account to construct the final URL
    let deployUrl = "";
    const subdomainRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
    });

    if (subdomainRes.ok) {
      const subdomainData = await subdomainRes.json();
      if (subdomainData.result && subdomainData.result.subdomain) {
        deployUrl = `https://${projectName}.${subdomainData.result.subdomain}.workers.dev`;
      }
    }

    if (!deployUrl) {
       return res.json(
        { error: "Worker deployed but failed to retrieve workers.dev subdomain. Make sure you have setup a workers.dev subdomain in Cloudflare Dashboard." },
        { status: 400 }
      );
    }

    // Create proxy pool entry with type cloudflare
    const proxyPool = await createProxyPool({
      name: projectName,
      proxyUrl: deployUrl,
      type: "cloudflare",
      noProxy: "",
      isActive: true,
      strictProxy: false,
    });

    return res.status(201).json({ proxyPool, deployUrl });
  } catch (error) {
    console.log("Error deploying Cloudflare relay:", error);
    return res.status(500).json({ error: error.message || "Deploy failed" });
  }
}
