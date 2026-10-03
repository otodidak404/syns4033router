
import { getPricing, updatePricing, resetPricing, resetAllPricing } from "../../lib/localDb.js";
import { getDefaultPricing } from "../../shared/constants/pricing.js";

/**
 * GET /api/pricing
 * Get current pricing configuration (merged user + defaults)
 */
export async function GET(req, res) {
  try {
    const pricing = await getPricing();
    return res.json(pricing);
  } catch (error) {
    console.error("Error fetching pricing:", error);
    return res.status(500).json({ error: "Failed to fetch pricing" });
  }
}

/**
 * PATCH /api/pricing
 * Update pricing configuration
 * Body: { provider: { model: { input, output, cached, ... } } }
 */
export async function PATCH_handler(req, res) {
  try {
    const body = req.body;

    // Validate body structure
    if (typeof body !== "object" || body === null) {
      return res.status(400).json({ error: "Invalid pricing data format" });
    }

    // Validate pricing structure
    for (const [provider, models] of Object.entries(body)) {
      if (typeof models !== "object" || models === null) {
        return res.status(400).json({ error: `Invalid pricing for provider: ${provider}` });
      }

      for (const [model, pricing] of Object.entries(models)) {
        if (typeof pricing !== "object" || pricing === null) {
          return res.status(400).json({ error: `Invalid pricing for model: ${provider}/${model}` });
        }

        // Validate pricing fields
        const validFields = ["input", "output", "cached", "reasoning", "cache_creation"];
        for (const [key, value] of Object.entries(pricing)) {
          if (!validFields.includes(key)) {
            return res.status(400).json({ error: `Invalid pricing field: ${key} for ${provider}/${model}` });
          }
          if (typeof value !== "number" || isNaN(value) || value < 0) {
            return res.status(400).json({ error: `Invalid pricing value for ${key} in ${provider}/${model}: must be non-negative number` });
          }
        }
      }
    }

    const updatedPricing = await updatePricing(body);
    return res.json(updatedPricing);
  } catch (error) {
    console.error("Error updating pricing:", error);
    return res.status(500).json({ error: "Failed to update pricing" });
  }
}

/**
 * DELETE /api/pricing
 * Reset pricing to defaults
 * Query params: ?provider=xxx&model=yyy (optional)
 */
export async function DELETE_handler(req, res) {
  try {
    const { searchParams } = new URL('http://localhost' + req.originalUrl);
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");

    if (provider && model) {
      // Reset specific model
      await resetPricing(provider, model);
    } else if (provider) {
      // Reset entire provider
      await resetPricing(provider);
    } else {
      // Reset all pricing
      await resetAllPricing();
    }

    const pricing = await getPricing();
    return res.json(pricing);
  } catch (error) {
    console.error("Error resetting pricing:", error);
    return res.status(500).json({ error: "Failed to reset pricing" });
  }
}

/**
 * GET /api/pricing/defaults
 * Get default pricing configuration
 */
export async function GET_DEFAULTS(req, res) {
  try {
    const defaultPricing = getDefaultPricing();
    return res.json(defaultPricing);
  } catch (error) {
    console.error("Error fetching default pricing:", error);
    return res.status(500).json({ error: "Failed to fetch default pricing" });
  }
}