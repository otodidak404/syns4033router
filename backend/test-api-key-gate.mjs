// requireApiKey guards every public /v1 handler. Eight of them enforce it, each
// written separately, and they had already drifted: chat knew a noAuth provider
// has no key to present, the other seven did not. Same model, same router,
// different answer per endpoint.
//
// The exemption itself has to stay narrow. If it were expressible by a header,
// anyone who found /v1 could send it and walk straight through.
import assert from "assert";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { clientApiKeyRequired } = await import(
  path.join(HERE, "src/lib/auth/apiKeyGate.js")
);
const { isInternalCall, markInternal, INTERNAL_CALL } = await import(
  path.join(HERE, "src/lib/auth/internalCall.js")
);

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const ON = { requireApiKey: true };
const OFF = { requireApiKey: false };

t("a paid provider still needs a key", () => {
  assert.strictEqual(clientApiKeyRequired({ model: "openai/gpt-4o", settings: ON }).required, true);
});

t("a provider that needs a key but has no connection still needs a key", () => {
  assert.strictEqual(clientApiKeyRequired({ model: "anthropic/claude", settings: ON }).required, true);
});

t("an unknown prefix needs a key", () => {
  // Not treating it as free is the safe answer: a model this router cannot
  // place could still route to a paid connection.
  assert.strictEqual(clientApiKeyRequired({ model: "zzz/mystery", settings: ON }).required, true);
});

t("a model with no prefix needs a key", () => {
  assert.strictEqual(clientApiKeyRequired({ model: "space-bunny-free", settings: ON }).required, true);
});

t("a no-auth provider is exempt", () => {
  const r = clientApiKeyRequired({ model: "oc/space-bunny-free", settings: ON });
  assert.strictEqual(r.required, false);
  assert.strictEqual(r.exempt, "no-auth provider");
});

t("an empty or missing model needs a key", () => {
  for (const m of ["", null, undefined, 42]) {
    assert.strictEqual(clientApiKeyRequired({ model: m, settings: ON }).required, true, String(m));
  }
});

t("requireApiKey off means no key for anyone", () => {
  assert.strictEqual(clientApiKeyRequired({ model: "openai/gpt-4o", settings: OFF }).required, false);
});

t("missing settings does not throw", () => {
  assert.strictEqual(clientApiKeyRequired({ model: "openai/gpt-4o", settings: undefined }).required, false);
});

t("a caller already behind the session guard is not gated again", () => {
  const r = clientApiKeyRequired({ model: "openai/gpt-4o", settings: ON, authAlreadyChecked: true });
  assert.strictEqual(r.required, false);
});

t("all eight handlers route through the shared gate", () => {
  const dir = path.join(HERE, "src/sse/handlers");
  const files = ["chat.js", "embeddings.js", "fetch.js", "search.js",
                 "imageGeneration.js", "videoGeneration.js", "tts.js", "stt.js"];
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(src.includes("clientApiKeyRequired"), `${f} does not use the shared gate`);
    assert.ok(
      !/if \(settings\.requireApiKey/.test(src),
      `${f} still gates on settings.requireApiKey directly`);
  }
});

t("the exemption cannot be bought with a header", () => {
  const req = new Request("http://x/v1/chat/completions", {
    headers: { "x-9r-auth-checked": "1", "x-9r-skip-live-prompt": "1" },
  });
  assert.strictEqual(isInternalCall(req), false, "a forged header must not read as internal");
});

t("a marked request does read as internal", () => {
  assert.strictEqual(isInternalCall(markInternal(new Request("http://x/v1/chat/completions"))), true);
});

t("an unmarked request is not internal", () => {
  assert.strictEqual(isInternalCall(new Request("http://x/v1/chat/completions")), false);
  assert.strictEqual(isInternalCall(undefined), false);
});

t("the marker is not enumerable, so it cannot leak into a serialised body", () => {
  const req = markInternal(new Request("http://x/v1/chat/completions"));
  assert.strictEqual(Object.keys(req).length, 0);
  assert.ok(Object.getOwnPropertySymbols(req).includes(INTERNAL_CALL));
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);