import {
  getSystemPrompts, createSystemPrompt, getSystemPromptByModel,
} from "../../lib/localDb.js";

export const dynamic = "force-dynamic";

const MAX_PROMPT_CHARS = 200_000;
const MAX_LABEL_CHARS = 200;

// Model ids are wire syntax provider/model — guard length and control chars.
function isValidModel(model) {
  return typeof model === "string"
    && model.trim().length > 0
    && model.length <= 300
    && !/[\x00-\x1f]/.test(model);
}

// GET /api/system-prompts - list library entries + live count
export async function GET(req, res) {
  try {
    const entries = await getSystemPrompts();
    return res.json({
      entries,
      total: entries.length,
      live: entries.filter(e => e.isActive && e.isLive).length,
    });
  } catch (error) {
    console.log("Error fetching system prompts:", error);
    return res.status(500).json({ error: "Failed to fetch system prompts" });
  }
}

// POST /api/system-prompts - create entry
export async function POST_handler(req, res) {
  try {
    const { label, model, prompt, isActive, isLive } = req.body || {};

    if (!label || !label.trim()) {
      return res.status(400).json({ error: "Label is required" });
    }
    if (!isValidModel(model)) {
      return res.status(400).json({ error: "Model is required" });
    }
    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "Prompt is required" });
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return res.status(400).json({ error: "Prompt too large" });
    }
    if (label.length > MAX_LABEL_CHARS) {
      return res.status(400).json({ error: "Label too long" });
    }

    // One entry per model — the panel binds a prompt to a single model.
    const existing = await getSystemPromptByModel(model.trim());
    if (existing) {
      return res.status(400).json({ error: "A prompt for this model already exists" });
    }

    const entry = await createSystemPrompt({
      label: label.trim(),
      model: model.trim(),
      prompt,
      isActive: isActive === false ? false : true,
      isLive: isLive === true,
    });

    return res.status(201).json(entry);
  } catch (error) {
    console.log("Error creating system prompt:", error);
    return res.status(500).json({ error: "Failed to create system prompt" });
  }
}