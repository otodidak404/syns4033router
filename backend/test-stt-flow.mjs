// Flow logic for /dashboard/media-providers/stt, checked by running the code.
//
// Four defects, all found by reading the STT path rather than the page:
//
//  1. Four models advertised `language` in their params while the core dropped
//     it -- the dashboard showed a Language field, the curl snippet sent
//     `-F "language=..."`, and the provider never saw it. AssemblyAI ignored an
//     explicit language while `language_detection: true` was set, so it now turns
//     detection off when one is given; HuggingFace cannot be made to honour it
//     on this endpoint, so the param is gone rather than promised.
//  2. A non-multipart body answered 500 "Response body object should not be
//     disturbed or locked": express.json() runs globally and drains the request
//     stream before the route wraps it in a Web Request.
//  3. The Gemini path put the credential in the query string.
//  4. Nothing asserted any of this, so all three survived.
//
// The contract check below is executed, not tabulated. `handleSttCore` is called
// against a stubbed fetch and the outgoing request is inspected, which is the only
// way to know a parameter reached the wire.

import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const at = (...p) => path.join(HERE, ...p);

// Serialised on purpose. Several tests below swap globalThis.fetch, and running
// them concurrently let one restore the real fetch while another was mid-call --
// which showed up as "expected one call, got 5" and an empty call list rather than
// anything resembling a failure in the code under test.
let pass = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });

async function drain() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      pass++;
      console.log(`  ok   ${name}`);
    } catch (e) {
      process.exitCode = 1;
      console.log(`  FAIL ${name}\n       ${e?.message || e}`);
    }
  }
  console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);
}

const sttCore = await import(at("open-sse", "handlers", "sttCore.js"));
const providersMod = await import(at("src", "shared", "constants", "providers.js"));
const modelsMod = await import(at("open-sse", "config", "providerModels.js"));

// ── helpers ──────────────────────────────────────────────────────────────────

/** One second of 440Hz as a real WAV, so file.arrayBuffer() has bytes to read. */
function wavBytes() {
  const n = 8000;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 8000)), 44 + i * 2);
  return new Uint8Array(buf);
}

function formWith({ model = "x", file = wavBytes(), filename = "a.wav", ...rest } = {}) {
  const fd = new FormData();
  if (model) fd.append("model", model);
  if (file) fd.append("file", new File([file], filename, { type: "audio/wav" }));
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) fd.append(k, String(v));
  return fd;
}

/** Replace global fetch, run fn, restore. Returns the calls it made. */
async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  try {
    return { result: await fn(calls), calls };
  } finally {
    globalThis.fetch = real;
  }
}

const okJson = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { "Content-Type": "application/json" },
});

// ── 1. the catalogue must not advertise what the core drops ──────────────────

// What each dispatch format in sttCore.js actually reads off the form. Kept
// next to the assertions below so a new format has to be classified, not
// silently assumed to honour everything.
const HONOURED = {
  deepgram: ["language"],
  assemblyai: ["language"],
  "nvidia-asr": [],
  "huggingface-asr": [],
  "gemini-stt": ["language", "prompt"],
  default: ["language", "prompt", "response_format", "temperature"],
};

t("no STT model advertises a parameter its provider format ignores", () => {
  const offenders = [];
  for (const [alias, models] of Object.entries(modelsMod.PROVIDER_MODELS)) {
    const format = providersMod.AI_PROVIDERS[alias]?.sttConfig?.format ?? "default";
    for (const m of models) {
      if (m.type !== "stt") continue;
      const advertised = Array.isArray(m.params) ? m.params : [];
      const honoured = HONOURED[format] ?? HONOURED.default;
      for (const p of advertised) {
        if (!honoured.includes(p)) offenders.push(`${alias}/${m.id} advertises ${p} (${format} drops it)`);
      }
    }
  }
  assert.equal(offenders.length, 0,
    `the dashboard would show a control that does nothing:\n       ${offenders.join("\n       ")}`);
});

t("every STT provider is classified, so a new format cannot slip through", () => {
  const formats = new Set();
  for (const p of Object.values(providersMod.AI_PROVIDERS)) {
    if (p.sttConfig?.format) formats.add(p.sttConfig.format);
  }
  const unknown = [...formats].filter((f) => !(f in HONOURED) && f !== "openai");
  assert.equal(unknown.length, 0,
    `sttCore dispatches these but HONOURED does not classify them: ${unknown.join(", ")}`);
  assert.ok(formats.size > 0, "no provider declares sttConfig; the catalog check proves nothing");
});

t("providers that claim stt have a config, and vice versa", () => {
  const claimsNoConfig = [];
  const configNotClaimed = [];
  for (const [id, p] of Object.entries(providersMod.AI_PROVIDERS)) {
    if (p.serviceKinds?.includes("stt") && !p.sttConfig) claimsNoConfig.push(id);
    if (p.sttConfig && !p.serviceKinds?.includes("stt")) configNotClaimed.push(id);
  }
  assert.equal(claimsNoConfig.length, 0, `claim stt with no sttConfig: ${claimsNoConfig}`);
  assert.equal(configNotClaimed.length, 0, `sttConfig on a provider not listed for stt: ${configNotClaimed}`);
});

// ── 2. AssemblyAI must actually send the language ────────────────────────────

t("AssemblyAI sends the language and turns detection off", async () => {
  const { calls } = await withFetch(
    // upload -> submit -> poll(completed)
    (url, init, n) => {
      if (url.includes("/upload")) return okJson({ upload_url: "https://x/audio.wav" });
      if (init?.method === "POST" && url.includes("/v2/transcript")) {
        return okJson({ id: "job-1" });
      }
      return okJson({ status: "completed", text: "halo dunia" });
    },
    () => sttCore.handleSttCore({
      provider: "assemblyai",
      model: "universal-2",
      formData: formWith({ language: "id" }),
      credentials: { apiKey: "sk-test" },
    }),
  );

  const submit = calls.find((c) => c.init?.method === "POST" && c.url.includes("/v2/transcript"));
  assert.ok(submit, `no submit call; saw ${calls.map((c) => c.url).join(", ")}`);
  const body = JSON.parse(submit.init.body);
  assert.equal(body.language, "id", `language not forwarded: ${JSON.stringify(body)}`);
  assert.equal(body.language_detection, false,
    `detection stays on, so AssemblyAI ignores the language: ${JSON.stringify(body)}`);
});

t("AssemblyAI still auto-detects when no language is given", async () => {
  const { calls } = await withFetch(
    (url, init) => {
      if (url.includes("/upload")) return okJson({ upload_url: "https://x/a.wav" });
      if (init?.method === "POST" && url.includes("/v2/transcript")) return okJson({ id: "j" });
      return okJson({ status: "completed", text: "x" });
    },
    () => sttCore.handleSttCore({
      provider: "assemblyai", model: "universal-2",
      formData: formWith(), credentials: { apiKey: "sk-test" },
    }),
  );
  const submit = calls.find((c) => c.init?.method === "POST" && c.url.includes("/v2/transcript"));
  const body = JSON.parse(submit.init.body);
  assert.equal(body.language_detection, true, `auto-detect lost: ${JSON.stringify(body)}`);
  assert.equal(body.language, undefined, "an empty language should not be sent");
});

// ── 3. Gemini must not put the key in the URL ───────────────────────────────

t("Gemini sends the credential as a header, never in the query string", async () => {
  const { calls } = await withFetch(
    () => okJson({ candidates: [{ content: { parts: [{ text: "halo" }] } }] }),
    () => sttCore.handleSttCore({
      provider: "gemini", model: "gemini-2.5-flash",
      formData: formWith({ language: "id", prompt: "transkrip" }),
      credentials: { apiKey: "sk-secret-value" },
    }),
  );
  assert.equal(calls.length, 1, `expected one call, got ${calls.length}`);
  const { url, init } = calls[0];
  assert.ok(!url.includes("key="), `credential is in the URL: ${url.replace(/(key=)[^&]*/, "$1…")}`);
  assert.ok(!url.includes("sk-secret-value"), "the key value appears in the URL at all");
  assert.equal(init.headers["x-goog-api-key"], "sk-secret-value", "the key is not in the header");
  // The language and the prompt have to reach the prompt text.
  const body = JSON.parse(init.body);
  const text = body.contents[0].parts[0].text;
  assert.ok(/Language: id/.test(text), `language missing from the prompt: ${text}`);
  assert.ok(text.startsWith("transkrip"), `user prompt ignored: ${text}`);
});

t("the Gemini base URL no longer carries ?key=", () => {
  const src = fs.readFileSync(at("open-sse", "handlers", "sttCore.js"), "utf8");
  assert.ok(!/generateContent\?key=/.test(src),
    "the query-string credential is back in sttCore.js");
});

// ── 4. the route answers 400 for a body that is not multipart ───────────────

t("the transcriptions route rejects a non-multipart body before wrapping it", () => {
  const src = fs.readFileSync(
    at("src", "routes", "v1", "audio", "transcriptions", "route.ts"), "utf8");
  const guard = src.indexOf('startsWith("multipart/form-data")');
  assert.ok(guard > 0, "the route has no content-type guard");
  assert.ok(src.indexOf("Readable.toWeb(req)") > guard,
    "the stream is still wrapped before the guard");
  assert.ok(/errorResponse\(\s*400/.test(src), "the guard does not answer 400");
});

t("the guard is reached with an empty body too", () => {
  // express.json() only drains the stream for its own content types; the guard
  // keys off content-type, so a request with no content-type is covered as well.
  const src = fs.readFileSync(
    at("src", "routes", "v1", "audio", "transcriptions", "route.ts"), "utf8");
  const m = src.match(/const contentType = String\(req\.headers\["content-type"\] \|\| ""\)/);
  assert.ok(m, "content-type is read without a fallback, so an absent header crashes");
});

// ── 5. the dashboard card must not be able to lie ───────────────────────────

t("the STT card sends only params the selected model advertises", () => {
  const src = fs.readFileSync(
    at("..", "frontend", "src", "pages", "media-providers", "[kind]", "[id]", "page.jsx"), "utf8");
  const i = src.indexOf("function SttExampleCard");
  assert.ok(i > 0, "SttExampleCard not found");
  const card = src.slice(i, src.indexOf("\n// ", i + 10) > 0 ? src.indexOf("\n// ", i + 10) : i + 22000);

  for (const p of ["language", "prompt", "temperature"]) {
    assert.ok(new RegExp(`allowedParams\\.includes\\("${p}"\\)`).test(card),
      `${p} is not gated on allowedParams`);
  }
  assert.ok(/allowedParams\.includes\("response_format"\)/.test(card),
    "response_format is not gated on allowedParams");
  // A failure has to be visible, not swallowed.
  assert.ok(/if \(!res\.ok\)/.test(card), "the card never checks res.ok");
  assert.ok(/setError\(/.test(card), "the card never sets an error");
  // The Run button must be disabled when there is nothing to send.
  assert.ok(/disabled=\{running \|\| !audioFile \|\| !modelFull\}/.test(card),
    "Run is clickable with no file selected");
});

t("the STT card posts to the route that exists", () => {
  const src = fs.readFileSync(
    at("..", "frontend", "src", "pages", "media-providers", "[kind]", "[id]", "page.jsx"), "utf8");
  const i = src.indexOf("function SttExampleCard");
  const card = src.slice(i, i + 22000);
  const m = card.match(/fetch\("([^"]*transcriptions[^"]*)"/);
  assert.ok(m, "the card does not post to a transcriptions route");
  assert.ok(m[1] === "/api/v1/audio/transcriptions" || m[1] === "/v1/audio/transcriptions",
    `unexpected transcriptions URL: ${m[1]}`);
  const kinds = fs.readFileSync(
    at("..", "frontend", "src", "shared", "constants", "providers.js"), "utf8");
  assert.ok(kinds.includes('id: "stt"') && kinds.includes("/v1/audio/transcriptions"),
    "the STT media kind is no longer declared with its endpoint");
  assert.ok(!/id: "stt"[\s\S]{0,200}served: false/.test(kinds),
    "STT is marked unserved, so the dashboard would hide it");
});

await drain();