
import { exportDb, getSettings, importDb } from "../../../lib/localDb.js";
import { applyOutboundProxyEnv } from "../../../lib/network/outboundProxy.js";

export async function GET(req, res) {
  try {
    const payload = await exportDb();
    return res.json(payload);
  } catch (error) {
    console.log("Error exporting database:", error);
    return res.status(500).json({ error: "Failed to export database" });
  }
}

export async function POST_handler(req, res) {
  try {
    const payload = req.body;
    await importDb(payload);

    // Ensure proxy settings take effect immediately after a DB import.
    try {
      const settings = await getSettings();
      applyOutboundProxyEnv(settings);
    } catch (err) {
      console.warn("[Settings][DatabaseImport] Failed to re-apply outbound proxy env:", err);
    }

    return res.json({ success: true });
  } catch (error) {
    console.log("Error importing database:", error);
    // res.json takes one argument. Passing { status } as a second was ignored, so a
    // refused import answered HTTP 200 -- and the dashboard, which checks res.ok,
    // reported it as a successful restore.
    return res.status(400).json({ error: error?.message || "Failed to import database" });
  }
}
