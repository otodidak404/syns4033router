import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { generateApiKeyWithMachine } from "../../../shared/utils/apiKey.js";

// Keys are stored hashed, not in the clear. A database dump — backup, volume
// snapshot, SQL injection elsewhere — should not hand over working credentials.
// The plaintext exists exactly once, in the POST response that creates it.
const KEY_HASH_SALT = "syns4033router-api-key-v1";
// Marker for the router's own self-call key; filtered out of every list.
const INTERNAL_KEY_NAME = "__internal__";
export const hashApiKey = (key) =>
  crypto.createHash("sha256").update(`${KEY_HASH_SALT}:${key}`).digest("hex");

// Row -> API shape for a LIST response. No key field: it is not recoverable.
function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    // Enough to recognise the key in a list without disclosing it.
    keyHint: row.key ? `${String(row.key).slice(0, 3)}${"*".repeat(28)}` : null,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  // The router's own key for self-calls is not a user credential — keep it out
  // of every list the dashboard or usage stats read.
  const rows = await db.all(
    `SELECT * FROM apiKeys WHERE name <> ? ORDER BY createdAt ASC`,
    [INTERNAL_KEY_NAME]
  );
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = await db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
  };
  await db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [apiKey.id, hashApiKey(apiKey.key), apiKey.name, apiKey.machineId, 1, apiKey.createdAt]
  );
  // The caller gets the plaintext exactly once, in the creation response.
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  await db.transaction(async () => {
    const row = await db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    // The key column holds the hash and is deliberately absent from rowToKey —
    // the plaintext is never read back. Writing merged.key therefore wrote
    // undefined into the column, silently storing NULL, and the row stopped
    // matching its own hash: toggling a key's active flag destroyed it. Only
    // the columns an update may legitimately change are written.
    await db.run(
      `UPDATE apiKeys SET name = ?, machineId = ?, isActive = ? WHERE id = ?`,
      [merged.name, merged.machineId, merged.isActive ? 1 : 0, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = await db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  if (typeof key !== "string" || key.length === 0) return false;
  const db = await getAdapter();
  const row = await db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [hashApiKey(key)]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}

// ── Internal key ───────────────────────────────────────────────────────────
// The router calls its own /v1 for model pings, and /v1 enforces requireApiKey.
// Stored keys are hashed, so there is nothing to read back. This mints one
// dedicated internal key on first use and holds it in memory for the process
// lifetime. It is never listed: see getApiKeys(), which filters on name.
let internalKeyPromise = null;

export async function getOrCreateInternalApiKey() {
  if (!internalKeyPromise) {
    internalKeyPromise = (async () => {
      const db = await getAdapter();
      const row = await db.get(
        `SELECT * FROM apiKeys WHERE name = ? ORDER BY createdAt ASC LIMIT 1`,
        [INTERNAL_KEY_NAME]
      );
      if (row) {
        // A key already exists but its plaintext is gone by design. Replace it
        // rather than leaving a record that can never be used.
        await db.run(`DELETE FROM apiKeys WHERE id = ?`, [row.id]);
      }
      // Three levels up, not two: from src/lib/db/repos/ this resolves to
      // src/shared/utils/machineId.js. The two-level form pointed at
      // src/lib/shared/…, which does not exist, so this dynamic import threw
      // ERR_MODULE_NOT_FOUND and the internal key was never minted.
      const machineId = await (await import("../../../shared/utils/machineId.js"))
        .getConsistentMachineId();
      const created = await createApiKey(INTERNAL_KEY_NAME, machineId);
      return created.key;
    })().catch((err) => {
      // A rejected promise cached here would be returned by every later call
      // for the rest of the process lifetime, so one transient failure would
      // disable the internal key until the next restart. Clear it and let the
      // next caller retry.
      internalKeyPromise = null;
      throw err;
    });
  }
  return internalKeyPromise;
}

// Hash -> { name, id } for attributing a request to a key. Usage rows hold the
// key as presented; hashing it here matches both historical plaintext rows and
// anything recorded after keys started being stored hashed.
export async function getApiKeyLookupMap() {
  const db = await getAdapter();
  const rows = await db.all(
    `SELECT id, key, name FROM apiKeys WHERE name <> ?`,
    [INTERNAL_KEY_NAME]
  );
  const map = {};
  for (const row of rows) if (row.key) map[row.key] = { id: row.id, name: row.name };
  return map;
}
