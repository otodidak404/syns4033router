
import { createProxyPool } from "../../../models/index.js";

const VERCEL_API = "https://api.vercel.com";

// Relay function source code deployed to Vercel
// Forwards requests to target URL specified in x-relay-target header
const RELAY_FUNCTION_CODE = `
// The relay fetches whatever x-relay-target names, and it runs on Vercel/Cloudflare/
// Deno infrastructure, not on this router -- so the router's SSRF guard cannot see it.
// Without a check here, deploying a relay publishes an open proxy that can reach the
// host's loopback, link-local and private ranges, on the operator's own account.
// Matched against the whole hostname, not a prefix: 127.0.0.1.nip.io is a public
// name and a prefix match here refused it.
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

export const config = { runtime: "edge" };

export default async function handler(req) {
  const target = req.headers.get("x-relay-target");
  const relayPath = req.headers.get("x-relay-path") || "/";
  if (!target) {
    return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const targetUrl = target.replace(/\\/$/, "") + relayPath;
  // Checked once, on the URL that will actually be fetched. targetUrl inherits its
  // host from target, so a check on target alone was redundant -- and it was the
  // weaker of the two: relayPath arrives in a header and is appended, so
  // "https://example.com" + "@evil.com/" resolves to evil.com.
  const relayed = isForbiddenTarget(targetUrl);
  if (relayed) {
    return new Response(JSON.stringify({ error: relayed }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  const headers = new Headers(req.headers);
  headers.delete("x-relay-target");
  headers.delete("x-relay-path");
  headers.delete("host");

  const response = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    duplex: "half",
  });

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}
`;

async function pollDeployment(deploymentId, token, maxMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const res = await fetch(`${VERCEL_API}/v13/deployments/${deploymentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.readyState === "READY") return data;
    if (data.readyState === "ERROR" || data.readyState === "CANCELED") {
      throw new Error(`Deployment failed: ${data.readyState}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Deployment timed out");
}

// POST /api/proxy-pools/vercel-deploy
export async function POST_handler(req, res) {
  try {
    const body = req.body;
    const vercelToken = body.vercelToken;
    const projectName = body.projectName?.trim() || `relay-${Date.now().toString(36)}`;

    if (!vercelToken) {
      return res.status(400).json({ error: "Vercel API token is required" });
    }

    // Deploy relay function to Vercel
    const deployRes = await fetch(`${VERCEL_API}/v13/deployments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${vercelToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: projectName,
        files: [
          {
            file: "api/relay.js",
            data: RELAY_FUNCTION_CODE,
          },
          {
            file: "package.json",
            data: JSON.stringify({ name: projectName, version: "1.0.0" }),
          },
          {
            file: "vercel.json",
            data: JSON.stringify({
              rewrites: [{ source: "/(.*)", destination: "/api/relay" }],
            }),
          },
        ],
        projectSettings: {
          framework: null,
        },
        target: "production",
      }),
    });

    if (!deployRes.ok) {
      const err = await deployRes.json().catch(() => ({}));
      return res.json(
        { error: err.error?.message || "Failed to create Vercel deployment" },
        { status: deployRes.status }
      );
    }

    const deployment = await deployRes.json();
    const deploymentId = deployment.id || deployment.uid;

    // Disable deployment protection (Vercel Authentication)
    const projectId = deployment.projectId || projectName;
    await fetch(`${VERCEL_API}/v9/projects/${projectId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${vercelToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ssoProtection: null }),
    });

    // Poll until deployment is ready
    const ready = await pollDeployment(deploymentId, vercelToken);
    const deployUrl = `https://${ready.url}`;

    // Create proxy pool entry with type vercel
    const proxyPool = await createProxyPool({
      name: projectName,
      proxyUrl: deployUrl,
      type: "vercel",
      noProxy: "",
      isActive: true,
      strictProxy: false,
    });

    return res.status(201).json({ proxyPool, deployUrl });
  } catch (error) {
    console.log("Error deploying Vercel relay:", error);
    return res.status(500).json({ error: error.message || "Deploy failed" });
  }
}
