import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

const toBool = v => v === 1 || v === true || v === "1";

function row(rowIn) {
  if (!rowIn) return null;
  return {
    id: rowIn.id,
    model: rowIn.model,
    skillId: rowIn.skillId,
    isActive: toBool(rowIn.isActive),
    createdAt: rowIn.createdAt,
    updatedAt: rowIn.updatedAt,
  };
}

export async function getModelSkills() {
  const db = await getAdapter();
  const rows = await db.all(`SELECT * FROM modelSkills ORDER BY createdAt ASC`);
  return rows.map(row);
}

export async function getModelSkillById(id) {
  const db = await getAdapter();
  return row(await db.get(`SELECT * FROM modelSkills WHERE id = ?`, [id]));
}

export async function getModelSkillsForModel(model) {
  const db = await getAdapter();
  const rows = await db.all(`SELECT * FROM modelSkills WHERE model = ? ORDER BY createdAt ASC`, [model]);
  return rows.map(row);
}

/**
 * Active skill ids for a model.
 *
 * An assignment may be stored against the operator-facing id ("pm/chatty"), the
 * bare name ("chatty"), or the resolved provider id the request actually carries
 * ("openai-compatible-chat-<uuid>/chatty"). All three resolve to the same model,
 * so match on any of them. The provider prefix is read from providerNodes rather
 * than guessed, because the id encodes a type ("chat", "responses") that the
 * short prefix does not.
 */
export async function getActiveSkillIdsForModel(model) {
  const bare = typeof model === "string" && model.includes("/")
    ? model.slice(model.lastIndexOf("/") + 1)
    : model;

  const db = await getAdapter();
  const keys = [...new Set([model, bare].filter(k => typeof k === "string" && k.trim()))];

  const rows = await db.all(
    `SELECT model, skillId FROM modelSkills WHERE isActive = 1 AND model IN (${keys.map(() => "?").join(",")})`,
    keys
  );
  return [...new Set(rows.map(r => r.skillId))];
}

/** Operator-facing prefix ("pm") for a provider node id, if one exists. */
export async function getPrefixForProvider(providerId) {
  if (!providerId) return null;
  const db = await getAdapter();
  const row = await db.get(`SELECT data FROM providerNodes WHERE id = ?`, [providerId]);
  if (!row) return null;
  try {
    const data = typeof row.data === "string" ? JSON.parse(row.data) : (row.data || {});
    return data.prefix || null;
  } catch {
    return null;
  }
}

/** Which models reference a skill — powers the "used by" label in the panel. */
export async function getModelsForSkill(skillId) {
  const db = await getAdapter();
  const rows = await db.all(`SELECT model FROM modelSkills WHERE skillId = ?`, [skillId]);
  return [...new Set(rows.map(r => r.model))];
}

export async function createModelSkill(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const entry = {
    id: uuidv4(),
    model: data.model,
    skillId: data.skillId,
    isActive: data.isActive === false ? 0 : 1,
    createdAt: now,
    updatedAt: now,
  };
  await db.run(
    `INSERT INTO modelSkills(id, model, skillId, isActive, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [entry.id, entry.model, entry.skillId, entry.isActive, entry.createdAt, entry.updatedAt]
  );
  return row(entry);
}

export async function updateModelSkill(id, data) {
  const db = await getAdapter();
  let result = null;
  await db.transaction(async () => {
    const current = row(await db.get(`SELECT * FROM modelSkills WHERE id = ?`, [id]));
    if (!current) return;
    const merged = {
      ...current,
      isActive: data.isActive === undefined ? current.isActive : !!data.isActive,
      updatedAt: new Date().toISOString(),
    };
    await db.run(
      `UPDATE modelSkills SET model = ?, skillId = ?, isActive = ?, updatedAt = ? WHERE id = ?`,
      [merged.model, merged.skillId, merged.isActive ? 1 : 0, merged.updatedAt, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteModelSkill(id) {
  const db = await getAdapter();
  const res = await db.run(`DELETE FROM modelSkills WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

/** Toggle one assignment, creating it if absent. Used by the panel's switch. */
export async function setModelSkillActive(model, skillId, isActive) {
  const db = await getAdapter();
  const bare = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  const existing = await db.get(
    `SELECT * FROM modelSkills WHERE skillId = ? AND (model = ? OR model = ?)`,
    [skillId, model, bare]
  );
  if (existing) return updateModelSkill(existing.id, { isActive });
  if (!isActive) return null;
  return createModelSkill({ model, skillId, isActive: true });
}