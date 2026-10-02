// The playground showed "(empty reply)" on every run.
//
// The handler returns a JSON body with an SSE terminator welded onto its tail:
//
//   {"id":"...","choices":[...]}data: [DONE]
//
// with no newline between the closing brace and the frame. The old extractor
// tested with includes("data:"), so every such body went down the SSE path —
// where the one JSON line does not begin with "data:", and the only line that
// does is [DONE]. Both branches produced nothing, so every run read as empty
// even though the model had answered.
import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const routePath = path.join(HERE, "src/routes/system-prompts/try/route.ts");

// The extractor is not exported; pull it out of the module source so the test
// exercises the shipped implementation rather than a copy of it.
const src = fs.readFileSync(routePath, "utf8");
const body = src.slice(src.indexOf("function textFromJson"), src.indexOf("async function runLeg"));
assert.ok(body.includes("function extractText"), "could not locate extractText in the route");
const { extractText } = await import(
  `data:text/javascript;base64,${Buffer.from(body + "\nexport { extractText };").toString("base64")}`
);

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const completion = (content) => ({
  id: "x", object: "chat.completion", created: 1, model: "m",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
});

// ── the shape that broke it ──────────────────────────────────────────────────
t("a JSON body with a welded SSE terminator is read", () => {
  const raw = JSON.stringify(completion("MARKER-ALPHA")) + "data: [DONE]\n\n";
  assert.strictEqual(extractText(raw), "MARKER-ALPHA");
});

t("the same with CRLF line endings is read", () => {
  const raw = JSON.stringify(completion("HELLO")) + "data: [DONE]\r\n\r\n";
  assert.strictEqual(extractText(raw), "HELLO");
});

t("a terminator alone after the JSON is read", () => {
  const raw = JSON.stringify(completion("OK")) + "data: [DONE]";
  assert.strictEqual(extractText(raw), "OK");
});

// model output that itself contains the string "data:" must not be truncated
t("content containing 'data:' survives", () => {
  const raw = JSON.stringify(completion("here is data: 1,2,3")) + "data: [DONE]\n\n";
  assert.strictEqual(extractText(raw), "here is data: 1,2,3");
});

// ── the shapes that worked before must still work ────────────────────────────
t("plain JSON is read", () => {
  assert.strictEqual(extractText(JSON.stringify(completion("PLAIN"))), "PLAIN");
});

t("a Claude-style body is read", () => {
  assert.strictEqual(
    extractText(JSON.stringify({ content: [{ type: "text", text: "CLAUDE" }] })), "CLAUDE");
});

t("a Gemini-style body is read", () => {
  assert.strictEqual(
    extractText(JSON.stringify({ candidates: [{ content: { parts: [{ text: "GEMINI" }] } }] })), "GEMINI");
});

t("a real SSE stream is read", () => {
  const raw = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}',
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    "data: [DONE]", "",
  ].join("\n");
  assert.strictEqual(extractText(raw), "Hello");
});

t("an SSE stream whose content says 'data:' is read", () => {
  const raw = 'data: {"choices":[{"delta":{"content":"data: x"}}]}\ndata: [DONE]\n';
  assert.strictEqual(extractText(raw), "data: x");
});

// ── degenerate input must not throw ──────────────────────────────────────────
t("an empty body yields empty text", () => {
  assert.strictEqual(extractText(""), "");
  assert.strictEqual(extractText(null), "");
  assert.strictEqual(extractText(undefined), "");
});

t("a terminator with no JSON yields empty text", () => {
  assert.strictEqual(extractText("data: [DONE]\n\n"), "");
});

t("truncated JSON yields empty text rather than throwing", () => {
  assert.strictEqual(extractText('{"choices":[{"message":{"content":"trunc'), "");
});

t("an already-parsed object is read", () => {
  assert.strictEqual(extractText(completion("OBJECT")), "OBJECT");
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);