// Runtime test for livePrompt — the §3.8 gateway injection path.
// pickEntry() is pure, so resolution is tested against the real module with no
// DB stub; injection is tested through the real format-aware injector.
import assert from "assert";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RTK = path.join(HERE, "open-sse/rtk");

const { pickEntry } = await import(path.join(RTK, "livePrompt.js"));
const { injectSystemText } = await import(path.join(RTK, "systemPrompt.js"));
const { FORMATS } = await import(path.join(HERE, "open-sse/translator/formats.js"));

const entry = (model, label, isActive = true, isLive = true, prompt = `P:${label}`) =>
  ({ model, label, prompt, isActive, isLive });

let pass = 0;
const pending = [];

const t = (name, fn) => {
  if (fn.constructor.name === "AsyncFunction") {
    // Defer, don't fire. These tests mutate process.env, so running them
    // concurrently lets one test's cleanup land in the middle of another — the
    // env prompt then leaks or vanishes depending on timing.
    pending.push({ name, fn });
    return;
  }
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

async function drain() {
  for (const { name, fn } of pending) {
    try { await fn(); console.log(`  ok  ${name}`); pass++; }
    catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
  }
}

const sys = body => body.messages.filter(m => m.role === "system").map(m => m.content).join("\n");

console.log("livePrompt");

// ── resolution ──────────────────────────────────────────────────────────────
t("exact id matches", () => {
  assert.strictEqual(pickEntry([entry("oc/big-pickle", "jb")], "oc/big-pickle", "big-pickle").label, "jb");
});

t("inactive entry is skipped", () => {
  assert.strictEqual(pickEntry([entry("oc/m", "x", false, true)], "oc/m", "m"), null);
});

t("isLive=false is skipped", () => {
  assert.strictEqual(pickEntry([entry("oc/m", "x", true, false)], "oc/m", "m"), null);
});

t("needs BOTH toggles", () => {
  assert.strictEqual(pickEntry([entry("oc/m", "x", false, false)], "oc/m", "m"), null);
});

t("no match returns null", () => {
  assert.strictEqual(pickEntry([entry("oc/big-pickle", "jb")], "other/m", "m"), null);
});

t("de-prefixed id matches", () => {
  // gateway rewrote provider/model; the public id is what the entry is keyed on
  assert.strictEqual(
    pickEntry([entry("big-pickle", "jb")], "", "openai-compatible-x/big-pickle").label, "jb");
});

t("bare name matches when unambiguous", () => {
  assert.strictEqual(pickEntry([entry("ohmyqoder/qmodel_38max", "q")], "qmodel_38max", "qmodel_38max").label, "q");
});

t("bare-name collision injects NOTHING rather than guessing", () => {
  assert.strictEqual(
    pickEntry([entry("oc/big-pickle", "a"), entry("qd/big-pickle", "b")], "big-pickle", "big-pickle"), null);
});

t("exact id wins despite bare-name collision", () => {
  const es = [entry("oc/big-pickle", "a"), entry("qd/big-pickle", "b")];
  assert.strictEqual(pickEntry(es, "oc/big-pickle", "big-pickle").label, "a");
});

t("empty library is a no-op", () => assert.strictEqual(pickEntry([], "oc/m", "m"), null));

t("empty ids are safe", () => assert.strictEqual(pickEntry([entry("oc/m", "x")], "", ""), null));

t("whitespace-only ids are ignored", () => {
  assert.strictEqual(pickEntry([entry("oc/m", "x")], "   ", "  "), null);
});

t("most specific key wins when several match", () => {
  const es = [entry("big-pickle", "bare"), entry("oc/big-pickle", "exact")];
  assert.strictEqual(pickEntry(es, "oc/big-pickle", "big-pickle").label, "exact");
});

// ── injection across every wire format ───────────────────────────────────────
const inject = (model, prompt, format, body) => {
  injectSystemText(body, format, `--- SYSTEM PROMPT: ${model} ---\n${prompt}`);
};

t("openai messages[]", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };
  inject("p", "BE-CONCISE", FORMATS.OPENAI, body);
  assert.strictEqual(body.messages[0].role, "system");
  assert.ok(sys(body).includes("BE-CONCISE"));
  assert.strictEqual(body.messages[1].content, "hi");
});

t("claude body.system preserves the client prompt", () => {
  const body = { system: "ORIG", messages: [] };
  inject("p", "BE-CONCISE", FORMATS.CLAUDE, body);
  assert.ok(body.system.startsWith("ORIG"));
  assert.ok(body.system.includes("BE-CONCISE"));
});

t("gemini: new body gets systemInstruction", () => {
  const body = { contents: [] };
  inject("p", "BE-CONCISE", FORMATS.GEMINI, body);
  assert.ok(body.systemInstruction.parts[0].text.includes("BE-CONCISE"));
});

t("gemini: merges into existing snake_case system_instruction", () => {
  const body = { system_instruction: { parts: [{ text: "ORIG" }] } };
  inject("p", "BE-CONCISE", FORMATS.GEMINI, body);
  assert.ok(body.system_instruction.parts[0].text.includes("ORIG"));
  assert.ok(body.system_instruction.parts[0].text.includes("BE-CONCISE"));
});

t("antigravity: targets body.request", () => {
  const body = { request: {} };
  inject("p", "BE-CONCISE", FORMATS.ANTIGRAVITY, body);
  assert.ok(body.request.systemInstruction.parts[0].text.includes("BE-CONCISE"));
});

t("responses instructions[]", () => {
  const body = { input: [{ role: "user", content: "hi" }] };
  inject("p", "BE-CONCISE", FORMATS.OPENAI_RESPONSES, body);
  assert.strictEqual(body.input[0].role, "system");
  assert.ok(body.input[0].content.includes("BE-CONCISE"));
});

t("stacks in order: prompt, then skills, then caveman", () => {
  const body = { messages: [] };
  inject("p", "OPERATOR-BASE", FORMATS.OPENAI, body);
  injectSystemText(body, FORMATS.OPENAI, "SKILL-CONTEXT");
  injectSystemText(body, FORMATS.OPENAI, "CAVEMAN-STYLE");
  const c = sys(body);
  assert.ok(c.indexOf("OPERATOR-BASE") < c.indexOf("SKILL-CONTEXT"));
  assert.ok(c.indexOf("SKILL-CONTEXT") < c.indexOf("CAVEMAN-STYLE"));
});

t("user turn is never mutated", () => {
  const body = { messages: [{ role: "user", content: "ORIGINAL QUESTION" }] };
  inject("p", "X", FORMATS.OPENAI, body);
  assert.strictEqual(body.messages.find(m => m.role === "user").content, "ORIGINAL QUESTION");
});

t("body with no recognizable slot reports no placement", () => {
  assert.strictEqual(injectSystemText({ foo: 1 }, FORMATS.OPENAI, "X"), false);
});


// ---- wildcard + env fallback -------------------------------------------------
// The operator's prompt has to reach every model, including ones added after
// the entry was written, so "*" applies to any model without its own entry.

t("wildcard applies to a model with no entry of its own", () => {
  const e = pickEntry([{ model: "*", label: "G", isActive: true, isLive: true, prompt: "P" }], "gr/nusa-9", null);
  assert.strictEqual(e.label, "G");
});

t("an exact entry still wins over the wildcard", () => {
  const entries = [
    { model: "cc/claude-opus-4-8", label: "SPECIFIC", isActive: true, isLive: true },
    { model: "*", label: "GLOBAL", isActive: true, isLive: true },
  ];
  assert.strictEqual(pickEntry(entries, "cc/claude-opus-4-8", null).label, "SPECIFIC");
});

t("a bare-name entry still wins over the wildcard", () => {
  const entries = [
    { model: "claude-opus-4-8", label: "BARE", isActive: true, isLive: true },
    { model: "*", label: "GLOBAL", isActive: true, isLive: true },
  ];
  assert.strictEqual(pickEntry(entries, "cc/claude-opus-4-8", null).label, "BARE");
});

t("an ambiguous bare name falls through to the wildcard, not to nothing", () => {
  const entries = [
    { model: "a/claude-x", label: "A", isActive: true, isLive: true },
    { model: "b/claude-x", label: "B", isActive: true, isLive: true },
    { model: "*", label: "GLOBAL", isActive: true, isLive: true },
  ];
  assert.strictEqual(pickEntry(entries, "c/claude-x", null).label, "GLOBAL");
});

t("an inactive wildcard is ignored", () => {
  const e = pickEntry([{ model: "*", label: "G", isActive: false, isLive: true }], "gr/nusa-9", null);
  assert.strictEqual(e, null);
});

t("a wildcard that is not live is ignored", () => {
  const e = pickEntry([{ model: "*", label: "G", isActive: true, isLive: false }], "gr/nusa-9", null);
  assert.strictEqual(e, null);
});

t("no wildcard and no match stays null", () => {
  assert.strictEqual(pickEntry([{ model: "cc/opus", isActive: true, isLive: true }], "gr/nusa-9", null), null);
});

t("an empty library stays null", () => {
  assert.strictEqual(pickEntry([], "cc/claude-opus-4-8", null), null);
});

t("the prompt follows the operator across three different models", () => {
  const entries = [{ model: "*", label: "GLOBAL", isActive: true, isLive: true, prompt: "P" }];
  for (const m of ["cc/claude-opus-4-8", "cc/claude-sonnet-4-6", "openai/gpt-5"]) {
    assert.strictEqual(pickEntry(entries, m, null).prompt, "P", m);
  }
});

t("the wildcard block lands in the system slot exactly once", async () => {
  process.env.GODMODE_JB = "ENV-RIDER";
  try {
    const { injectLiveSystemPrompt } = await import(path.join(RTK, "livePrompt.js"));
    const body = { messages: [{ role: "user", content: "hi" }] };
    await injectLiveSystemPrompt(body, FORMATS.OPENAI, "gr/nusa-9", null);
    // a second pass over the same body must not double up
    await injectLiveSystemPrompt(body, FORMATS.OPENAI, "gr/nusa-9", null);
    const sys = body.messages[0].content;
    const n = sys.split("ENV-RIDER").length - 1;
    assert.ok(n >= 1, "the env prompt reached the system slot");
    assert.strictEqual((body.messages[0].content.match(/--- SYSTEM PROMPT:/g) || []).length, 1);
  } finally {
    delete process.env.GODMODE_JB;
  }
});

t("no library entry and no env resolves to null", async () => {
  delete process.env.GODMODE_JB;
  const { resolvePromptForRequest } = await import(path.join(RTK, "livePrompt.js"));
  assert.strictEqual(await resolvePromptForRequest("gr/nusa-9", null), null);
});

t("the env prompt is used when the library has nothing for this model", async () => {
  process.env.GODMODE_JB = "ENV-RIDER";
  try {
    const { resolvePromptForRequest } = await import(path.join(RTK, "livePrompt.js"));
    const e = await resolvePromptForRequest("gr/nusa-9", null);
    assert.strictEqual(e.prompt, "ENV-RIDER");
    assert.strictEqual(e.model, "*");
  } finally {
    delete process.env.GODMODE_JB;
  }
});

await drain();
console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);
