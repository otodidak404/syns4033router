// Per-model skill assignments. A skill is injected only for the models it is
// assigned to, so capability docs don't get shipped to an image model.

import {
  getModelSkills, createModelSkill, getModelsForSkill,
} from "../../lib/localDb.js";
import { listSkillIds, readSkill } from "../../../open-sse/rtk/skillLoader.js";

export const dynamic = "force-dynamic";

const isValidModel = m =>
  typeof m === "string" && m.trim().length > 0 && m.length <= 300 && !/[\x00-\x1f]/.test(m);

const bareName = m => (m.includes("/") ? m.slice(m.lastIndexOf("/") + 1) : m);

// GET /api/model-skills — assignments plus the on-disk catalogue
// GET /api/model-skills?skillId=… — just which models use that skill
export async function GET(req, res) {
  try {
    const skillId = req.query?.skillId;
    if (skillId) {
      return res.json({ skillId, models: await getModelsForSkill(String(skillId)) });
    }

    const [assignments, ids] = await Promise.all([getModelSkills(), listSkillIds()]);

    // Only list skills still on disk; never surface one whose SKILL.md is gone.
    const skills = ids
      .map(id => {
        const content = readSkill(id);
        if (!content) return null;
        const mine = assignments.filter(a => a.skillId === id);
        return {
          id,
          chars: content.length,
          models: mine.map(a => a.model),
          activeModels: mine.filter(a => a.isActive).map(a => a.model),
        };
      })
      .filter(Boolean);

    return res.json({ assignments, skills });
  } catch (error) {
    console.log("Error fetching model skills:", error);
    return res.status(500).json({ error: "Failed to fetch model skills" });
  }
}

// POST /api/model-skills — assign a skill to a model
export async function POST_handler(req, res) {
  try {
    const { model, skillId, isActive } = req.body || {};

    if (!isValidModel(model)) return res.status(400).json({ error: "Model is required" });
    if (!skillId || typeof skillId !== "string") {
      return res.status(400).json({ error: "Skill is required" });
    }
    if (!readSkill(skillId)) {
      return res.status(400).json({ error: "Skill not found on disk" });
    }

    const modelTrimmed = model.trim();
    const bare = bareName(modelTrimmed);
    const clash = (await getModelSkills()).find(
      a => a.skillId === skillId && (a.model === modelTrimmed || a.model === bare)
    );
    if (clash) return res.status(400).json({ error: "Already assigned to this model" });

    return res.status(201).json(await createModelSkill({
      model: modelTrimmed,
      skillId,
      isActive: isActive === false ? false : true,
    }));
  } catch (error) {
    console.log("Error creating model skill:", error);
    return res.status(500).json({ error: "Failed to assign skill" });
  }
}
