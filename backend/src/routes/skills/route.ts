// API for the dashboard skill-injection picker.
// Lists skill ids present on disk. The PATCH side of the toggle reuses
// /api/settings (skillInjectionEnabled + skillInjectionIds).

// open-sse ships as a separate workspace (backend/open-sse), not under dist/,
// so reach it with a repo-relative path the way the other routes do.
import { listSkillIds } from "../../../open-sse/rtk/skillLoader.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req, res) {
  try {
    const ids = listSkillIds();
    res.set("Cache-Control", "no-store");
    return res.json({ skills: ids });
  } catch (error) {
    console.log("Error listing skills:", error);
    return res.status(500).json({ error: error.message });
  }
}