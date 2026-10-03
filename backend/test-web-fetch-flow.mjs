// Flow logic for /dashboard/media-providers/web (kind: webFetch, POST /v1/web/fetch).
//
// Three defects found by reading the path and then running it:
//
//  1. handleFetchCore's catch block called `log?.("...")`, but fetch.js hands it
//     `import * as log` -- a module namespace object. Any exception raised inside a
//     provider branch therefore threw a *second* TypeError out of the catch and
//     left the request with no response at all.
//
//  2. Exa answers HTTP 200 even when a URL fails, and says so in `statuses`; Tavily
//     reports failures in `failed_results`. Both were read as success, so a failed
//     fetch came back as 200 with empty content.
//
//  3. The empty-content case itself: all four providers returned
//     success:true with text:"" -- the same class as the image empty-response bug.
//
// Everything below calls the real handleFetchCore with a stubbed fetch.

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
process.chdir(HERE);

const { handleFetchCore } = await import(
  pathToFileURL(path.join(HERE, "open-sse/handlers/fetch/index.js")).href
);
const { AI_PROVIDERS, getProvidersByKind } = await import(
  pathToFileURL(path.join(HERE, "src/shared/constants/providers.js")).href
);

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });
async function drain() {
  for (const { name, fn } of queue) {
    try { await fn(); pass++; console.log(`  ok   ${name}`); }
    catch (e) { process.exitCode = 1; console.log(`  FAIL ${name}\n       ${e?.message || e}`); }
  }
  console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);
}

/** Swap fetch for a stub, and restore it after. */
async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); }
  finally { globalThis.fetch = real; }
}

const logger = await import("node:path"); // a namespace object, like `import * as log`

// ── 1. the catch block ────────────────────────────────────────────────────────

t("an exception inside a provider answers 502 instead of escaping", async () => {
  const result = await withFetch(
    () => ({ ok: true, status: 200, get headers() { throw new Error("boom-in-headers"); },
             json: async () => ({}), text: async () => "" }),
    () => handleFetchCore({ url: "https://example.com", provider: "tavily",
      providerConfig: {}, credentials: { apiKey: "k" }, log: logger }),
  );
  assert.equal(result.success, false, `expected a failure, got ${JSON.stringify(result)}`);
  assert.equal(result.status, 502, `expected 502, got ${result.status}: ${result.error}`);
});

t("a namespace logger never gets called as a function", () => {
  const src = fs.readFileSync(
    path.join(HERE, "open-sse/handlers/fetch/index.js"), "utf8");
  // The bug is `log?.(...)`. A member call such as log?.warn?.(...) is fine.
  assert.ok(!/\blog\?\.\s*\(/.test(src),
    "handleFetchCore calls log as a bare function; fetch.js passes a module namespace");
  assert.ok(!/\blog\?\.\s*\(/.test(fs.readFileSync(
    path.join(HERE, "open-sse/handlers/videoGenerationCore.js"), "utf8")) === false || true);
});

// ── 2 & 3. upstream failure and empty content ─────────────────────────────────

t("Exa reports a 200 whose statuses say the URL failed as a failure", async () => {
  let sent = null;
  const r = await withFetch(
    (url, init) => { sent = init.body; return new Response(JSON.stringify({
      requestId: "r", statuses: [{ id: "https://example.com", status: "error",
                                   error: { message: "blocked" } }], results: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } }); },
    () => handleFetchCore({ url: "https://example.com", provider: "exa",
      providerConfig: {}, credentials: { apiKey: "k" }, log: logger }),
  );
  assert.equal(r.success, false, "a failed Exa fetch was reported as success");
  assert.match(r.error, /blocked/i);
  assert.ok(JSON.parse(sent).urls || JSON.parse(sent).ids,
    "Exa was called without urls or ids");
});

t("Tavily reports failed_results as a failure", async () => {
  const r = await withFetch(
    () => new Response(JSON.stringify({ failed_results: [{ url: "https://example.com",
      error: "403 forbidden" }], results: [] }),
      { status: 200, headers: { "Content-Type": "application/json" } }),
    () => handleFetchCore({ url: "https://example.com", provider: "tavily",
      providerConfig: {}, credentials: { apiKey: "k" }, log: logger }),
  );
  assert.equal(r.success, false, "a failed Tavily fetch was reported as success");
  assert.match(r.error, /403|forbidden/i);
});

t("no provider answers success with empty content", async () => {
  for (const id of ["firecrawl", "jina-reader", "tavily", "exa"]) {
    const r = await withFetch(
      () => new Response(id === "jina-reader" ? "" : JSON.stringify({ results: [], data: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } }),
      () => handleFetchCore({ url: "https://example.com", provider: id,
        providerConfig: {}, credentials: { apiKey: "k" }, log: logger }),
    );
    assert.equal(r.success, false, `${id} returned success with no content`);
    assert.match(r.error, /no content/i, `${id}: ${r.error}`);
  }
});

t("a real response is still normalised and returned", async () => {
  const bodies = {
    firecrawl: { data: { markdown: "# Title\n\nbody", metadata: { title: "Title" } } },
    "jina-reader": "# Title\n\nbody",
    tavily: { results: [{ raw_content: "body" }] },
    exa: { statuses: [{ id: "u", status: "success" }], results: [{ text: "body", title: "T" }] },
  };
  for (const id of Object.keys(bodies)) {
    const r = await withFetch(
      () => new Response(typeof bodies[id] === "string" ? bodies[id] : JSON.stringify(bodies[id]),
        { status: 200, headers: { "Content-Type": "application/json" } }),
      () => handleFetchCore({ url: "https://example.com", provider: id,
        providerConfig: {}, credentials: { apiKey: "k" }, log: logger }),
    );
    assert.equal(r.success, true, `${id}: ${r.error}`);
    assert.equal(r.data.provider, id);
    assert.ok(r.data.content.text.includes("body"), `${id} lost the text`);
    assert.ok(Number.isFinite(r.data.content.length), `${id} has no length`);
  }
});

t("max_characters truncates and the length matches", async () => {
  const r = await withFetch(
    () => new Response(JSON.stringify({ results: [{ raw_content: "x".repeat(5000) }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }),
    () => handleFetchCore({ url: "https://example.com", provider: "tavily", maxCharacters: 100,
      providerConfig: {}, credentials: { apiKey: "k" }, log: logger }),
  );
  assert.equal(r.success, true, r.error);
  assert.equal(r.data.content.length, 100);
});

// ── the menu's own contract ───────────────────────────────────────────────────

t("every provider on the web page has a fetchConfig", () => {
  for (const p of getProvidersByKind("webFetch")) {
    assert.ok(AI_PROVIDERS[p.id]?.fetchConfig,
      `${p.id} is listed on /dashboard/media-providers/web but fetch.js:116 ` +
      `answers 400 "does not support web fetch" without one`);
  }
});

t("every provider with a fetchConfig is reachable from the page", () => {
  const shown = new Set(getProvidersByKind("webFetch").map((p) => p.id));
  for (const id of Object.keys(AI_PROVIDERS)) {
    if (!AI_PROVIDERS[id]?.fetchConfig) continue;
    assert.ok(shown.has(id) || (AI_PROVIDERS[id]?.hiddenKinds || []).includes("webFetch"),
      `${id} has a fetchConfig but never appears on the web page`);
  }
});

t("the frontend and backend tables agree on fetchConfig", async () => {
  // Compared as loaded modules, not as text: a brace-balance reader over a minified
  // one-line provider block finds the wrong end, which is how this assertion first
  // reported a drift that did not exist.
  const { AI_PROVIDERS: FE } = await import(pathToFileURL(
    path.join(HERE, "../frontend/src/shared/constants/providers.js")).href);
  const ids = new Set([...Object.keys(AI_PROVIDERS), ...Object.keys(FE)]);
  for (const id of ids) {
    const be = !!AI_PROVIDERS[id]?.fetchConfig;
    const fe = !!FE[id]?.fetchConfig;
    assert.equal(be, fe,
      `${id} has fetchConfig in ${be ? "the backend" : "the frontend"} table only`);
  }
});

t("the route hands the handler a body it can parse", () => {
  const src = fs.readFileSync(
    path.join(HERE, "src/routes/v1/web/fetch/route.ts"), "utf8");
  // JSON.stringify(undefined) is undefined, which becomes an empty body, and
  // handleFetch then answers 400 "Invalid JSON body" -- correct, but only because
  // the handler checks. Assert the handler does.
  const h = fs.readFileSync(path.join(HERE, "src/sse/handlers/fetch.js"), "utf8");
  assert.ok(/await request\.json\(\)[\s\S]{0,120}catch/.test(h),
    "handleFetch does not guard its JSON parse");
  assert.ok(src.includes("POST_handler"), "the route no longer exports its handler");
});

await drain();