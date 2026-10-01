

// Fetch with timeout wrapper
const fetchWithTimeout = (url, options, timeout = 10000) => {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error("Request timeout")), timeout)
    )
  ]);
};

// Validate URL format
const isValidUrl = (url) => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

// Parse error details for user-friendly messages
const getErrorMessage = (error) => {
  if (error.cause?.code === "ECONNREFUSED") return "Connection refused - provider node offline or unreachable";
  if (error.cause?.code === "ENOTFOUND") return "DNS lookup failed - invalid domain or network issue";
  if (error.cause?.code === "ETIMEDOUT") return "Connection timeout - provider node too slow";
  if (error.message.includes("timeout")) return "Request timeout (>10s) - provider node not responding";
  if (error.cause?.code === "CERT_HAS_EXPIRED") return "SSL certificate expired";
  if (error.cause?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return "SSL certificate verification failed";
  if (error.cause?.code) return `Network error: ${error.cause.code}`;
  return "Network connection failed - check URL and network connectivity";
};

// Get status-specific error message for /models endpoint
const getModelsErrorMessage = (status) => {
  if (status === 401 || status === 403) return "API key unauthorized";
  if (status === 404) return "/models endpoint not found - try chat validation with model ID";
  if (status >= 500) return "Server error - try again later";
  return `Unexpected response (${status})`;
};

// Get status-specific error message for /chat/completions endpoint
const getChatErrorMessage = (status) => {
  if (status === 401 || status === 403) return "API key unauthorized";
  if (status === 400) return "Invalid model or bad request";
  if (status === 404) return "Chat endpoint not found";
  if (status >= 500) return "Server error - try again later";
  return `Chat request failed (${status})`;
};

const readErrorBody = async (response) => {
  const text = await response.text().catch(() => "");
  if (!text) return "";
  try {
    const data = JSON.parse(text);
    return data?.error?.message || data?.error || data?.message || data?.msg || text;
  } catch {
    return text;
  }
};

const isAuthFailure = (status) => status === 401 || status === 403;

const isReachableInferenceStatus = (status) => !isAuthFailure(status) && status < 500;

const trimBaseUrl = (baseUrl) => baseUrl.trim().replace(/\/$/, "");

// POST /api/provider-nodes/validate - Validate API key against base URL
export async function POST_handler(req, res) {
  try {
    const body = req.body;
    const { baseUrl, apiKey, type, modelId } = body;

    if (!baseUrl || !apiKey) {
      return res.status(400).json({ error: "Base URL and API key required" });
    }

    // Validate URL format
    if (!isValidUrl(baseUrl)) {
      return res.status(400).json({ error: "Invalid URL format" });
    }

    // Custom Embedding Validation - test POST /embeddings directly
    if (type === "custom-embedding") {
      const normalizedBase = baseUrl.trim().replace(/\/$/, "");
      if (!modelId?.trim()) {
        return res.json({ valid: false, error: "Model ID required for embedding validation" });
      }
      const embedRes = await fetchWithTimeout(`${normalizedBase}/embeddings`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: modelId.trim(), input: "ping" })
      });
      if (embedRes.ok) {
        const data = await embedRes.json().catch(() => null);
        const dims = Array.isArray(data?.data?.[0]?.embedding) ? data.data[0].embedding.length : null;
        return res.json({ valid: true, method: "embeddings", dimensions: dims });
      }
      if (embedRes.status === 401 || embedRes.status === 403) {
        return res.json({ valid: false, error: "API key unauthorized" });
      }
      const errBody = await embedRes.text().catch(() => "");
      return res.json({
        valid: false,
        error: `Embeddings request failed (${embedRes.status})${errBody ? `: ${errBody.slice(0, 200)}` : ""}`,
        method: "embeddings"
      });
    }

    // Anthropic Compatible Validation
    if (type === "anthropic-compatible") {
      let normalizedBase = trimBaseUrl(baseUrl);
      if (normalizedBase.endsWith("/messages")) {
        normalizedBase = normalizedBase.slice(0, -9);
      }

      const modelsUrl = `${normalizedBase}/models`;
      // `upstream`, not `res`: naming the fetch result `res` shadows the Express
      // response, so every later `res.json({ valid })` would hit the fetch object.
      const upstream = await fetchWithTimeout(modelsUrl, {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Authorization": `Bearer ${apiKey}`
        }
      });

      if (upstream.ok) return res.json({ valid: true });

      if (isAuthFailure(upstream.status)) {
        return res.json({ valid: false, error: "API key unauthorized" });
      }

      // Fallback: Anthropic-compatible services usually expose /messages, not /models.
      if (modelId) {
        const messagesRes = await fetchWithTimeout(`${normalizedBase}/messages`, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: modelId,
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
          })
        });
        if (messagesRes.ok || isReachableInferenceStatus(messagesRes.status)) {
          const errorText = messagesRes.ok ? "" : await readErrorBody(messagesRes);
          return res.json({
            valid: true,
            method: "messages",
            warning: errorText ? String(errorText).slice(0, 200) : undefined,
          });
        }
        if (isAuthFailure(messagesRes.status)) {
          return res.json({ valid: false, error: "API key unauthorized", method: "messages" });
        }
        return res.json({
          valid: false,
          error: getChatErrorMessage(messagesRes.status),
          method: "messages"
        });
      }

      return res.json({ valid: false, error: getModelsErrorMessage(upstream.status) });
    }

    // OpenAI Compatible Validation (Default)
    const normalizedBase = trimBaseUrl(baseUrl);
    const modelsUrl = `${normalizedBase}/models`;
    const upstream = await fetchWithTimeout(modelsUrl, {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });

    if (upstream.ok) return res.json({ valid: true });

    if (isAuthFailure(upstream.status)) {
      return res.json({ valid: false, error: "API key unauthorized" });
    }

    // Fallback: try chat/completions if modelId provided
    if (modelId) {
      const chatRes = await fetchWithTimeout(`${normalizedBase}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1
        })
      });
      if (chatRes.ok || isReachableInferenceStatus(chatRes.status)) {
        const errorText = chatRes.ok ? "" : await readErrorBody(chatRes);
        return res.json({
          valid: true,
          method: "chat",
          warning: errorText ? String(errorText).slice(0, 200) : undefined,
        });
      }
      if (isAuthFailure(chatRes.status)) {
        return res.json({ valid: false, error: "API key unauthorized", method: "chat" });
      }
      return res.json({
        valid: false,
        error: getChatErrorMessage(chatRes.status),
        method: "chat"
      });
    }

    return res.json({ valid: false, error: getModelsErrorMessage(upstream.status) });
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error("Error validating provider node:", {
      message: error.message,
      cause: error.cause,
      code: error.cause?.code,
      userMessage: errorMessage
    });
    return res.status(500).json({
      valid: false,
      error: errorMessage
    });
  }
}
