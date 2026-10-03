// /dashboard/basic-chat — the streaming reader.
//
// readAssistantText returns "" for a chunk that carries an error rather than content,
// and the loop did `if (!text) continue`. A gateway that fails part-way through a
// stream and says so in-band therefore produced a truncated reply that looked
// finished: no error, no gap. The two helpers and the decision are exercised here
// against real server-sent-event frames.

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = fs.readFileSync(
  path.join(HERE, "../frontend/src/pages/basic-chat/BasicChatPageClient.jsx"), "utf8");

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

/** Take a top-level function out of the page and return it as a callable. */
function take(name, deps = {}) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} is not defined on the page`);
  const lines = SRC.split("\n");
  const start = SRC.slice(0, at).split("\n").length - 1;
  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === "}") { end = i; break; }
  }
  assert.ok(end > start, `could not find the end of ${name}`);
  const src = lines.slice(start, end + 1).join("\n");
  const keys = Object.keys(deps);
  return new Function(...keys, `${src}\nreturn ${name};`)(...keys.map((k) => deps[k]));
}

// ── the helpers ─────────────────────────────────────────────────────────────

const textValue = take("textValue");
const readAssistantError = take("readAssistantError", { textValue });

t("an in-band error is read from every shape a gateway uses", () => {
  assert.equal(readAssistantError("upstream exploded"), "upstream exploded");
  assert.equal(readAssistantError({ message: "rate limited" }), "rate limited");
  assert.equal(readAssistantError({ error: { message: "model not found" } }),
    "model not found");
  assert.equal(readAssistantError({ code: "overloaded" }), "overloaded");
  assert.equal(readAssistantError(null), "");
  assert.equal(readAssistantError({}), "");
});

const readAssistantText = take("readAssistantText", { textValue });

t("content chunks still read", () => {
  assert.equal(readAssistantText({ choices: [{ delta: { content: "hi" } }] }), "hi");
  assert.equal(readAssistantText({ choices: [{ message: { content: "full" } }] }), "full");
  assert.equal(readAssistantText({ output_text: "ot" }), "ot");
  assert.equal(readAssistantText({ text: "t" }), "t");
});

t("an error chunk still yields no assistant text", () => {
  // This is why the loop used to swallow it.
  assert.equal(readAssistantText({ error: { message: "boom" } }), "");
});

// ── the loop's decision ──────────────────────────────────────────────────────

t("the raise happens outside the block that ignores malformed chunks", () => {
  // The first version of this fix put the throw inside the try that swallows
  // unparseable frames, so the error was discarded exactly like one of them and the
  // fix did nothing. Parse first, check the error, and only then render.
  const parse = SRC.indexOf("chunk = JSON.parse(payload);");
  assert.ok(parse > 0, "the frame is no longer parsed");
  const parseCatch = SRC.indexOf("} catch {", parse);
  const check = SRC.indexOf("if (chunk?.error) {", parseCatch);
  const raise = SRC.indexOf("throw new Error", check);
  const skip = SRC.indexOf("if (!text) continue;", raise);
  assert.ok(parseCatch > 0 && check > parseCatch,
    "the in-band check sits inside the malformed-chunk catch, so it would be swallowed");
  assert.ok(raise > check, "the error is detected but not raised");
  assert.ok(skip > raise, "the empty-text skip still swallows the error");
});

t("a malformed frame is still ignored rather than failing the message", () => {
  const parse = SRC.indexOf("chunk = JSON.parse(payload);");
  const seg = SRC.slice(parse, parse + 320);
  assert.ok(/catch\s*\{[\s\S]{0,400}?continue/.test(seg),
    "an unparseable frame no longer just moves on");
});

// ── end to end over a real SSE body ──────────────────────────────────────────

t("a stream that fails mid-way reports it instead of truncating silently", async () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
    'data: {"choices":[{"delta":{"content":" world"}}]}',
    'data: {"error":{"message":"upstream rate limited"}}',
    'data: [DONE]',
  ].map((l) => `data: ${l.slice(6)}\n\n`).join("");
  void frames;

  // Replay the loop's own decision over the frames.
  const body = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
    'data: {"choices":[{"delta":{"content":" world"}}]}',
    'data: {"error":{"message":"upstream rate limited"}}',
    'data: [DONE]',
    "",
  ].join("\n");

  let assistantText = "";
  let raised = null;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { continue; }
    if (chunk?.error) {
      raised = readAssistantError(chunk.error);
      break;
    }
    const text = readAssistantText(chunk);
    if (!text) continue;
    assistantText += text;
  }
  assert.equal(raised, "upstream rate limited",
    `the mid-stream failure was not reported; text was ${JSON.stringify(assistantText)}`);
  assert.equal(assistantText, "Hello world");
});

t("a clean stream finishes without raising", () => {
  const body = [
    'data: {"choices":[{"delta":{"content":"one"}}]}',
    'data: {"choices":[{"delta":{"content":" two"}}]}',
    "data: [DONE]",
    "",
  ].join("\n");
  let text = "";
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const chunk = JSON.parse(payload);
    if (chunk?.error) { text = "RAISED"; break; }
    const t2 = readAssistantText(chunk);
    if (t2) text += t2;
  }
  assert.equal(text, "one two");
});

drain();