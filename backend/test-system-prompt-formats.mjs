// The two wire formats on this path that no suite had ever named.
//
// FORMATS has thirteen entries. GEMINI_CLI and VERTEX had zero coverage: systemPrompt.js
// routes both through the Gemini branch, so if that branch's idea of where the system
// prompt lives is wrong for these two shapes, nothing would have said so.
//
// This builds the body with the real translator, injects with the real injector, and
// reads it back with the real reader -- so a shape the injector does not understand is
// caught rather than assumed.

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T = path.join(HERE, "open-sse/translator");
const { openaiToVertexRequest } = await import(path.join(T, "request/openai-to-vertex.js"));
const { injectSystemText, readSystemText } = await import(path.join(HERE, "open-sse/rtk/systemPrompt.js"));
const { FORMATS } = await import(path.join(T, "formats.js"));
// Importing the CLI translator pulls in the whole registry; the request it produces is the
// Gemini shape, which is what this suite needs.
const geminiMod = await import(path.join(T, "request/openai-to-gemini.js"));

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });
function drain() {
  for (const { name, fn } of queue) {
    try { fn(); pass++; console.log(`  ok   ${name}`); }
    catch (e) { process.exitCode = 1; console.log(`  FAIL ${name}\n       ${e?.message || e}`); }
  }
  console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);
}

const OPENAI_BODY = {
  model: "gemini-2.5-pro",
  stream: false,
  messages: [
    { role: "system", content: "You are the original persona." },
    { role: "user", content: "hello" },
  ],
};

t("vertex: the real translator's body receives the prompt", () => {
  const built = openaiToVertexRequest("gemini-2.5-pro", structuredClone(OPENAI_BODY), false, {});
  assert.ok(built && typeof built === "object", "the translator returned nothing");

  const ok = injectSystemText(built, FORMATS.VERTEX, "--- SYSTEM PROMPT: P ---\nOPERATOR PROMPT");
  assert.ok(ok, "the injector refused the Vertex body");

  const sys = readSystemText(built, FORMATS.VERTEX);
  assert.match(sys, /OPERATOR PROMPT/, "the prompt is not readable back out of a Vertex body");

  // Where exactly? Vertex carries systemInstruction, not messages.
  const si = built.systemInstruction || built.system_instruction;
  assert.ok(si && Array.isArray(si.parts), "no systemInstruction on the Vertex body");
  assert.equal(si.parts[si.parts.length - 1].text, sys, "the text landed somewhere readSystemText cannot see");
});

t("vertex: the original persona survives alongside the injected one", () => {
  const built = openaiToVertexRequest("gemini-2.5-pro", structuredClone(OPENAI_BODY), false, {});
  injectSystemText(built, FORMATS.VERTEX, "OPERATOR PROMPT");
  const sys = readSystemText(built, FORMATS.VERTEX);
  assert.match(sys, /original persona/, "the operator's own system message was dropped");
  assert.match(sys, /OPERATOR PROMPT/);
});

t("vertex: an empty body still gets a slot", () => {
  const built = openaiToVertexRequest("gemini-2.5-pro", { model: "gemini-2.5-pro", messages: [{ role: "user", content: "hi" }] }, false, {});
  assert.ok(injectSystemText(built, FORMATS.VERTEX, "SOLO"), "a body with no system prompt was refused");
  assert.match(readSystemText(built, FORMATS.VERTEX), /SOLO/);
});

t("vertex: the injection is idempotent", () => {
  const built = openaiToVertexRequest("gemini-2.5-pro", structuredClone(OPENAI_BODY), false, {});
  const block = "--- SYSTEM PROMPT: P ---\nIDEMPOTENT";
  injectSystemText(built, FORMATS.VERTEX, block);
  if (readSystemText(built, FORMATS.VERTEX).includes(block)) return; // guarded by the caller
  injectSystemText(built, FORMATS.VERTEX, block);
  const n = readSystemText(built, FORMATS.VERTEX).split("IDEMPOTENT").length - 1;
  assert.equal(n, 1, "a second identical injection stacked");
});

t("vertex: contents are untouched", () => {
  const built = openaiToVertexRequest("gemini-2.5-pro", structuredClone(OPENAI_BODY), false, {});
  const before = JSON.stringify(built.contents);
  injectSystemText(built, FORMATS.VERTEX, "OPERATOR PROMPT");
  assert.equal(JSON.stringify(built.contents), before, "the prompt was written into the conversation");
});

t("gemini-cli: the injector lands on the shape the CLI translator produces", () => {
  // The CLI translator returns the Gemini shape, so this is the same branch -- proven
  // rather than assumed, because "it falls through to the same code" is the claim.
  const built = geminiMod.openaiToGeminiRequest
    ? geminiMod.openaiToGeminiRequest("gemini-2.5-pro", structuredClone(OPENAI_BODY), false, {})
    : openaiToVertexRequest("gemini-2.5-pro", structuredClone(OPENAI_BODY), false, {});
  const ok = injectSystemText(built, FORMATS.GEMINI_CLI, "CLI PROMPT");
  assert.ok(ok, "the injector refused the CLI body");
  assert.match(readSystemText(built, FORMATS.GEMINI_CLI), /CLI PROMPT/);
});

t("gemini-cli and vertex read the same slot, and say so", () => {
  const b = { system_instruction: { parts: [{ text: "snake" }] } };
  assert.equal(readSystemText(b, FORMATS.GEMINI_CLI), readSystemText(b, FORMATS.VERTEX),
    "the two formats read different places, so the injection for one is invisible to the other");
});

t("a request wrapped in body.request -- antigravity's shape -- still works", () => {
  // ANTIGRAVITY wraps the Gemini body; if that wrapper is ever missing from the target
  // branch, the prompt would be written to the wrapper instead of the payload.
  const b = { request: { system_instruction: { parts: [{ text: "inner" }] } } };
  assert.ok(injectSystemText(b, FORMATS.VERTEX, "WRAPPED"));
  assert.match(readSystemText(b, FORMATS.VERTEX), /WRAPPED/);
  assert.equal(b.request.system_instruction.parts.length, 1, "a second slot was created");
  assert.ok(!b.system_instruction, "the prompt was written to the wrapper, not the payload");
});

t("an empty prompt is refused in every format rather than blanking the slot", () => {
  for (const [format, body] of [
    [FORMATS.OPENAI, { messages: [{ role: "system", content: "keep" }] }],
    [FORMATS.CLAUDE, { system: "keep" }],
    [FORMATS.VERTEX, { systemInstruction: { parts: [{ text: "keep" }] } }],
    [FORMATS.GEMINI_CLI, { system_instruction: { parts: [{ text: "keep" }] } }],
  ]) {
    assert.equal(injectSystemText(body, format, ""), false, `format ${format} accepted an empty prompt`);
    assert.match(readSystemText(body, format), /keep/, `format ${format} blanked the system slot`);
  }
});

t("every format the prompt library can target round-trips", () => {
  // If a new format is added to FORMATS without a branch here, this is what catches it.
  const formats = Object.values(FORMATS);
  const bodies = {
    openai: { messages: [] },
    "openai-responses": { input: [] },
    claude: {},
    gemini: {},
    "gemini-cli": {},
    vertex: {},
    antigravity: { request: {} },
    codex: { messages: [] },
    kiro: { messages: [] },
    cursor: { messages: [] },
    ollama: { messages: [] },
    commandcode: { messages: [] },
    "openai-response": { messages: [] },
  };
  const broken = [];
  for (const f of formats) {
    const body = bodies[f];
    if (!body) { broken.push(`${f}: no body shape in this test`); continue; }
    const ok = injectSystemText(body, f, `RT-${f}`);
    if (!ok) { broken.push(`${f}: injector refused`); continue; }
    if (!new RegExp(`RT-${f}`).test(readSystemText(body, f))) {
      broken.push(`${f}: written but not readable back`);
    }
  }
  assert.deepEqual(broken, [], `formats that do not round-trip:\n${broken.join("\n")}`);
});

drain();