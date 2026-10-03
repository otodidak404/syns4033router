// POST /api/settings/database — the highest-blast-radius write on /dashboard/profile.
//
// importDb is a wipe followed by inserts. A payload with nothing to insert therefore
// deletes the entire database and reports success. Measured, before the fix:
//
//   before   webhook_secret: keepme   apiKeys: 1   connections: 1
//   importDb({}) -> 200 {"settings":{},"providerConnections":[], ...}
//   after    webhook_secret: (empty)  apiKeys: 0   connections: 0
//
// Losing the webhook secret and every API key to a file the operator picked by mistake
// is not a recoverable mistake, so the import now has to say what it is restoring.

import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname);
process.chdir(HERE);
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "importdb-"));

const db = await import(pathToFileURL(path.join(HERE, "src/lib/localDb.js")).href);

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });
async function drain() {
  for (const { name, fn } of queue) {
    try { await fn(); pass++; console.log(`  ok   ${name}`); }
    catch (e) { process.exitCode = 1; console.log(`  FAIL ${name}\n       ${e?.message || e}`); }
  }
  console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);
}

async function seed() {
  await db.updateSettings({ ammail_webhook_secret: "keepme", requireApiKey: true });
  await db.createProviderConnection({ provider: "tavily", name: "t1", apiKey: "k", isActive: true });
}

const count = async () => ({
  settings: (await db.getSettings()).ammail_webhook_secret,
  conns: (await db.getProviderConnections()).length,
  keys: (await db.getApiKeys()).length,
});

t("an empty payload is refused and nothing is deleted", async () => {
  await seed();
  const before = await count();
  assert.equal(before.settings, "keepme");
  assert.ok(before.conns > 0 && before.keys >= 0);
  await assert.rejects(() => db.importDb({}), /Refusing to import an empty database/);
  const after = await count();
  assert.equal(after.settings, "keepme", "the webhook secret was wiped anyway");
  assert.equal(after.conns, before.conns, "the connections were wiped anyway");
});

t("a payload of empty collections is refused too", async () => {
  await seed();
  for (const payload of [
    { settings: {}, providerConnections: [], apiKeys: [], combos: [] },
    { settings: null, providerConnections: null },
    { mitmAlias: {}, customModels: [] },
    { pricing: "", modelAliases: {} },
  ]) {
    await assert.rejects(() => db.importDb(payload),
      /Refusing to import an empty database/, `${JSON.stringify(payload)} was accepted`);
  }
  const after = await count();
  assert.equal(after.settings, "keepme", "one of those payloads still wiped the database");
  assert.ok(after.conns > 0);
});

t("a real export is still accepted", async () => {
  await seed();
  const dump = await db.exportDb();
  assert.ok(dump && typeof dump === "object", "exportDb returned nothing");
  const r = await db.importDb(dump);
  assert.ok(r, "a real export was refused");
  const after = await count();
  assert.equal(after.settings, "keepme", "the restored export lost the webhook secret");
  assert.ok(after.conns > 0, "the restored export lost the connections");
});

t("a payload carrying only settings is still accepted", async () => {
  await seed();
  const r = await db.importDb({ settings: { ammail_webhook_secret: "from-import" } });
  assert.ok(r, "a settings-only import was refused");
  assert.equal((await db.getSettings()).ammail_webhook_secret, "from-import");
});

t("a non-object payload is still refused", async () => {
  await seed();
  for (const bad of [null, undefined, "text", 42, [1, 2]]) {
    await assert.rejects(() => db.importDb(bad), /Invalid database payload/,
      `${JSON.stringify(bad)} was accepted`);
  }
  assert.equal((await db.getSettings()).ammail_webhook_secret, "keepme");
});

t("the route reports the refusal as a 400 rather than a success", async () => {
  const { POST_handler } = await import(
    pathToFileURL(path.join(HERE, "dist/routes/settings/database/route.js")).href);
  const r = { code: 200, body: null };
  await POST_handler({ body: {} }, { status(c) { r.code = c; return this; },
                                     json(b) { r.body = b; return r; } });
  assert.equal(r.code, 400, `the route answered ${r.code}: ${JSON.stringify(r.body)}`);
  assert.ok(r.body?.error, "the refusal carried no message");
});

t("the frontend shows the refusal instead of a false success", () => {
  const page = fs.readFileSync(
    path.join(HERE, "../frontend/src/pages/profile/page.jsx"), "utf8");
  const at = page.indexOf('fetch("/api/settings/database"');
  const seg = page.slice(at, at + 900);
  assert.ok(seg.includes("throw new Error") || seg.includes("if (!res.ok)"),
    "the import path no longer checks the status");
  assert.ok(!/success:\s*true/.test(seg),
    "the page reports a success it did not verify");
});

/** res.json takes one argument; walk each call to see if a second one is passed. */
function twoArgJsonCalls(src) {
  const out = [];
  for (const m of src.matchAll(/res\.json\(/g)) {
    let i = m.index + m[0].length;
    let depth = 1;
    let commas = 0;
    let str = null;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (str) {
        if (c === "\\") { i += 2; continue; }
        if (c === str) str = null;
      } else if (c === '"' || c === "'" || c === "`") str = c;
      else if ("([{".includes(c)) depth += 1;
      else if (")]}\"".includes(c)) depth -= 1;
      else if (c === "," && depth === 1) commas += 1;
      i += 1;
    }
    if (commas >= 1) out.push(src.slice(0, m.index).split("\n").length);
  }
  return out;
}

t("no route passes a second argument to res.json", () => {
  const offenders = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, f.name);
      if (f.isDirectory()) walk(full);
      else if (/\.(ts|js)$/.test(f.name)) {
        for (const ln of twoArgJsonCalls(fs.readFileSync(full, "utf8"))) {
          offenders.push(`${path.relative(path.join(HERE, "src"), full)}:${ln}`);
        }
      }
    }
  };
  walk(path.join(HERE, "src"));
  assert.deepEqual(offenders, [],
    `res.json was called with a second argument, which Express drops:\n${offenders.join("\n")}`);
});

await drain();
try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }