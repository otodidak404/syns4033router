
import { getComboById, updateCombo, deleteCombo, getComboByName } from "../../../lib/localDb.js";
import { resetComboRotation } from "../../../../open-sse/services/combo.js";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// A combo's models list is walked with .length and spread into a new array. A
// string satisfies both — "oc/space-bunny-free".length is 20 and [...str] yields
// its characters — so a caller that posted models as a string instead of a list
// got a combo that tries to call "o", "c" and "/" as model names, and the error
// names a provider nobody configured. Coerce nothing; refuse it.
function validateModels(models) {
  if (models === undefined || models === null) return { ok: true };
  if (!Array.isArray(models)) {
    return { ok: false, error: "models must be an array of model names" };
  }
  for (const m of models) {
    if (typeof m !== "string" || !m.trim()) {
      return { ok: false, error: "every entry in models must be a non-empty string" };
    }
  }
  return { ok: true };
}


// GET /api/combos/[id] - Get combo by ID
export async function GET_handler(req, res, { params }) {
  try {
    const { id } = await params;
    const combo = await getComboById(id);
    
    if (!combo) {
      return res.status(404).json({ error: "Combo not found" });
    }
    
    return res.json(combo);
  } catch (error) {
    console.log("Error fetching combo:", error);
    return res.status(500).json({ error: "Failed to fetch combo" });
  }
}

// PUT /api/combos/[id] - Update combo
export async function PUT_handler(req, res, { params }) {
  try {
    const { id } = await params;
    const body = req.body;
    
    const modelsCheck = validateModels(body.models);
    if (!modelsCheck.ok) {
      return res.status(400).json({ error: modelsCheck.error });
    }

    // Validate name format if provided
    if (body.name) {
      if (!VALID_NAME_REGEX.test(body.name)) {
        return res.status(400).json({ error: "Name can only contain letters, numbers, -, _ and ." });
      }
      
      // Check if name already exists (exclude current combo)
      const existing = await getComboByName(body.name);
      if (existing && existing.id !== id) {
        return res.status(400).json({ error: "Combo name already exists" });
      }
    }
    
    // Capture previous name to invalidate rotation state on rename
    const prev = await getComboById(id);
    const combo = await updateCombo(id, body);
    
    if (!combo) {
      return res.status(404).json({ error: "Combo not found" });
    }

    // Invalidate rotation state (models/strategy/name may have changed)
    if (prev?.name) resetComboRotation(prev.name);
    if (combo.name && combo.name !== prev?.name) resetComboRotation(combo.name);

    return res.json(combo);
  } catch (error) {
    console.log("Error updating combo:", error);
    return res.status(500).json({ error: "Failed to update combo" });
  }
}

// DELETE /api/combos/[id] - Delete combo
export async function DELETE_handler(req, res, { params }) {
  try {
    const { id } = await params;
    const prev = await getComboById(id);
    const success = await deleteCombo(id);
    
    if (!success) {
      return res.status(404).json({ error: "Combo not found" });
    }

    if (prev?.name) resetComboRotation(prev.name);
    
    return res.json({ success: true });
  } catch (error) {
    console.log("Error deleting combo:", error);
    return res.status(500).json({ error: "Failed to delete combo" });
  }
}
