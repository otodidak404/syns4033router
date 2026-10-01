// Live system-prompt injection: resolves the prompt bound to the model a
// customer actually requested and merges it into the outgoing system prompt.
//
// Match order (first hit wins):
//   1. exact id            "oc/big-pickle"
//   2. de-prefixed id      request sent "openai-compatible-x/big-pickle"
//   3. bare model name     "big-pickle" — only when unambiguous
//   4. wildcard            "*"          — every model without its own entry
//
// The bare-name fallback is deliberately conservative: two entries may share a
// bare name across prefixes, and a collision falls through to the wildcard
// rather than injecting the wrong persona into a customer's traffic.

import { getSystemPrompts } from "@/lib/localDb.js";
import { injectSystemText, readSystemText } from "./systemPrompt.js";

const bare = id => {
  const s = typeof id === "string" ? id.trim() : "";
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
};

const uniq = xs => [...new Set(xs.filter(x => typeof x === "string" && x.trim()).map(x => x.trim()))];

/** Model target that matches every model without an entry of its own. */
export const GLOBAL_TARGET = "*";

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
  if (byBare.length === 1) return byBare[0];

  // Wildcard last, so a per-model entry always wins over the global one. An
  // ambiguous bare name lands here too: no specific match, so the global
  // prompt is a better answer than none at all.
  const wildcard = live.find(e => e.model === GLOBAL_TARGET);
  if (wildcard) return wildcard;

  return null;
}

/** Pick the entry bound to this request, reading the library. */
export async function resolvePromptForRequest(clientModelId, model) {
  try {
    const entry = pickEntry(await getSystemPrompts(), clientModelId, model);
    if (entry) return entry;
  } catch (e) {
    // Fall through to the env prompt: a database problem must not silently
    // strip the operator's prompt from every request.
    console.warn("[SYSPROMPT] lookup failed:", e.message);
  }
  // Last resort, not a source of truth — the library always wins when it has
  // an entry that matches.
  const envPrompt = process.env.GODMODE_JB;
  return envPrompt
    ? { label: "GODMODE_JB (env)", model: GLOBAL_TARGET, prompt: envPrompt }
    : null;
}

/**
 * Merge the resolved prompt into `body`'s system slot. Caller injects once per
 * request; later injections (skills, caveman) append after this.
 * @returns {{label: string, model: string}|null} what was injected
 */
export async function injectLiveSystemPrompt(body, format, clientModelId, model) {
  if (!body) return null;

  const entry = await resolvePromptForRequest(clientModelId, model);
  if (!entry) {
    console.debug(`[SYSPROMPT] no entry for ${clientModelId || model}`);
    return null;
  }

  const block = `--- SYSTEM PROMPT: ${entry.label} ---\n${entry.prompt}`;
  // Injecting the same block twice serves no purpose and doubles its cost, so a
  // body that already carries this exact prompt is left alone. This is what
  // makes a retried injection safe rather than cumulative.
  if (readSystemText(body, format).includes(block)) return entry;

  const ok = injectSystemText(body, format, block);
  if (!ok) console.warn(`[SYSPROMPT] shape "${format}" did not accept the injection`);
  return ok ? entry : null;
}