import { handleChat } from "../../../../sse/handlers/chat.js";
import { initTranslators } from "../../../../../open-sse/translator/index.js";
import { transformToOllama } from "../../../../../open-sse/utils/ollamaTransform.js";

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

export async function POST_handler(req, res) {
  await ensureInitialized();
  
  // The handler is (req, res) because autoRouter calls handler(req, res, {...}),
  // and there is no binding named `request` -- every call to this endpoint threw
  // ReferenceError. handleChat wants a Web Request, so build one the way the
  // Claude-format route does.
  const fullUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  const clonedReq = new Request(fullUrl, {
    method: req.method,
    headers: new Headers(req.headers),
    body: JSON.stringify(req.body),
  });
  let modelName = "llama3.2";
  try {
    const body = await clonedReq.json();
    modelName = body.model || "llama3.2";
  } catch {}

  const response = await handleChat(clonedReq);
  return transformToOllama(response, modelName);
}

