import { buildModelsList } from "../route.js";
import { catalogueKeyGate } from "../../../../lib/auth/catalogueGate.js";



// URL slug → service kind(s). `web` covers both webSearch and webFetch.
const KIND_SLUG_MAP = {
  "image": ["image"],
  "video": ["video"],
  "tts": ["tts"],
  "stt": ["stt"],
  "embedding": ["embedding"],
  "image-to-text": ["imageToText"],
  "web": ["webSearch", "webFetch"],
};

export async function OPTIONS(req) {
  const denied = await catalogueKeyGate(req).catch(() => null);
  if (denied) return denied;

  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/models/{kind} - OpenAI-compatible models list filtered by capability.
 * Supported kinds: image, tts, stt, embedding, image-to-text, web.
 */
// autoRouter.ts calls handler(req, res, { params }) -- params is a plain object
// and arrives third, not second. Declared as (req, { params }) this destructured
// an Express Response and answered 500 "Cannot destructure property 'kind'" for
// every request, so /v1/models/image and /v1/models/tts never worked at all.
export async function GET(_request, _res, { params }) {
  const denied = await catalogueKeyGate(_request);
  if (denied) return denied;

  try {
    const { kind } = params;
    const kindFilter = KIND_SLUG_MAP[kind];

    if (!kindFilter) {
      return Response.json(
        {
          error: {
            message: `Unknown model kind: ${kind}. Supported: ${Object.keys(KIND_SLUG_MAP).join(", ")}`,
            type: "invalid_request_error",
          },
        },
        { status: 404, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    const data = await buildModelsList(kindFilter);
    return Response.json({ object: "list", data }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    console.log("Error fetching models by kind:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}
