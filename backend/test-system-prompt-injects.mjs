// The tier that decides whether this menu does anything at all: does a prompt saved on
// /dashboard/system-prompt actually reach the request body a provider receives?
//
// The modules were tested in isolation already. This runs the real pickEntry against a
// real library and feeds the winner through the real format-aware injector, then reads
// the body back -- so a prompt that resolves but lands nowhere fails here.

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RTK = path.join(HERE, "open-sse/rtk");
const { pickEntry } = await import(path.join(RTK, "livePrompt.js"));
const { injectSystemText, readSystemText } = await import(path.join(RTK, "systemPrompt.js"));
const { FORMATS } = await import(path.join(HERE, "open-sse/translator/formats.js"));

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

const entry = (model, label, isActive = true, isLive = true, prompt = `P:${label}`) =>
  ({ model, label, prompt, isActive, isLive });

// ── resolution ──────────────────────────────────────────────────────────────

t("an exact id wins", () => {
  const hit = pickEntry([entry("oc/big-pickle", "A")], "oc/big-pickle", "oc/big-pickle");
  assert.equal(hit.label, "A");
});

t("a per-model entry wins over the wildcard", () => {
  const hit = pickEntry([entry("*", "GLOBAL"), entry("oc/big-pickle", "A")], "oc/big-pickle", "oc/big-pickle");
  assert.equal(hit.label, "A", "the global entry shadowed the specific one");
});

t("the wildcard catches a model with no entry of its own", () => {
  const hit = pickEntry([entry("*", "GLOBAL")], "oc/something-else", "oc/something-else");
  assert.equal(hit.label, "GLOBAL");
});

t("an inactive or non-live entry is never injected", () => {
  for (const e of [entry("oc/m", "off", false, true), entry("oc/m", "draft", true, false), entry("oc/m", "both", false, false)]) {
    assert.equal(pickEntry([e], "oc/m", "oc/m"), null, `${e.label} was injected while it should not be`);
  }
});

t("an ambiguous bare name falls through to the wildcard, not to a guess", () => {
  const lib = [entry("openai-compatible-x/big-pickle", "X"), entry("oc/big-pickle", "A"), entry("*", "GLOBAL")];
  const hit = pickEntry(lib, "unknown-prefix/big-pickle", "unknown-prefix/big-pickle");
  assert.ok(hit === null || hit.label === "GLOBAL",
    `an ambiguous name resolved to ${hit?.label}, which may be the wrong persona`);
});

// ── the body actually changes ────────────────────────────────────────────────

t("an openai chat body receives the prompt", () => {
  const hit = pickEntry([entry("oc/m", "Persona", true, true, "You are terse.")], "oc/m", "oc/m");
  const body = { messages: [{ role: "user", content: "hi" }] };
  const ok = injectSystemText(body, FORMATS.OPENAI, `--- SYSTEM PROMPT: ${hit.label} ---\n${hit.prompt}`);
  assert.ok(ok);
  const sys = body.messages[0];
  assert.equal(sys.role, "system", "the prompt did not land in a system message");
  assert.match(sys.content, /You are terse\./);
  assert.equal(body.messages[1].role, "user", "the user turn was displaced");
});

t("an existing system message is appended to, not replaced", () => {
  const body = { messages: [{ role: "system", content: "Existing." }, { role: "user", content: "hi" }] };
  injectSystemText(body, FORMATS.OPENAI, "Added.");
  assert.equal(body.messages[0].content, "Existing.\n\nAdded.");
  assert.equal(body.messages.length, 2, "a second system message was added instead of appending");
});

t("a claude body receives the prompt", () => {
  const body = {};
  assert.ok(injectSystemText(body, FORMATS.CLAUDE, "Persona."));
  assert.match(readSystemText(body, FORMATS.CLAUDE), /Persona\./);
});

t("a gemini body receives the prompt", () => {
  const body = {};
  assert.ok(injectSystemText(body, FORMATS.GEMINI, "Persona."));
  assert.match(readSystemText(body, FORMATS.GEMINI), /Persona\./);
});

t("the prompt is readable back out for every format", () => {
  // readSystemText is what makes injection idempotent; if a format reads back empty the
  // prompt would be injected again on every retry and double its cost each time.
  const bodies = [
    [FORMATS.OPENAI, { messages: [] }],
    [FORMATS.CLAUDE, {}],
    [FORMATS.GEMINI, {}],
    [FORMATS.RESPONSES, { input: [] }],
  ];
  for (const [format, body] of bodies) {
    injectSystemText(body, format, "ROUNDTRIP");
    assert.match(readSystemText(body, format), /ROUNDTRIP/,
      `format ${format} does not read back what was written to it`);
  }
});

t("injectSystemText is an appender, and both callers guard it", () => {
  // The first version of this test asserted idempotence here and failed. That was the
  // test being wrong, not the code: injectSystemText appends by design and the guard
  // belongs in the caller, because only the caller knows the marker it is about to
  // write. So the property that matters is that both callers check first.
  const body = { messages: [] };
  injectSystemText(body, FORMATS.OPENAI, "MARKER");
  injectSystemText(body, FORMATS.OPENAI, "MARKER");
  assert.equal(readSystemText(body, FORMATS.OPENAI).split("MARKER").length - 1, 2,
    "this appender is supposed to append twice; if it ever stops, this test needs revisiting");

  const rtk = fs.readFileSync(path.join(RTK, "livePrompt.js"), "utf8");
  const skill = fs.readFileSync(path.join(RTK, "modelSkill.js"), "utf8");
  const caveman = fs.readFileSync(path.join(RTK, "caveman.js"), "utf8");
  assert.ok(/readSystemText\(body, format\)\.includes\(block\)/.test(rtk),
    "the live prompt no longer checks whether it is already in the body, so a retry would double it");
  assert.ok(/current\.includes\(marker\)/.test(skill),
    "the skill injection no longer checks its marker, so a retry would double it");
  assert.ok(/caveman/i.test(caveman), "the caveman path is gone");
});

t("a body rebuilt per attempt starts clean, so the guards matter", () => {
  // chatCore rebuilds translatedBody for each attempt, so the guard is what keeps a
  // retry inside the same request from stacking two personas.
  const core = fs.readFileSync(path.join(HERE, "open-sse/handlers/chatCore.js"), "utf8");
  assert.ok(/translatedBody = \{ \.\.\.body/.test(core),
    "the body is no longer rebuilt per attempt, which would change what the guards are for");
});

t("a library entry that resolves nothing leaves the body untouched", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(pickEntry([entry("oc/other", "A")], "oc/m", "oc/m"), null);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
});

t("an empty prompt body is refused rather than blanking the system slot", () => {
  const body = { messages: [{ role: "system", content: "Keep me." }] };
  assert.equal(injectSystemText(body, FORMATS.OPENAI, ""), false);
  assert.equal(body.messages[0].content, "Keep me.");
});

drain();