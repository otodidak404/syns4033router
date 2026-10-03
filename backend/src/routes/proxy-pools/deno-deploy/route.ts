
import { createProxyPool } from "../../../models/index.js";

const DENO_V2_API = "https://api.deno.com/v2";

const DENO_RELAY_CODE = `
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

Deno.serve(async (request) => {
  const target = request.headers.get("x-relay-target");
  const relayPath = request.headers.get("x-relay-path") || "/";

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
  const newHeaders = new Headers(request.headers);
  newHeaders.delete("x-relay-target");
  newHeaders.delete("x-relay-path");
  newHeaders.delete("host");

  const init = {
    method: request.method,
    headers: newHeaders,
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  try {
    const response = await fetch(targetUrl, init);
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
});`;

export async function POST_handler(req, res) {
  try {
    const body = req.body;
    const denoToken = body.denoToken?.trim();
    const orgDomain = body.orgDomain?.trim();
    const projectName = body.projectName?.trim() || `relay-${Date.now().toString(36)}`;

    if (!orgDomain) {
      return res.status(400).json({ error: "Organization domain is required" });
    }

    if (!denoToken) {
      return res.status(400).json({ error: "Deno Deploy API token is required" });
    }

    const headers = {
      Authorization: `Bearer ${denoToken}`,
      "Content-Type": "application/json",
    };

    const createAppRes = await fetch(`${DENO_V2_API}/apps`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: projectName,
        labels: { "custom.kind": "9router-relay" },
        config: {
          install: "deno install",
          runtime: {
            type: "dynamic",
            entrypoint: "main.ts",
          },
        },
      }),
    });

    if (!createAppRes.ok) {
      const text = await createAppRes.text().catch(() => "");
      if (createAppRes.status === 409) {
        return res.status(409).json({ error: `App "${projectName}" already exists. Choose a different name.` });
      }
      return res.status(createAppRes.status).json({ error: `Failed to create app (${createAppRes.status}): ${text}` });
    }

    const app = await createAppRes.json();

    const deployRes = await fetch(`${DENO_V2_API}/apps/${app.id}/deploy`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        assets: {
          "main.ts": {
            kind: "file",
            content: DENO_RELAY_CODE,
            encoding: "utf-8",
          },
        },
      }),
    });

    if (!deployRes.ok) {
      const text = await deployRes.text().catch(() => "");
      console.error("Deno Deploy error:", deployRes.status, text);
      await fetch(`${DENO_V2_API}/apps/${app.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${denoToken}` },
      }).catch(() => {});
      return res.status(deployRes.status).json({ error: `Deploy failed (${deployRes.status}): ${text}` });
    }

    const revision = await deployRes.json();
    const revisionId = revision.id;

    let status = revision.status;
    let attempts = 0;
    const maxAttempts = 30; // 30 * 2s = 60s max
    while (status === "queued" || status === "building") {
      if (attempts >= maxAttempts) {
        throw new Error("Deploy timed out after 60 seconds");
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const statusRes = await fetch(`${DENO_V2_API}/revisions/${revisionId}`, {
        headers: { Authorization: `Bearer ${denoToken}` },
      });
      if (!statusRes.ok) break;
      const statusData = await statusRes.json();
      status = statusData.status;
      attempts++;
    }

    if (status !== "succeeded") {
      await fetch(`${DENO_V2_API}/apps/${app.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${denoToken}` },
      }).catch(() => {});
      return res.status(500).json({ error: `Deploy failed with status: ${status}` });
    }

    const orgSlug = orgDomain.split(".")[0];
    const deployUrl = `https://${projectName}.${orgSlug}.deno.net`;
    console.log("Deno deployUrl:", deployUrl);

    const proxyPool = await createProxyPool({
      name: projectName,
      proxyUrl: deployUrl,
      type: "deno",
      noProxy: "",
      // A relay that has just been created has not been tested. `isActive: true`
      // put it straight into rotation, so connectionProxy would route provider
      // traffic through a URL nobody has ever reached. The pool starts off and
      // the operator (or the Test button) switches it on once it answers.
      isActive: false,
      strictProxy: false,
    });

    return res.status(201).json({ proxyPool, deployUrl });
  } catch (error) {
    console.log("Error deploying Deno Deploy relay:", error);
    return res.status(500).json({ error: error.message || "Deploy failed" });
  }
}
