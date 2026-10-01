import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function toBool(v) {
  return v === 1 || v === true || v === "1";
}

function rowToPrompt(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    model: row.model,
    prompt: row.prompt,
    isActive: toBool(row.isActive),
    isLive: toBool(row.isLive),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getSystemPrompts() {
  const db = await getAdapter();
  const rows = await db.all(`SELECT * FROM systemPrompts ORDER BY createdAt ASC`);
  return rows.map(rowToPrompt);
}

export async function getSystemPromptById(id) {
  const db = await getAdapter();
  return rowToPrompt(await db.get(`SELECT * FROM systemPrompts WHERE id = ?`, [id]));
}

export async function getSystemPromptByModel(model) {
  const db = await getAdapter();
  return rowToPrompt(await db.get(`SELECT * FROM systemPrompts WHERE model = ?`, [model]));
}

/**
 * Prompts the gateway must inject for `model`, in library order.
 * Only entries that are both Aktif and live qualify — matches the panel's
 * "LIVE" badge, which the screenshot shows on every entry.
 */
export async function getLivePromptsForModel(model) {
  const entry = await getSystemPromptByModel(model);
  if (!entry || !entry.isActive || !entry.isLive) return [];
  return [entry.prompt];
}

/** All live prompts across every model — the "Load semua" behaviour. */
export async function getAllLivePrompts() {
  const all = await getSystemPrompts();
  return all.filter(e => e.isActive && e.isLive).map(e => e.prompt);
}

export async function createSystemPrompt(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const entry = {
    id: uuidv4(),
    label: data.label,
    model: data.model,
    prompt: data.prompt ?? "",
    isActive: data.isActive === false ? 0 : 1,
    isLive: data.isLive === true ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  };
  await db.run(
    `INSERT INTO systemPrompts(id, label, model, prompt, isActive, isLive, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.id, entry.label, entry.model, entry.prompt, entry.isActive, entry.isLive, entry.createdAt, entry.updatedAt]
  );
  return entry;
}

export async function updateSystemPrompt(id, data) {
  const db = await getAdapter();
  let result = null;
  await db.transaction(async () => {
    const row = await db.get(`SELECT * FROM systemPrompts WHERE id = ?`, [id]);
    if (!row) return;
    const cur = rowToPrompt(row);
    const merged = {
      ...cur,
      ...data,
      // Booleans must be normalized; a merged 0/"false" would read as truthy.
      isActive: data.isActive === undefined ? cur.isActive : !!data.isActive,
      isLive: data.isLive === undefined ? cur.isLive : !!data.isLive,
      updatedAt: new Date().toISOString(),
    };
    await db.run(
      `UPDATE systemPrompts SET label = ?, model = ?, prompt = ?, isActive = ?, isLive = ?, updatedAt = ? WHERE id = ?`,
      [merged.label, merged.model, merged.prompt, merged.isActive ? 1 : 0, merged.isLive ? 1 : 0, merged.updatedAt, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteSystemPrompt(id) {
  const db = await getAdapter();
  const res = await db.run(`DELETE FROM systemPrompts WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}