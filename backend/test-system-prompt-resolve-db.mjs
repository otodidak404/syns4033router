// Does the live-prompt resolver reach the database, and does its fallback behave?
//
// pickEntry is pure and was already covered. What is not: resolvePromptForRequest reads
// the library through getSystemPrompts(), and falls back to GODMODE_JB when the library
// has nothing and again when the database itself throws. A stubbed library proves nothing
// about any of that, so this drives the real resolver against a real database.

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-resolve-"));
process.env.DATA_DIR = dir;

const rt = path.join(HERE, "open-sse/rtk");
const { resolvePromptForRequest, injectLiveSystemPrompt } = await import(path.join(rt, "livePrompt.js"));
const { injectSystemText, readSystemText } = await import(path.join(rt, "systemPrompt.js"));
const { FORMATS } = await import(path.join(HERE, "open-sse/translator/formats.js"));
const localDb = await import(path.join(HERE, "src/lib/localDb.js"));

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });
function drain() {
  for (const { name, fn } of queue) {
    try { fn(); pass++; console.log(`  ok   ${name}`); }
    catch (e) { process.exitCode = 1; console.log(`  FAIL ${name}\n       ${e?.message || e}`); }
  }
  console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

t("the resolver reads a row the database actually holds", async () => {
  const created = await localDb.createSystemPrompt({
    label: "DB Persona", model: "oc/db-model", prompt: "You come from the database.",
    isActive: true, isLive: true,
  });
  assert.ok(created?.id, "the row was not created");

  const rows = await localDb.getSystemPrompts();
  assert.ok(rows.some((r) => r.id === created.id), "the row is not in the library");

  const hit = await resolvePromptForRequest("oc/db-model", "oc/db-model");
  assert.ok(hit, "the resolver returned nothing for a row it had just written");
  assert.equal(hit.label, "DB Persona");
  assert.match(hit.prompt, /You come from the database\./);
});

t("the saved prompt reaches a real request body", async () => {
  const body = { messages: [{ role: "user", content: "hi" }] };
  const injected = await injectLiveSystemPrompt(body, FORMATS.OPENAI, "oc/db-model", "oc/db-model");
  assert.ok(injected, "injectLiveSystemPrompt injected nothing");
  assert.equal(injected.label, "DB Persona");
  assert.match(readSystemText(body, FORMATS.OPENAI), /You come from the database\./,
    "the prompt from the database is not in the body a provider would receive");
});

t("the resolver is idempotent against the same body", async () => {
  const body = { messages: [] };
  await injectLiveSystemPrompt(body, FORMATS.OPENAI, "oc/db-model", "oc/db-model");
  await injectLiveSystemPrompt(body, FORMATS.OPENAI, "oc/db-model", "oc/db-model");
  const sys = readSystemText(body, FORMATS.OPENAI);
  assert.equal(sys.split("--- SYSTEM PROMPT: DB Persona ---").length - 1, 1,
    "the same prompt landed twice, which would double its cost on every retry");
});

t("a model with no entry resolves to nothing while the env fallback is unset", async () => {
  delete process.env.GODMODE_JB;
  const hit = await resolvePromptForRequest("oc/unknown-model", "oc/unknown-model");
  assert.equal(hit, null, "an unmatched model picked up some other persona");
});

t("the library wins over the env fallback", async () => {
  process.env.GODMODE_JB = "ENV FALLBACK";
  const hit = await resolvePromptForRequest("oc/db-model", "oc/db-model");
  assert.equal(hit.label, "DB Persona", "the env fallback overrode a library entry");
});

t("the env fallback is used only when the library has no match", async () => {
  process.env.GODMODE_JB = "ENV FALLBACK";
  const hit = await resolvePromptForRequest("oc/other-model", "oc/other-model");
  assert.ok(hit, "nothing was returned and the env fallback was configured");
  assert.equal(hit.model, "*", "the env fallback is not marked as the global target");
  delete process.env.GODMODE_JB;
});

t("a deactivated row stops being injected", async () => {
  const rows = await localDb.getSystemPrompts();
  const row = rows.find((r) => r.label === "DB Persona");
  await localDb.updateSystemPrompt(row.id, { isActive: false });
  const hit = await resolvePromptForRequest("oc/db-model", "oc/db-model");
  assert.equal(hit, null, "a deactivated prompt was still injected");
  await localDb.updateSystemPrompt(row.id, { isActive: true });
});

t("deleting the row stops the injection", async () => {
  const rows = await localDb.getSystemPrompts();
  const row = rows.find((r) => r.label === "DB Persona");
  await localDb.deleteSystemPrompt(row.id);
  const hit = await resolvePromptForRequest("oc/db-model", "oc/db-model");
  assert.equal(hit, null, "the prompt survived its row");
});

// Marked async so drain() can await it; the suite is the only consumer.
async function drainAsync() {
  for (const { name, fn } of queue) {
    try { await fn(); pass++; console.log(`  ok   ${name}`); }
    catch (e) { process.exitCode = 1; console.log(`  FAIL ${name}\n       ${e?.message || e}`); }
  }
  console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
await drainAsync();