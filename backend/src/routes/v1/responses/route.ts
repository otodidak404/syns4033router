import { handleChat } from "../../../sse/handlers/chat.js";
import { initTranslators } from "../../../../open-sse/translator/index.js";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/responses - OpenAI Responses API format
 * Now handled by translator pattern (openai-responses format auto-detected)
 */
export async function POST_handler(req, res) {
  await ensureInitialized();
  // No binding named `request` here either: every POST to /v1/responses threw
  // ReferenceError. handleChat takes a Web Request.
  const fullUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  const webReq = new Request(fullUrl, {
    method: req.method,
    headers: new Headers(req.headers),
    body: JSON.stringify(req.body),
  });
  return await handleChat(webReq);
}
