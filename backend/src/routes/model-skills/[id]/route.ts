import {
  getModelSkillById, updateModelSkill, deleteModelSkill,
} from "../../../lib/localDb.js";
import { readSkill } from "../../../../open-sse/rtk/skillLoader.js";

const isValidModel = m =>
  typeof m === "string" && m.trim().length > 0 && m.length <= 300 && !/[\x00-\x1f]/.test(m);

// PUT /api/model-skills/:id — toggle an assignment, or re-point it
export async function PUT_handler(req, res, { params }) {
  try {
    const { id } = await params;
    const body = req.body || {};
    if (!(await getModelSkillById(id))) return res.status(404).json({ error: "Assignment not found" });

    const patch = {};
    if (body.isActive !== undefined) {
      if (typeof body.isActive !== "boolean") {
        return res.status(400).json({ error: "isActive must be a boolean" });
      }
      patch.isActive = body.isActive;
    }
    if (body.model !== undefined) {
      if (!isValidModel(body.model)) return res.status(400).json({ error: "Model is required" });
      patch.model = body.model.trim();
    }
    if (body.skillId !== undefined) {
      if (!readSkill(body.skillId)) {
        return res.status(400).json({ error: "Skill not found on disk" });
      }
      patch.skillId = body.skillId;
    }

    return res.json(await updateModelSkill(id, patch));
  } catch (error) {
    console.log("Error updating model skill:", error);
    return res.status(500).json({ error: "Failed to update assignment" });
  }
}

// DELETE /api/model-skills/:id
export async function DELETE_handler(req, res, { params }) {
  try {
    const { id } = await params;
    if (!(await deleteModelSkill(id))) return res.status(404).json({ error: "Assignment not found" });
    return res.json({ success: true });
  } catch (error) {
    console.log("Error deleting model skill:", error);
    return res.status(500).json({ error: "Failed to delete assignment" });
  }
}