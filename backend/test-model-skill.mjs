// modelSkill: per-model skill resolution and injection.
// The assignment lookup is stubbed so resolution logic is exercised without a DB.
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9r-ms-"));
process.env.NINEROUTER_SKILLS_DIR = DIR;

// Stub the DB lookup by rewriting the "@/lib/localDb.js" specifier.
const stub = `
let MAP = {};
let PREFIX = {};
export function __set(map, prefixMap) { MAP = map; PREFIX = prefixMap || {}; }
export async function getActiveSkillIdsForModel(model) { return MAP[model] || []; }
export async function getPrefixForProvider(providerId) { return PREFIX[providerId] || null; }
`;
fs.writeFileSync(path.join(DIR, "dbStub.js"), stub);

const src = fs.readFileSync(path.join(HERE, "open-sse/rtk/modelSkill.js"), "utf8");
const patched = src
  .replace(/from "@\/lib\/localDb\.js"/, `from "${path.join(DIR, "dbStub.js")}"`)
  .replace(/from "\.\/systemPrompt\.js"/, `from "${path.join(HERE, "open-sse/rtk/systemPrompt.js")}"`)
  .replace(/from "\.\/skillLoader\.js"/, `from "${path.join(HERE, "open-sse/rtk/skillLoader.js")}"`);
if (patched === src) {
  console.error("FATAL: could not rewrite imports — specifiers changed?");
  process.exit(1);
}
const modPath = path.join(DIR, "modelSkill.mjs");
fs.writeFileSync(modPath, patched);

const { resolveSkillIds, injectResolvedSkills } = await import(modPath);
const { FORMATS } = await import(path.join(HERE, "open-sse/translator/formats.js"));
const db = await import(path.join(DIR, "dbStub.js"));

// A skill the loader can actually read.
fs.mkdirSync(path.join(DIR, "chat-doc"), { recursive: true });
fs.writeFileSync(path.join(DIR, "chat-doc", "SKILL.md"), "---\nname: chat-doc\n---\n\nCHAT-DOC-BODY");

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const sysOf = body => body.messages.filter(m => m.role === "system").map(m => m.content).join("\n");

console.log("modelSkill (per-model skill injection)");

// ── resolution ──────────────────────────────────────────────────────────────
await t("exact public id matches its assignment", async () => {
  db.__set({ "oc/big-pickle": ["chat-doc"] });
  assert.deepStrictEqual(await resolveSkillIds("oc/big-pickle", "big-pickle"), ["chat-doc"]);
});

await t("unassigned model resolves to nothing", async () => {
  db.__set({ "oc/big-pickle": ["chat-doc"] });
  assert.deepStrictEqual(await resolveSkillIds("other/model", "model"), []);
});

await t("bare model name matches a bare assignment", async () => {
  db.__set({ "big-pickle": ["chat-doc"] });
  assert.deepStrictEqual(await resolveSkillIds("", "big-pickle"), ["chat-doc"]);
});

await t("same skill via two keys is injected once", async () => {
  db.__set({ "oc/m": ["chat-doc"], "m": ["chat-doc"] });
  assert.deepStrictEqual(await resolveSkillIds("oc/m", "m"), ["chat-doc"]);
});

await t("assignments from both keys merge in order", async () => {
  db.__set({ "oc/m": ["chat-doc"], m: [] });
  assert.deepStrictEqual(await resolveSkillIds("oc/m", "m"), ["chat-doc"]);
});

await t("panel prefix resolves a request carrying the provider id", async () => {
  // Assigned as "pm/chatty"; the request arrives as "<uuid>/chatty" with the
  // node's short prefix looked up from providerNodes.
  db.__set({ "pm/chatty": ["chat-doc"] }, { "openai-compatible-chat-uuid": "pm" });
  const ids = await resolveSkillIds("openai-compatible-chat-uuid/chatty", "chatty", "openai-compatible-chat-uuid");
  assert.deepStrictEqual(ids, ["chat-doc"]);
});

await t("no prefix mapping leaves the request unmatched", async () => {
  db.__set({ "pm/chatty": ["chat-doc"] }, {});
  const ids = await resolveSkillIds("openai-compatible-chat-uuid/chatty", "chatty", "openai-compatible-chat-uuid");
  assert.deepStrictEqual(ids, [], "cannot guess the prefix, so it does not match");
});

await t("empty ids resolve to nothing", async () => {
  db.__set({ "": ["chat-doc"] });
  assert.deepStrictEqual(await resolveSkillIds("", ""), []);
});

// ── injection ───────────────────────────────────────────────────────────────
await t("injects into openai messages[]", async () => {
  db.__set({ "oc/m": ["chat-doc"] });
  const body = { messages: [{ role: "user", content: "hi" }] };
  const r = await injectResolvedSkills(body, FORMATS.OPENAI, "oc/m", "m");
  assert.deepStrictEqual(r, ["chat-doc"]);
  assert.strictEqual(body.messages[0].role, "system");
  assert.ok(sysOf(body).includes("CHAT-DOC-BODY"));
  assert.strictEqual(body.messages[1].content, "hi");
});

await t("injects into claude body.system, preserving the client's", async () => {
  db.__set({ "oc/m": ["chat-doc"] });
  const body = { system: "ORIG", messages: [] };
  await injectResolvedSkills(body, FORMATS.CLAUDE, "oc/m", "m");
  assert.ok(body.system.startsWith("ORIG"));
  assert.ok(body.system.includes("CHAT-DOC-BODY"));
});

await t("injects into gemini system_instruction", async () => {
  db.__set({ "oc/m": ["chat-doc"] });
  const body = { system_instruction: { parts: [{ text: "ORIG" }] }, contents: [] };
  await injectResolvedSkills(body, FORMATS.GEMINI, "oc/m", "m");
  assert.ok(body.system_instruction.parts[0].text.includes("ORIG"));
  assert.ok(body.system_instruction.parts[0].text.includes("CHAT-DOC-BODY"));
});

await t("injects into antigravity body.request", async () => {
  db.__set({ "oc/m": ["chat-doc"] });
  const body = { request: {} };
  await injectResolvedSkills(body, FORMATS.ANTIGRAVITY, "oc/m", "m");
  assert.ok(body.request.systemInstruction.parts[0].text.includes("CHAT-DOC-BODY"));
});

await t("injects into responses input[]", async () => {
  db.__set({ "oc/m": ["chat-doc"] });
  const body = { input: [{ role: "user", content: "hi" }] };
  await injectResolvedSkills(body, FORMATS.OPENAI_RESPONSES, "oc/m", "m");
  assert.strictEqual(body.input[0].role, "system");
});

await t("re-injecting the same skill does not stack it", async () => {
  db.__set({ "oc/m": ["chat-doc"] });
  const body = { messages: [] };
  await injectResolvedSkills(body, FORMATS.OPENAI, "oc/m", "m");
  const once = sysOf(body);
  const second = await injectResolvedSkills(body, FORMATS.OPENAI, "oc/m", "m");
  assert.deepStrictEqual(second, [], "second pass injects nothing");
  assert.strictEqual(sysOf(body), once, "body unchanged");
});

await t("assigned-but-missing skill on disk is skipped", async () => {
  db.__set({ "oc/m": ["ghost-skill"] });
  const body = { messages: [] };
  assert.deepStrictEqual(await injectResolvedSkills(body, FORMATS.OPENAI, "oc/m", "m"), []);
});

await t("null body is safe", async () => {
  db.__set({ "oc/m": ["chat-doc"] });
  assert.deepStrictEqual(await injectResolvedSkills(null, FORMATS.OPENAI, "oc/m", "m"), []);
});

await t("unassigned model leaves body untouched", async () => {
  db.__set({});
  const body = { messages: [{ role: "user", content: "hi" }] };
  assert.deepStrictEqual(await injectResolvedSkills(body, FORMATS.OPENAI, "other/m", "m"), []);
  assert.strictEqual(body.messages.length, 1);
});

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);