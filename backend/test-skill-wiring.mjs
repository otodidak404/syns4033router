// Wiring check against the real repo: shipped skills resolve from disk, land in
// every wire format, and chatCore wires them per-model before caveman.
import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

const { listSkillIds, readSkill } = await import(path.join(HERE, "open-sse/rtk/skillLoader.js"));
const { injectSystemText } = await import(path.join(HERE, "open-sse/rtk/systemPrompt.js"));
const { FORMATS } = await import(path.join(HERE, "open-sse/translator/formats.js"));
const chatCoreSrc = fs.readFileSync(path.join(HERE, "open-sse/handlers/chatCore.js"), "utf8");
const chatSrc = fs.readFileSync(path.join(HERE, "src/sse/handlers/chat.js"), "utf8");

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log("wiring (real repo skills)");

t("default skills dir resolves to the repo skills/", () => {
  const ids = listSkillIds();
  assert.ok(ids.length > 0, "found skills");
  assert.ok(ids.includes("9router"), `entry skill present (got: ${ids.join(",")})`);
});

t("every shipped skill id resolves to non-empty markdown", () => {
  for (const id of listSkillIds()) {
    const c = readSkill(id);
    assert.ok(typeof c === "string" && c.length > 0, `${id} has content`);
    assert.ok(!c.startsWith("---"), `${id} frontmatter stripped`);
    assert.ok(c.includes("#"), `${id} looks like markdown`);
  }
});

t("the real entry skill lands in every wire format", () => {
  const cases = [
    [FORMATS.OPENAI, { messages: [{ role: "user", content: "hi" }] }, b => b.messages[0].content],
    [FORMATS.OPENAI_RESPONSES, { input: [{ role: "user", content: "hi" }] }, b => b.input[0].content],
    [FORMATS.CLAUDE, { messages: [] }, b => b.system],
    [FORMATS.GEMINI, { contents: [] }, b => b.systemInstruction.parts[0].text],
    [FORMATS.ANTIGRAVITY, { request: {} }, b => b.request.systemInstruction.parts[0].text],
  ];
  for (const [fmt, body, pick] of cases) {
    assert.ok(injectSystemText(body, fmt, `--- SKILL: 9router ---\n${readSkill("9router")}`), `${fmt} accepted`);
    assert.ok(pick(body).includes("NINEROUTER_URL"), `${fmt} carries the skill body`);
  }
});

t("chatCore resolves skills per-model, not from a global list", () => {
  assert.ok(
    /import \{ injectResolvedSkills \} from "\.\.\/rtk\/modelSkill\.js"/.test(chatCoreSrc),
    "per-model resolver imported");
  assert.ok(
    /injectResolvedSkills\(translatedBody, finalFormat, clientModelId, model, provider\)/.test(chatCoreSrc),
    "called with the client model id and provider");
  assert.ok(!/skillInjection\?\.ids/.test(chatCoreSrc), "global setting no longer read");
});

t("composition order: system prompt → skills → caveman", () => {
  const prompt = chatCoreSrc.indexOf("injectLiveSystemPrompt(translatedBody");
  const skill = chatCoreSrc.indexOf("injectResolvedSkills(translatedBody");
  const caveman = chatCoreSrc.indexOf("injectCaveman(translatedBody");
  assert.ok([prompt, skill, caveman].every(i => i > -1), "all three calls present");
  assert.ok(prompt < skill, "persona leads");
  assert.ok(skill < caveman, "style applies last");
});

t("chat.js no longer forwards the removed global skill setting", () => {
  assert.ok(!/skillInjectionEnabled|skillInjectionIds/.test(chatSrc), "setting removed from the call");
  assert.ok(/clientModelId/.test(chatSrc), "client model id still captured");
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);
console.log(`\nrepo skills: ${listSkillIds().join(", ")}`);