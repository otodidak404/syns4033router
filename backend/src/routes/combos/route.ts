
import { getCombos, createCombo, getComboByName } from "../../lib/localDb.js";

export const dynamic = "force-dynamic";

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


// GET /api/combos - Get all combos
export async function GET(req, res) {
  try {
    const combos = await getCombos();
    return res.json({ combos });
  } catch (error) {
    console.log("Error fetching combos:", error);
    return res.status(500).json({ error: "Failed to fetch combos" });
  }
}

// POST /api/combos - Create new combo
export async function POST_handler(req, res) {
  try {
    const body = req.body;
    const { name, models, kind } = body;

    if (!name) {
      return res.status(400).json({ error: "Name is required" });
    }

    // Validate name format
    if (!VALID_NAME_REGEX.test(name)) {
      return res.status(400).json({ error: "Name can only contain letters, numbers, -, _ and ." });
    }

    const modelsCheck = validateModels(models);
    if (!modelsCheck.ok) {
      return res.status(400).json({ error: modelsCheck.error });
    }

    // Check if name already exists
    const existing = await getComboByName(name);
    if (existing) {
      return res.status(400).json({ error: "Combo name already exists" });
    }

    const combo = await createCombo({ name, models: models || [], kind: kind || null });

    return res.status(201).json(combo);
  } catch (error) {
    console.log("Error creating combo:", error);
    return res.status(500).json({ error: "Failed to create combo" });
  }
}
