// Format-aware system-prompt injection.
// Shared by caveman.js and modelSkill.js so both land in the same
// system slot for a given wire format — one shape, one place to fix.

import { FORMATS } from "../translator/formats.js";

const SEP = "\n\n";

/**
 * Read the current system-prompt text for a format, or "" when absent.
 * Used to keep injection idempotent.
 */
export function readSystemText(body, format) {
  if (!body) return "";

  switch (format) {
    case FORMATS.CLAUDE: {
      const sys = body.system;
      if (typeof sys === "string") return sys;
      if (Array.isArray(sys)) return sys.map(b => b?.text || "").join("\n");
      return "";
    }
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
    case FORMATS.ANTIGRAVITY: {
      const target = body.request && typeof body.request === "object" ? body.request : body;
      const sys = target.system_instruction ?? target.systemInstruction;
      if (sys && Array.isArray(sys.parts)) return sys.parts.map(p => p?.text || "").join("\n");
      return "";
    }
    default: {
      if (typeof body.instructions === "string") return body.instructions;
      const arr = Array.isArray(body.messages) ? body.messages
        : Array.isArray(body.input) ? body.input
        : null;
      if (!arr) return "";
      const msg = arr.find(m => m && (m.role === "system" || m.role === "developer"));
      if (!msg) return "";
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        return msg.content.map(p => (p && typeof p.text === "string" ? p.text : "")).join("\n");
      }
      return "";
    }
  }
}

/**
 * Merge `text` into the system prompt of `body`, dispatching on wire format.
 * @returns {boolean} true when the text was placed somewhere
 */
export function injectSystemText(body, format, text) {
  if (!body || typeof text !== "string" || text.length === 0) return false;

  switch (format) {
    case FORMATS.CLAUDE:
      return injectClaudeSystem(body, text);
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
    case FORMATS.ANTIGRAVITY:
      // Antigravity wraps the Gemini shape in body.request
      return injectGeminiSystem(body, text);
    default:
      // OpenAI and OpenAI-shaped formats (responses/codex/cursor/kiro/ollama)
      return injectMessagesSystem(body, text);
  }
}

// OpenAI-shaped: messages[] (chat) or input[] (responses) or instructions (string)
function injectMessagesSystem(body, text) {
  // OpenAI Responses API: top-level string field
  if (typeof body.instructions === "string") {
    body.instructions = body.instructions ? `${body.instructions}${SEP}${text}` : text;
    return true;
  }

  const arr = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : null;
  if (!arr) return false;

  const idx = arr.findIndex(m => m && (m.role === "system" || m.role === "developer"));
  if (idx >= 0) {
    appendToOpenAIMessage(arr[idx], text);
  } else {
    arr.unshift({ role: "system", content: text });
  }
  return true;
}

function appendToOpenAIMessage(msg, text) {
  if (typeof msg.content === "string") {
    msg.content = `${msg.content}${SEP}${text}`;
  } else if (Array.isArray(msg.content)) {
    // Responses-style array of parts {type:"input_text"|"text", text}
    const last = msg.content[msg.content.length - 1];
    if (last && (last.type === "input_text" || last.type === "text")) {
      last.text = `${last.text || ""}${SEP}${text}`;
    } else {
      msg.content.push({ type: "input_text", text });
    }
  } else {
    msg.content = text;
  }
}

// Claude shape: body.system as string | array of {type:"text", text}
// Insert before the last cache_control block to keep the text inside the cached prefix.
function injectClaudeSystem(body, text) {
  if (typeof body.system === "string" && body.system.length > 0) {
    body.system = `${body.system}${SEP}${text}`;
    return true;
  }
  if (Array.isArray(body.system)) {
    const block = { type: "text", text };
    let lastCacheIdx = -1;
    for (let i = body.system.length - 1; i >= 0; i--) {
      if (body.system[i]?.cache_control) { lastCacheIdx = i; break; }
    }
    if (lastCacheIdx >= 0) {
      body.system.splice(lastCacheIdx, 0, block);
    } else {
      body.system.push(block);
    }
    return true;
  }
  body.system = text;
  return true;
}

// Gemini shape: body.system_instruction | body.systemInstruction | body.request.systemInstruction
// Each shape: { parts: [{ text }] }
function injectGeminiSystem(body, text) {
  const target = body.request && typeof body.request === "object" ? body.request : body;
  const useSnake = Object.prototype.hasOwnProperty.call(target, "system_instruction");
  const key = useSnake ? "system_instruction" : "systemInstruction";
  const sys = target[key];
  if (sys && Array.isArray(sys.parts)) {
    const last = sys.parts[sys.parts.length - 1];
    if (last && typeof last.text === "string") {
      last.text = `${last.text}${SEP}${text}`;
    } else {
      sys.parts.push({ text });
    }
    return true;
  }
  target[key] = { parts: [{ text }] };
  return true;
}