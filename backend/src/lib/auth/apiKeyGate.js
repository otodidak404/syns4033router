// One place that decides whether a public /v1 call must present a client key.
//
// Eight handlers enforce requireApiKey. They were each written separately, and
// that is how they drifted: chat recognised that a provider with noAuth: true
// has no key for the operator to present, while embeddings, fetch, search, image,
// video, tts and stt still rejected it. Same router, same model, different
// answer depending on which endpoint was called.
//
// Callers get a verdict, not a response object, because the handlers disagree on
// whether they log before answering. Each still returns its own error in its own
// style; this only decides whether to reject.

import { isNoAuthModel } from "../../shared/constants/providers.js";

/**
 * @param {object} input
 * @param {string} input.model      the public model id, e.g. "oc/space-bunny-free"
 * @param {object} input.settings   settings row
 * @param {boolean} [input.authAlreadyChecked]  the caller is already behind the
 *        dashboard session guard, so a second gate would be redundant
 * @returns {{required: boolean, exempt?: string}}
 */
export function clientApiKeyRequired({ model, settings, authAlreadyChecked }) {
  if (!settings?.requireApiKey) return { required: false };
  if (authAlreadyChecked) return { required: false };

  // A noAuth provider reaches its upstream anonymously. There is no credential
  // the operator could present, so requiring one makes the model unreachable
  // rather than protected.
  if (isNoAuthModel(model)) return { required: false, exempt: "no-auth provider" };

  return { required: true };
}