import { handleStt } from "../../../../sse/handlers/stt.js";

// Allow large audio uploads — 5min for processing large files
export const maxDuration = 300;

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

import { Readable } from "node:stream";
import { errorResponse } from "../../../../../open-sse/utils/error.js";

/** POST /v1/audio/transcriptions - OpenAI Whisper compatible STT */
export async function POST_handler(req, res) {
  // express.json() and express.urlencoded() run globally in server.ts. For
  // their own content types they consume the request stream before this runs,
  // and wrapping an already-drained stream in a Web Request made
  // request.formData() fail with "Response body object should not be disturbed
  // or locked" -- so a JSON body answered 500 instead of the 400 the handler
  // already had a branch for. Only multipart reaches the stream.
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("multipart/form-data")) {
    return errorResponse(400, "Invalid multipart form data");
  }

  const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const webReq = new Request(fullUrl, {
    method: req.method,
    headers: new Headers(req.headers),
    body: Readable.toWeb(req),
    duplex: 'half'
  });
  return await handleStt(webReq);
}
