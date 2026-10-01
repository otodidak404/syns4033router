// Live system-prompt injection: resolves the prompt bound to the model a
// customer actually requested and merges it into the outgoing system prompt.
//
// Match order (first hit wins):
//   1. exact id            "oc/big-pickle"
//   2. de-prefixed id      request sent "openai-compatible-x/big-pickle"
//   3. bare model name     "big-pickle" — only when unambiguous
//
// The bare-name fallback is deliberately conservative: two entries may share a
// bare name across prefixes, and a collision resolves to no prompt rather than
// injecting the wrong persona into a customer's traffic.

import { getSystemPrompts } from "@/lib/localDb.js";
import { injectSystemText } from "./systemPrompt.js";

const bare = id => {
  const s = typeof id === "string" ? id.trim() : "";
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
};

const uniq = xs => [...new Set(xs.filter(x => typeof x === "string" && x.trim()).map(x => x.trim()))];

/**
 * Every string this request may be keyed by, most specific first.
 * `model` may be bare ("big-pickle") or prefixed ("oc/big-pickle").
 */
function keysFor(clientModelId, model) {
  const keys = [clientModelId, model];
  if (typeof model === "string" && model.includes("/")) keys.push(bare(model));
  return uniq(keys);
}

/**
 * Pick the entry to inject. Pure — no I/O — so the resolution rules are
 * testable without a database.
 * @returns {{prompt: string, label: string, model: string}|null}
 */
export function pickEntry(entries, clientModelId, model) {
  const live = entries.filter(e => e.isActive && e.isLive);
  const keys = keysFor(clientModelId, model);
  if (live.length === 0 || keys.length === 0) return null;

  for (const key of keys) {
    const hit = live.find(e => e.model === key);
    if (hit) return hit;
  }

  const names = uniq(keys.map(bare));
  const byBare = live.filter(e => names.includes(bare(e.model)));
  return byBare.length === 1 ? byBare[0] : null;
}

/** Pick the entry bound to this request, reading the library. */
export async function resolvePromptForRequest(clientModelId, model) {
  try {
    return pickEntry(await getSystemPrompts(), clientModelId, model);
  } catch (e) {
    console.warn("[SYSPROMPT] lookup failed:", e.message);
    return null;
  }
}

/**
 * Merge the resolved prompt into `body`'s system slot. Caller injects once per
 * request; later injections (skills, caveman) append after this.
 * @returns {{label: string, model: string}|null} what was injected
 */
export async function injectLiveSystemPrompt(body, format, clientModelId, model) {
  if (!body) return null;

  const entry = await resolvePromptForRequest(clientModelId, model);
  if (!entry) return null;

  const block = `--- SYSTEM PROMPT: ${entry.label} ---\n${entry.prompt}`;
  return injectSystemText(body, format, block) ? entry : null;
}