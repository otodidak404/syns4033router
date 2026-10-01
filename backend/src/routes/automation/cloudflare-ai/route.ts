
import { createProviderConnection, getProviderConnections, updateProviderConnection } from "../../../models/index.js";

export const dynamic = "force-dynamic";

const CF_API = "https://api.cloudflare.com/client/v4";

function cfHeaders(globalApiKey: string, email: string) {
  return {
    "X-Auth-Key": globalApiKey,
    "X-Auth-Email": email,
    "Content-Type": "application/json",
  };
}

async function cfFetch(path: string, globalApiKey: string, email: string, options: RequestInit = {}) {
  const res = await fetch(`${CF_API}${path}`, {
    ...options,
    headers: {
      ...cfHeaders(globalApiKey, email),
      ...(options.headers as Record<string, string> || {}),
    },
  });
  const data = await res.json() as { success: boolean; result?: any; errors?: { message: string }[] };
  if (!data.success) {
    const msg = data.errors?.[0]?.message || "Cloudflare API error";
    throw new Error(msg);
  }
  return data.result;
}

// POST /api/automation/cloudflare-ai/setup
// Body: { globalApiKey, email, tokenName? }
export async function POST_handler(req: any, res: any) {
  try {
    const { globalApiKey, email, tokenName } = req.body || {};

    if (!globalApiKey || !email) {
      return res.status(400).json({ error: "globalApiKey and email are required" });
    }

    // 1. List accounts → take first
    const accounts = await cfFetch("/accounts?per_page=1", globalApiKey, email);
    if (!accounts || accounts.length === 0) {
      return res.status(400).json({ error: "No Cloudflare accounts found for this credential" });
    }
    const account = accounts[0];
    const accountId: string = account.id;
    const accountName: string = account.name;

    // 2. Get permission groups → find Workers AI Read + Edit
    const permGroups = await cfFetch(
      `/accounts/${accountId}/tokens/permission_groups`,
      globalApiKey,
      email
    ) as { id: string; name: string }[];

    const readGroup = permGroups.find(
      (g) => g.name === "Workers AI Read" || g.name === "Workers AI:Read"
    );
    const editGroup = permGroups.find(
      (g) => g.name === "Workers AI Edit" || g.name === "Workers AI:Edit"
    );

    if (!readGroup || !editGroup) {
      // Fallback: try to find by partial name
      const read2 = permGroups.find((g) => g.name.toLowerCase().includes("workers ai") && g.name.toLowerCase().includes("read"));
      const edit2 = permGroups.find((g) => g.name.toLowerCase().includes("workers ai") && g.name.toLowerCase().includes("edit"));
      if (!read2 || !edit2) {
        return res.status(400).json({
          error: `Workers AI permission groups not found. Available: ${permGroups.map(g => g.name).join(", ")}`,
        });
      }
    }

    const finalReadGroup = readGroup || permGroups.find((g) => g.name.toLowerCase().includes("workers ai") && g.name.toLowerCase().includes("read"));
    const finalEditGroup = editGroup || permGroups.find((g) => g.name.toLowerCase().includes("workers ai") && g.name.toLowerCase().includes("edit"));

    // 3. Create token
    const tokenPayload = {
      name: tokenName || "9router Workers AI",
      policies: [
        {
          effect: "allow",
          permission_groups: [
            { id: finalReadGroup!.id },
            { id: finalEditGroup!.id },
          ],
          resources: {
            [`com.cloudflare.api.account.${accountId}`]: "*",
          },
        },
      ],
    };

    const tokenResult = await cfFetch("/user/tokens", globalApiKey, email, {
      method: "POST",
      body: JSON.stringify(tokenPayload),
    }) as { value: string; id: string };

    const newApiToken: string = tokenResult.value;
    const tokenId: string = tokenResult.id;

    // 4. Upsert cloudflare-ai provider connection
    const existing = await getProviderConnections({ provider: "cloudflare-ai" });

    let savedConnection: any;
    if (existing.length > 0) {
      // Update first existing connection
      savedConnection = await updateProviderConnection(existing[0].id, {
        apiKey: newApiToken,
        providerSpecificData: {
          ...(existing[0].providerSpecificData || {}),
          accountId,
        },
        name: existing[0].name || `Cloudflare (${accountName})`,
      });
    } else {
      // Create new connection
      savedConnection = await createProviderConnection({
        provider: "cloudflare-ai",
        authType: "apikey",
        name: `Cloudflare (${accountName})`,
        apiKey: newApiToken,
        email: "",
        priority: 1,
        globalPriority: null,
        defaultModel: null,
        providerSpecificData: { accountId },
        isActive: true,
        testStatus: "unknown",
      });
    }

    return res.json({
      ok: true,
      accountId,
      accountName,
      tokenId,
      connectionId: savedConnection?.id,
      message: `✅ Token created and saved! Account: ${accountName} (${accountId})`,
    });
  } catch (err: any) {
    console.error("[cloudflare-ai automation]", err);
    return res.status(500).json({ error: err.message || "Failed to setup Cloudflare Workers AI" });
  }
}
