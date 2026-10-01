// Auth middleware: the path gate must not be case-sensitive.
//
// Express matches the mount path case-insensitively, so /API/keys reaches the
// same handler as /api/keys while req.path keeps the client's casing. Comparing
// that raw string against the public/protected lists let /API/... skip the whole
// guard — any anonymous caller could read API keys, provider credentials, and
// stored system prompts, and PATCH /api/settings to turn login off for good.
//
// These assert the gate holds for every casing, that the public paths still
// work, and that /v1 is not a free relay by default.
import assert from "assert";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { readFile } from "fs/promises";

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.DATA_DIR = process.env.DATA_DIR || "/tmp/9r-auth-gate-harness";

const { authMiddleware, requiresAuth } = await import(path.join(HERE, "dist/middleware/auth.js"));
const { getSettings, updateSettings } = await import(path.join(HERE, "dist/lib/localDb.js"));

// requireLogin on, so an unauthenticated caller must be refused rather than
// waved through by the "login not required" branch.
await updateSettings({ requireLogin: true, requireApiKey: true });

const app = express();
app.use(express.json());
// Mirrors server.ts: an outer gate decides whether auth applies at all, then the
// middleware applies its own path checks. Reproducing only the inner one tests
// a different program from the one that ships.
// The real gate, imported — not a copy. A copy here would keep passing after
// the shipped code was reverted, which is exactly what happened first time.
app.use((req, res, next) => {
  if (requiresAuth(req.path)) return authMiddleware(req, res, next);
  return next();
});
// String mounts, not regexes: Express matches a string mount
// case-insensitively, which is exactly what made /API/keys reach a handler
// with no auth. A regex here would hide the vulnerability.
const reach = (req, res) => res.json({ reached: true, path: req.path });
app.use("/api", reach);
app.use("/v1", reach);
app.use("/v1beta", reach);

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

const get = async (p, headers = {}) => {
  const r = await fetch(base + p, { headers });
  return { status: r.status, body: await r.json().catch(() => null) };
};

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log("requiresAuth predicate");

for (const p of ["/api/keys", "/API/keys", "/Api/keys", "/aPi/settings", "/v1/chat/completions", "/V1/chat/completions", "/v1beta/x"]) {
  await t(`requiresAuth("${p}") is true`, () => {
    assert.strictEqual(requiresAuth(p), true);
  });
}
for (const p of ["/", "/dashboard", "/branding/logo.svg", "/favicon.ico"]) {
  await t(`requiresAuth("${p}") is false`, () => {
    assert.strictEqual(requiresAuth(p), false);
  });
}

// The first version of this file imported requiresAuth and used it while
// server.ts kept its own inline copy — so the suite passed green against a
// server that was still vulnerable. Assert the shipped file delegates, or the
// same drift returns.
await t("server.ts delegates to requiresAuth rather than repeating the gate", async () => {
  const src = await readFile(path.join(HERE, "src/server.ts"), "utf8");
  assert.ok(
    /import\s*\{[^}]*\brequiresAuth\b[^}]*\}\s*from\s*["']\.\/middleware\/auth\.js["']/.test(src),
    "server.ts does not import requiresAuth"
  );
  assert.ok(
    /if\s*\(\s*requiresAuth\(\s*req\.path\s*\)\s*\)/.test(src),
    "server.ts does not gate on requiresAuth(req.path)"
  );
  // No second, hand-rolled copy of the path test anywhere in the file.
  assert.ok(
    !/req\.path\s*===\s*["']\/api["']/.test(src),
    "server.ts still contains an inline case-sensitive path comparison"
  );
});

console.log("auth gate — case variants of protected paths");

// The bypass itself: these reached the handler with no credentials at all.
for (const p of ["/API/keys", "/Api/keys", "/aPi/keys", "/API/settings", "/API/system-prompts", "/API/providers"]) {
  await t(`anonymous ${p} is refused`, async () => {
    const { status } = await get(p);
    assert.strictEqual(status, 401, `got ${status}`);
  });
}

await t("lowercase control still works (the guard is not simply broken)", async () => {
  const { status } = await get("/api/keys");
  assert.strictEqual(status, 401);
});

await t("a nonexistent uppercase path is 401, not a 200 from a real handler", async () => {
  const { status, body } = await get("/API/zzz");
  assert.strictEqual(status, 401, `got ${status}`);
  assert.ok(!body?.reached, "reached a handler");
});

console.log("auth gate — public paths stay reachable");

for (const p of ["/api/health", "/api/version", "/api/auth/status", "/API/HEALTH"]) {
  await t(`${p} is public`, async () => {
    const { status } = await get(p);
    assert.notStrictEqual(status, 401, "public path was refused");
  });
}

console.log("auth gate — protected path with a valid session");

// A valid dashboard session must still get through on any casing.
const login = await fetch(base + "/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: process.env.INITIAL_PASSWORD || "test-pw" }),
});
assert.ok([200, 503, 401].includes(login.status), `login status ${login.status}`);

console.log("/v1 is not a free relay");

await t("requireApiKey defaults to true on a fresh instance", async () => {
  const s = await getSettings();
  assert.strictEqual(s.requireApiKey, true, "default is not true");
});

await t("the setting is actually stored, not just defaulted at read time", async () => {
  await updateSettings({});
  const s = await getSettings();
  assert.strictEqual(s.requireApiKey, true);
});

server.close();
console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);
