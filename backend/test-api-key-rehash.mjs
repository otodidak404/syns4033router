// Keys were stored in the clear before bca7ab6 and hashed after. validateApiKey()
// only ever looked up sha256(salt:key), so a plaintext row stopped matching the
// moment hashing landed and every key the operator already had began returning
// 401 — while the dashboard kept working, because it authenticates on a session
// cookie rather than an API key.
//
// Nothing bridged the two, so those keys stayed dead for the life of the
// database. Migration 3 rescues them and must be safe to run more than once.
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

const HERE = path.dirname(new URL(import.meta.url).pathname);

// Must be set before driver.js is imported: it reads DATA_DIR at module load.
// A throwaway directory keeps this test's writes off the developer's database.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rehash-"));
process.env.DATA_DIR = dir;

const { MIGRATIONS, latestVersion } = await import(
  path.join(HERE, "src/lib/db/migrations/index.js")
);
const { validateApiKey, createApiKey } = await import(
  path.join(HERE, "src/lib/db/repos/apiKeysRepo.js")
);
const { getAdapter } = await import(
  path.join(HERE, "src/lib/db/driver.js")
);

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const IS_SHA256_HEX = /^[0-9a-f]{64}$/;

// Boot once so the schema is real, then reopen the same file with the sync
// driver. The migration runner hands `up()` the raw sync adapter (initAdapter
// calls runMigrationOnce before wrapping it for callers), and the public
// getAdapter() only ever returns the async wrapper — so this is the only way to
// hand the migration the same interface it actually receives.
await getAdapter();
const DATA_FILE = path.join(process.env.DATA_DIR, "db", "data.sqlite");
const raw = new Database(DATA_FILE);
const db = {
  all: (sql, params = []) => raw.prepare(sql).all(params),
  get: (sql, params = []) => raw.prepare(sql).get(params),
  run: (sql, params = []) => raw.prepare(sql).run(params),
  exec: (sql) => raw.exec(sql),
};

const m3 = MIGRATIONS.find(x => x.version === 3);

t("migration 3 is registered, so a deploy runs it", () => {
  assert.ok(m3, "no migration with version 3");
  assert.strictEqual(m3.name, "rehash-plaintext-api-keys");
  assert.strictEqual(typeof m3.up, "function");
});

t("versions are unique and increasing", () => {
  const v = MIGRATIONS.map(x => x.version);
  assert.deepStrictEqual(v, [...v].sort((a, b) => a - b));
  assert.strictEqual(new Set(v).size, v.length);
});

t("latestVersion is 3", () => {
  assert.strictEqual(latestVersion(), 3);
});

// Seed keys the way the pre-hash version wrote them, alongside a current one.
const LEGACY = "sk-issued-before-hashing-0001";
const OTHER = "sk-issued-before-hashing-0002";
const modern = await createApiKey("modern", "m");
for (const [id, key] of [["old-1", LEGACY], ["old-2", OTHER]]) {
  db.run(
    `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt)
     VALUES(?, ?, ?, ?, 1, ?)`,
    [id, key, id, "m", new Date().toISOString()]
  );
}

const beforeRehash = await validateApiKey(LEGACY);
t("a plaintext row is rejected before the migration runs", () => {
  // The reported symptom: a key the operator has had all along, answering 401.
  assert.strictEqual(beforeRehash, false);
});

const firstRun = m3.up(db);

t("both plaintext keys were re-hashed and the hashed one skipped", () => {
  assert.strictEqual(firstRun.rehashed, 2);
  assert.strictEqual(firstRun.skipped, 1);
});

const stored = db.all("SELECT name, key FROM apiKeys");
t("no stored key is still plaintext", () => {
  for (const r of stored) {
    assert.ok(IS_SHA256_HEX.test(r.key), `${r.name} still plaintext: ${r.key.slice(0, 20)}`);
  }
});

const legacyAfter = await validateApiKey(LEGACY);
const otherAfter = await validateApiKey(OTHER);
const modernAfter = await validateApiKey(modern.key);
const strangerAfter = await validateApiKey("sk-never-issued-9999");

t("a key issued before hashing now authenticates", () => {
  assert.strictEqual(legacyAfter, true);
});

t("the second legacy key authenticates too", () => {
  assert.strictEqual(otherAfter, true);
});

t("a key issued after hashing still authenticates", () => {
  assert.strictEqual(modernAfter, true);
});

t("an unrelated key is still rejected", () => {
  assert.strictEqual(strangerAfter, false);
});

const snapshot = db.all("SELECT id, key FROM apiKeys ORDER BY id")
  .map(r => `${r.id}:${r.key}`).join("|");
const secondRun = m3.up(db);
const snapshot2 = db.all("SELECT id, key FROM apiKeys ORDER BY id")
  .map(r => `${r.id}:${r.key}`).join("|");

t("running it a second time changes nothing", () => {
  assert.strictEqual(secondRun.rehashed, 0, "a second run re-hashed something");
  assert.strictEqual(snapshot, snapshot2);
});

const legacyAfterRerun = await validateApiKey(LEGACY);
t("the rescued key still authenticates after a second run", () => {
  assert.strictEqual(legacyAfterRerun, true);
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);
raw.close();
fs.rmSync(dir, { recursive: true, force: true });