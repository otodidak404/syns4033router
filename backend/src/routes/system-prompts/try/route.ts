// Runs a system prompt against a real model, over the real request path.
//
// The playground this replaces formatted a string locally and printed it under a
// "Would inject into …" heading. It looked like output and was not: nothing was
// sent, and there was no baseline to compare against. An operator could not tell
// a working prompt from a broken one without shipping it to live traffic.
//
// Both legs go through handleChat(), so what the operator sees here is what a
// customer would get — same translator, same credential handling, same provider.
// The draft is written into the body by the caller and the library entry is
// skipped via a header, so exactly one persona is in play.

import { handleChat } from "../../../../sse/handlers/chat.js";
import { injectSystemText } from "../../../../../open-sse/rtk/systemPrompt.js";
import { getSystemPrompts } from "../../../../lib/localDb.js";
import { markInternal } from "../../../../lib/auth/internalCall.js";

export const dynamic = "force-dynamic";

const MAX_MESSAGE = 8000;
const MAX_PROMPT = 32000;
const TIMEOUT_MS = 90_000;

/** Pull a saved entry by id, or take a draft straight from the request. */
async function resolvePrompt(entryId, draft) {
  if (typeof draft === "string" && draft.trim()) {
    return { prompt: draft, label: "(draft)", model: null };
  }
  if (!entryId) return null;
  const all = await getSystemPrompts();
  return all.find(e => e.id === entryId) || null;
}

/**
 * Read the assistant text out of whatever the handler produced. The upstream may
 * answer as a single object or as an SSE stream, and this route does not care
 * which — only the text matters.
 */
function extractText(raw) {
  if (!raw) return "";
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  if (!text.includes("data:")) {
    try {
      const j = JSON.parse(text);
      return j?.choices?.[0]?.message?.content ?? j?.content?.[0]?.text ?? "";
    } catch { return ""; }
  }
  const parts = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const j = JSON.parse(payload);
      const c = j?.choices?.[0];
      parts.push(c?.delta?.content ?? c?.message?.content ?? "");
    } catch { /* a partial frame is not worth failing the whole run over */ }
  }
  return parts.join("");
}

async function runLeg({ model, message, systemPrompt }) {
  const messages = [{ role: "user", content: message }];
  const body = { model, messages, stream: false, max_tokens: 512 };
  if (systemPrompt) {
    // OpenAI is the format the dashboard playground speaks; the handler detects
    // the real one from the body, so the system text lands in the right slot.
    injectSystemText(body, "openai", systemPrompt);
  }

  // Marked on the object, not by header: see lib/auth/internalCall.js.
  const req = markInternal(new Request("http://internal/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));

  try {
    const res = await handleChat(req);
    const raw = typeof res === "string" ? res : await res?.text?.();
    return { ok: true, text: extractText(raw) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function POST_handler(req, res) {
  let payload;
  try {
    payload = await req.json();
  } catch {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  if (!model) return res.status(400).json({ error: "model is required" });
  if (!message) return res.status(400).json({ error: "message is required" });
  if (message.length > MAX_MESSAGE) {
    return res.status(400).json({ error: `message must be under ${MAX_MESSAGE} characters` });
  }

  let entry;
  try {
    entry = await resolvePrompt(payload.entryId, payload.prompt);
  } catch (err) {
    return res.status(500).json({ error: `Could not read the prompt: ${err.message}` });
  }
  if (payload.prompt != null && !entry) {
    return res.status(400).json({ error: "prompt must be a non-empty string" });
  }
  if (payload.prompt != null && payload.prompt.length > MAX_PROMPT) {
    return res.status(400).json({ error: `prompt must be under ${MAX_PROMPT} characters` });
  }

  const withPrompt = message.length > 0;
  const run = (prompt) => runLeg({ model, message, systemPrompt: prompt });

  const work = entry
    ? [run(entry.prompt).then(r => ({ label: entry.label, ...r }))]
    : [];
  if (payload.compare) work.push(run(null).then(r => ({ label: "baseline", ...r })));

  const results = await Promise.all(work);

  return res.json({
    model,
    ranBaseline: Boolean(payload.compare),
    results,
    note: entry
      ? undefined
      : "No prompt supplied, so this leg is a baseline only.",
  });
}