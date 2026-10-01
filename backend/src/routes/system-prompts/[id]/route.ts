import {
  getSystemPromptById, updateSystemPrompt, deleteSystemPrompt, getSystemPromptByModel,
} from "../../../lib/localDb.js";

const MAX_PROMPT_CHARS = 200_000;
const MAX_LABEL_CHARS = 200;

function isValidModel(model) {
  return typeof model === "string"
    && model.trim().length > 0
    && model.length <= 300
    && !/[\x00-\x1f]/.test(model);
}

// GET /api/system-prompts/[id]
export async function GET_handler(req, res, { params }) {
  try {
    const { id } = await params;
    const entry = await getSystemPromptById(id);
    if (!entry) return res.status(404).json({ error: "System prompt not found" });
    return res.json(entry);
  } catch (error) {
    console.log("Error fetching system prompt:", error);
    return res.status(500).json({ error: "Failed to fetch system prompt" });
  }
}

// PUT /api/system-prompts/[id] — edit prompt text, label, or the two toggles
export async function PUT_handler(req, res, { params }) {
  try {
    const { id } = await params;
    const body = req.body || {};

    const current = await getSystemPromptById(id);
    if (!current) return res.status(404).json({ error: "System prompt not found" });

    const patch = {};

    if (body.label !== undefined) {
      if (!body.label || !body.label.trim()) {
        return res.status(400).json({ error: "Label is required" });
      }
      if (body.label.length > MAX_LABEL_CHARS) {
        return res.status(400).json({ error: "Label too long" });
      }
      patch.label = body.label.trim();
    }

    if (body.model !== undefined) {
      if (!isValidModel(body.model)) {
        return res.status(400).json({ error: "Model is required" });
      }
      const model = body.model.trim();
      if (model !== current.model) {
        const clash = await getSystemPromptByModel(model);
        if (clash && clash.id !== id) {
          return res.status(400).json({ error: "A prompt for this model already exists" });
        }
      }
      patch.model = model;
    }

    if (body.prompt !== undefined) {
      if (typeof body.prompt !== "string" || !body.prompt.trim()) {
        return res.status(400).json({ error: "Prompt is required" });
      }
      if (body.prompt.length > MAX_PROMPT_CHARS) {
        return res.status(400).json({ error: "Prompt too large" });
      }
      patch.prompt = body.prompt;
    }

    if (body.isActive !== undefined) {
      if (typeof body.isActive !== "boolean") {
        return res.status(400).json({ error: "isActive must be a boolean" });
      }
      patch.isActive = body.isActive;
    }

    if (body.isLive !== undefined) {
      if (typeof body.isLive !== "boolean") {
        return res.status(400).json({ error: "isLive must be a boolean" });
      }
      patch.isLive = body.isLive;
    }

    const entry = await updateSystemPrompt(id, patch);
    return res.json(entry);
  } catch (error) {
    console.log("Error updating system prompt:", error);
    return res.status(500).json({ error: "Failed to update system prompt" });
  }
}

// DELETE /api/system-prompts/[id]
export async function DELETE_handler(req, res, { params }) {
  try {
    const { id } = await params;
    const ok = await deleteSystemPrompt(id);
    if (!ok) return res.status(404).json({ error: "System prompt not found" });
    return res.json({ success: true });
  } catch (error) {
    console.log("Error deleting system prompt:", error);
    return res.status(500).json({ error: "Failed to delete system prompt" });
  }
}