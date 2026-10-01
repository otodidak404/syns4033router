// Skill injection is per-model: a capability doc is only shipped to the models
// the operator assigned it to. Injection order inside chatCore is
// system prompt → skills → caveman, so persona leads and docs follow.

import { injectSystemText, readSystemText } from "./systemPrompt.js";
import { readSkill } from "./skillLoader.js";
import { getActiveSkillIdsForModel, getPrefixForProvider } from "@/lib/localDb.js";

const bare = m => (typeof m === "string" && m.includes("/")
  ? m.slice(m.lastIndexOf("/") + 1)
  : m);

/**
 * Every key a request might be assigned under.
 *
 * The panel assigns against the operator-facing id ("pm/chatty"), while the
 * request that reaches us carries the resolved provider id
 * ("openai-compatible-chat-<uuid>/chatty"). The prefix differs; the bare model
 * name does not. So probe the exact id, its bare form, the bare model, and the
 * node's real short prefix — an assignment made any of those ways still applies.
 */
async function candidateKeys(clientModelId, model, providerId) {
  const bareModel = bare(model);
  const keys = [clientModelId, model, bareModel, bare(clientModelId)];

  const prefix = await getPrefixForProvider(providerId);
  if (prefix && bareModel) keys.push(`${prefix}/${bareModel}`);

  return [...new Set(keys.filter(k => typeof k === "string" && k.trim()))];
}

/**
 * Which skills apply to this request. Probes every plausible key and merges,
 * de-duplicating so the same skill matched twice lands once.
 * @returns {Promise<string[]>}
 */
export async function resolveSkillIds(clientModelId, model, providerId) {
  const keys = await candidateKeys(clientModelId, model, providerId);
  if (keys.length === 0) return [];

  const ids = [];
  for (const key of keys) {
    let assigned;
    try {
      assigned = await getActiveSkillIdsForModel(key);
    } catch (e) {
      console.warn("[SKILL] assignment lookup failed:", e.message);
      continue;
    }
    for (const id of assigned) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Inject the resolved skills into `body`'s system prompt.
 * Idempotent: a marker already present means a retried request reused this body,
 * so it is skipped rather than stacked.
 * @returns {Promise<string[]>} ids actually injected
 */
export async function injectResolvedSkills(body, format, clientModelId, model, providerId) {
  if (!body) return [];

  const ids = await resolveSkillIds(clientModelId, model, providerId);
  if (ids.length === 0) return [];

  const injected = [];
  let current = null;

  for (const id of ids) {
    const content = readSkill(id);
    if (!content) continue;

    const marker = `--- SKILL: ${id} ---`;
    if (current === null) current = readSystemText(body, format);
    if (current.includes(marker)) continue;

    if (injectSystemText(body, format, `${marker}\n${content}`)) {
      injected.push(id);
      current = readSystemText(body, format);
    }
  }
  return injected;
}