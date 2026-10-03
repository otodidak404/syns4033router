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

import { handleChat } from "../../../sse/handlers/chat.js";
import { injectSystemText } from "../../../../open-sse/rtk/systemPrompt.js";
import { getSystemPrompts } from "../../../lib/localDb.js";
import { markInternal } from "../../../lib/auth/internalCall.js";
import { GLOBAL_TARGET } from "../../../../open-sse/rtk/livePrompt.js";

export const dynamic = "force-dynamic";

const MAX_MESSAGE = 8000;
// Matches MAX_PROMPT_CHARS on the routes that store an entry, so a prompt that
// saves is a prompt that can be tested. The two limits drifted apart: a 33k
// prompt saved fine and then could not be run, which looked like the prompt
// was broken when only the test button was.
const MAX_PROMPT = 200_000;
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
function textFromJson(j) {
  return j?.choices?.[0]?.message?.content
    ?? j?.choices?.[0]?.delta?.content
    ?? j?.content?.[0]?.text
    ?? j?.candidates?.[0]?.content?.parts?.[0]?.text
    ?? "";
}

/**
 * Why did this run produce no text?
 *
 * A missing model, a model that exists but has no key, and a provider that
 * answered with an error body all arrive here as "no text", so the one message
 * left an operator with three unrelated causes and no way to tell them apart.
 * The upstream body carries the reason; it was being read and discarded.
 */
function failureReason(raw) {
  const text = typeof raw === "string" ? raw : raw == null ? "" : JSON.stringify(raw);
  if (!text.trim()) return "The model returned no text for this run.";
  for (const candidate of [text, text.slice(0, text.lastIndexOf("}") + 1)]) {
    const head = candidate.trim();
    if (!head.startsWith("{")) continue;
    try {
      const body = JSON.parse(head);
      const err = body?.error ?? body?.message ?? body?.detail;
      if (typeof err === "string" && err.trim()) return err.trim().slice(0, 240);
      if (err && typeof err === "object" && typeof err.message === "string") {
        return err.message.trim().slice(0, 240);
      }
    } catch { /* not this shape — fall through to the next reading */ }
  }
  return "The model returned no text for this run.";
}

function extractText(raw) {
  if (!raw) return "";
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);

  // A JSON body can arrive with an SSE terminator welded onto its tail:
  //
  //   {"id":"...","choices":[...]}data: [DONE]\n\n
  //
  // — no newline between the closing brace and the frame. So the mere presence of
  // "data:" does not mean the body is a stream; only lines that *begin* with it
  // are frames. Testing with includes() sent every such body down the SSE path,
  // where the one JSON line did not start with "data:" and the only frame that
  // did was [DONE] — so every run reported an empty reply.
  //
  // Both readings are attempted, JSON first, because a stream is much rarer than
  // a JSON body carrying a terminator.
  for (const candidate of [text, text.slice(0, text.lastIndexOf("}") + 1)]) {
    const head = candidate.trim();
    if (!head.startsWith("{")) continue;
    try {
      const out = textFromJson(JSON.parse(head));
      if (out) return out;
    } catch { /* not this shape — try the next reading */ }
  }

  const parts = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      parts.push(textFromJson(JSON.parse(payload)));
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

  const started = Date.now();
  // TIMEOUT_MS was declared here and never used: a provider that accepted the
  // connection and then said nothing held the request open until the client gave up,
  // and the dashboard sat on "Running…" with no outcome and no reason.
  // Not an AbortSignal: handleChat takes (request, clientRawRequest), so passing one
  // would land in the wrong parameter and be silently ignored while still corrupting
  // the other. A race is the honest way to bound a call whose signature does not offer
  // a handle on it.
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`__TIMEOUT__${TIMEOUT_MS}`)), TIMEOUT_MS);
  });
  try {
    const res = await Promise.race([handleChat(req), timeout]);
    const raw = typeof res === "string" ? res : await res?.text?.();
    const text = extractText(raw);
    // A run that produced no text did not succeed — it failed in a way that left
    // nothing to show. Reporting it as ok:true rendered "(empty reply)" in the
    // dashboard, which is the one result an operator cannot act on.
    return text
      ? { ok: true, text, latencyMs: Date.now() - started }
      : {
          ok: false,
          error: failureReason(raw),
          latencyMs: Date.now() - started,
        };
  } catch (err) {
    const message = String(err?.message || err);
    const timedOut = message.startsWith("__TIMEOUT__");
    return {
      ok: false,
      error: timedOut
        ? `No reply after ${TIMEOUT_MS / 1000}s. The model may be down, or it may not answer this prompt.`
        : message,
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function POST_handler(req, res) {
  // express.json() has already consumed the body by the time a handler runs,
  // so req.json() here reads a stream that is already drained. Every other route
  // reads req.body directly.
  const payload = req.body;
  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ error: "A JSON body is required" });
  }

  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  if (!model) return res.status(400).json({ error: "model is required" });
  if (!message) return res.status(400).json({ error: "message is required" });

  // The global entry's model is the wildcard "*", which selects every model at
  // injection time and names none of them. Handing it to handleChat resolves no
  // provider and returns in milliseconds, which the dashboard then reports as an
  // empty reply — indistinguishable from a prompt that broke. A test has to name
  // one concrete model, so say that instead of running nothing.
  if (model === GLOBAL_TARGET) {
    return res.status(400).json({
      error: "Pick a concrete model to test against — this entry targets every model, so there is nothing to run it on.",
    });
  }
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
  // An entryId that resolves to nothing is a stale id -- the entry was deleted after
  // the page loaded. The run used to carry on without the prompted leg, so with
  // "compare" ticked the operator saw a baseline and nothing else, which reads as
  // "my prompt made no difference"; with it unticked the response carried an empty
  // results array and the page rendered nothing at all.
  if (payload.prompt == null && payload.entryId && !entry) {
    return res.status(404).json({
      error: "That system prompt no longer exists. Reload the page and pick another entry.",
    });
  }
  if (payload.prompt != null && payload.prompt.length > MAX_PROMPT) {
    return res.status(400).json({ error: `prompt must be under ${MAX_PROMPT} characters` });
  }

  const run = (prompt) => runLeg({ model, message, systemPrompt: prompt });

  const work = entry
    ? [run(entry.prompt).then(r => ({ label: entry.label, ...r }))]
    : [];
  if (payload.compare) work.push(run(null).then(r => ({ label: "baseline", ...r })));

  const results = await Promise.all(work);

  // Nothing to run is a request the operator got wrong, not an empty success.
  if (results.length === 0) {
    return res.status(400).json({
      error: "Nothing to run: no prompt was supplied and the baseline was turned off.",
    });
  }

  return res.json({
    model,
    ranBaseline: Boolean(payload.compare),
    results,
    note: entry
      ? undefined
      : "No prompt supplied, so this leg is a baseline only.",
  });
}