// One key check for the routes that publish or act on the model catalogue.
//
// The outer auth middleware lets all of /v1 and /v1beta through (PUBLIC_PREFIXES
// in src/middleware/auth.ts) and delegates the client-key decision to each
// handler. Every execution handler does it through clientApiKeyRequired; the
// listing endpoints did not, so /v1/models, /v1/models/{kind}, /v1/models/info
// and /v1beta/models answered 200 with no key and published the operator's
// inventory -- combo names, custom prefixes, per-connection aliases.
//
// /v1beta/models/[...path] was worse: it had no check at all AND died on
// `request.headers` before reaching one, so every call returned 500. Fixing the
// ReferenceError on its own would have turned a dead endpoint into an
// unauthenticated way to run any model, past requireApiKey. That is why the
// regression test drives the handler and asserts 401 rather than 200.

import { getSettings, validateApiKey } from "../localDb.js";
import { extractApiKey } from "../../sse/services/auth.js";
import { clientApiKeyRequired } from "./apiKeyGate.js";

const DENIED = () =>
  Response.json(
    { error: { message: "Missing API key", type: "authentication_error", code: "invalid_api_key" } },
    { status: 401, headers: { "Access-Control-Allow-Origin": "*" } },
  );

/**
 * @param {object} req  the Express request
 * @param {string|null} model  the public model id this call acts on, or null for
 *        a catalogue listing. A listing has no model, so isNoAuthModel cannot
 *        exempt it; oc/space-bunny-free stays reachable for execution, which is
 *        the case the exemption was for.
 * @returns {Promise<Response|null>} a 401 to return, or null to continue
 */
export async function catalogueKeyGate(req, model = null) {
  const settings = await getSettings();
  if (!clientApiKeyRequired({ model, settings }).required) return null;

  const presented = extractApiKey(req);
  if (presented && (await validateApiKey(presented))) return null;

  return DENIED();
}