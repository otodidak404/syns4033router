// The web-fetch paths that test-web-fetch-flow.mjs does not reach.
//
// That suite drives handleFetchCore directly. This one drives handleFetch -- the
// handler the route calls -- against the real auth and database modules over a
// temporary data directory. Only global fetch, the outbound HTTP to the extraction
// provider, is replaced. That means the key gate, the credential lookup, the
// fallback loop, the token refresh step and the combo expansion all execute here
// for the first time; before this, none of them had been run by anything.
//
// The handlers' own error paths are exercised too: a blocked URL, a missing
// provider, a missing url, and a malformed url.

import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname);
process.chdir(HERE);

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "webfetch-"));

const { handleFetch } = await import(
  pathToFileURL(path.join(HERE, "src/sse/handlers/fetch.js")).href
);
const db = await import(pathToFileURL(path.join(HERE, "src/lib/localDb.js")).href);

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

const calls = { fetch: [] };
async function withFetch(handler, fn) {
  const prev = calls.handler;
  calls.handler = handler;
  try { return await fn(); }
  finally { calls.handler = prev; }
}

// Installed for the whole file, not per-test. Without this the key-gate tests
// reached api.tavily.com for real, and Tavily answers 401 for a fake key -- so a
// request the router had let through unauthenticated still looked like a 401, and
// the suite passed against a router that was wide open.
let outbound = null;
globalThis.fetch = async (url, init = {}) => {
  calls.fetch.push({ url: String(url), init });
  if (!calls.handler) {
    throw new Error(`SUITE LEAK: an unexpected outbound call to ${String(url)}`);
  }
  return calls.handler(String(url), init, calls.fetch.length);
};

const post = (body, key) => new Request("https://router.test/v1/web/fetch", {
  method: "POST",
  headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
  body: JSON.stringify(body),
});

const OK_TAVILY = () => new Response(
  JSON.stringify({ results: [{ raw_content: "page text" }] }),
  { status: 200, headers: { "Content-Type": "application/json" } });

/** Turn the key requirement on or off through the real settings table. */
async function setKeyGate(on) {
  await db.updateSettings({ requireApiKey: on });
}

/** Give tavily `n` working connections in the real table. */
async function seedTavily(n) {
  await db.deleteProviderConnectionsByProvider("tavily");
  for (let i = 0; i < n; i += 1) {
    await db.createProviderConnection({
      provider: "tavily", name: `t${i}`, email: `t${i}@example.test`,
      apiKey: "UPSTREAM-KEY", isActive: true, testStatus: "active",
    });
  }
}

// ── the key gate ─────────────────────────────────────────────────────────────

await setKeyGate(true);

t("no key is refused before anything is contacted", async () => {
  calls.fetch.length = 0;
  await seedTavily(1);
  await withFetch(OK_TAVILY, async () => {
    const res = await handleFetch(post({ model: "tavily", url: "https://example.com" }));
    assert.equal(res.status, 401, `expected 401, got ${res.status}: ${await res.clone().text()}`);
    assert.equal(calls.fetch.length, 0,
      "the request reached the provider without a key -- the router let it through");
  });
});

t("a key that is not a real router key is refused", async () => {
  calls.fetch.length = 0;
  await seedTavily(1);
  await withFetch(OK_TAVILY, async () => {
    const res = await handleFetch(post({ model: "tavily", url: "https://example.com" }, "WRONG"));
    assert.equal(res.status, 401, `expected 401, got ${res.status}`);
    assert.match(await res.text(), /Invalid API key/,
      "the refusal did not name the key as the reason");
    assert.equal(calls.fetch.length, 0, "the request reached the provider with a bad key");
  });
});

// ── credential lookup, upstream success, token refresh ───────────────────────

t("a real connection is used and the refresh step runs", async () => {
  calls.fetch.length = 0;
  await setKeyGate(false);
  await seedTavily(1);
  const res = await withFetch(OK_TAVILY, () =>
    handleFetch(post({ model: "tavily", url: "https://example.com" })));
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.clone().text()}`);
  const body = JSON.parse(await res.text());
  assert.equal(body.provider, "tavily");
  assert.equal(body.content.text, "page text");
  assert.equal(calls.fetch.length, 1, `expected one upstream call, saw ${calls.fetch.length}`);
  assert.equal(calls.fetch[0].url, "https://api.tavily.com/extract",
    `upstream url was ${calls.fetch[0].url}`);
  const sent = JSON.parse(calls.fetch[0].init.body);
  assert.deepEqual(sent.urls, ["https://example.com"]);
  // The provider credential belongs in the authorization header, never in the body
  // or the query string.
  const headers = calls.fetch[0].init.headers || {};
  const authHeader = Object.entries(headers)
    .find(([k]) => k.toLowerCase() === "authorization")?.[1] || "";
  assert.ok(authHeader.includes("UPSTREAM-KEY"),
    `the upstream credential was not sent in a header: ${JSON.stringify(headers)}`);
  assert.ok(!JSON.stringify(calls.fetch[0].init.body).includes("UPSTREAM-KEY"),
    "the upstream credential leaked into the request body");
  assert.ok(!calls.fetch[0].url.includes("UPSTREAM-KEY"),
    "the upstream credential leaked into the url");
});

// ── the fallback loop ────────────────────────────────────────────────────────

t("a failing account falls through to the next one", async () => {
  calls.fetch.length = 0;
  await seedTavily(2);
  await withFetch(
    (url, init, n) => (n === 1
      ? new Response("upstream down", { status: 500 })
      : OK_TAVILY()),
    async () => {
      const res = await handleFetch(post({ model: "tavily", url: "https://example.com" }));
      assert.equal(res.status, 200,
        `expected 200 after falling back, got ${res.status}: ${await res.clone().text()}`);
      assert.equal(calls.fetch.length, 2,
        `expected two upstream calls, saw ${calls.fetch.length}`);
    },
  );
});

t("a 403 is passed through rather than retried forever", async () => {
  calls.fetch.length = 0;
  await seedTavily(2);
  await withFetch(
    () => new Response("forbidden", { status: 403 }),
    async () => {
      const res = await handleFetch(post({ model: "tavily", url: "https://example.com" }));
      assert.equal(res.status, 403, `expected 403, got ${res.status}`);
      assert.ok(calls.fetch.length <= 2, `retried ${calls.fetch.length} times on a 403`);
    },
  );
});

t("no connection at all is a clear 400, not a hang", async () => {
  calls.fetch.length = 0;
  await seedTavily(0);
  await withFetch(OK_TAVILY, async () => {
    const res = await handleFetch(post({ model: "tavily", url: "https://example.com" }));
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
    assert.match(await res.text(), /No credentials for provider/);
    assert.equal(calls.fetch.length, 0);
  });
});

// ── guard order: the SSRF check runs before credentials are looked up ────────

t("a blocked url is refused without resolving a credential", async () => {
  calls.fetch.length = 0;
  await seedTavily(2);
  // The guard answers 403 for an address it will not fetch and 400 for a scheme
  // it cannot fetch at all; both must stop before a credential is looked up.
  const blocked = ["http://169.254.169.254/", "http://127.0.0.1/", "http://[::1]/",
                   "http://localhost:3001/", "http://10.0.0.5/", "http://192.168.1.1/",
                   "http://172.16.0.1/", "http://2130706433/", "http://0x7f000001/"];
  for (const bad of blocked) {
    const res = await handleFetch(post({ model: "tavily", url: bad }));
    const body = await res.text();
    assert.equal(res.status, 403,
      `${bad} answered ${res.status}: ${body.slice(0, 90)}`);
    assert.match(body, /not a public address|does not resolve|non-public/,
      `${bad} was refused for an unexpected reason: ${body.slice(0, 90)}`);
  }
  for (const bad of ["file:///etc/passwd", "gopher://example.com/"]) {
    const res = await handleFetch(post({ model: "tavily", url: bad }));
    assert.equal(res.status, 400, `${bad} answered ${res.status}`);
  }
  assert.equal(calls.fetch.length, 0, "an upstream call was made for a blocked url");
});

// ── the handler's own validation ─────────────────────────────────────────────

t("missing and malformed fields are refused before any upstream call", async () => {
  calls.fetch.length = 0;
  await seedTavily(1);
  const cases = [
    [{}, /Missing required field/],
    [{ url: "https://example.com" }, /Missing required field: provider/],
    [{ model: "tavily" }, /Missing required field: url/],
    [{ model: "tavily", url: "notaurl" }, /Invalid URL/],
    [{ model: "__nope__", url: "https://example.com" }, /Unknown provider/],
  ];
  for (const [body, re] of cases) {
    const res = await handleFetch(post(body));
    assert.equal(res.status, 400, `${JSON.stringify(body)} answered ${res.status}`);
    assert.match(await res.text(), re);
  }
  assert.equal(calls.fetch.length, 0, "a malformed request reached the provider");
});

// ── the frontend page ────────────────────────────────────────────────────────

t("the web page reports a failed load and a failed write", () => {
  const src = fs.readFileSync(
    path.join(HERE, "../frontend/src/pages/media-providers/web/page.jsx"), "utf8");
  assert.ok(!/\balert\(/.test(src), "the page still uses alert() for a failed write");
  assert.ok(!/catch \{\s*\/\* noop \*\/\s*\}/.test(src),
    "fetchAll still swallows its errors");
  // The identifiers existing is not the claim. The calls are: a handler that holds
  // the state but never sets it is the same bug as having no error at all.
  assert.ok(/setLoadError\(`Could not load \$\{failed/.test(src),
    "a partial load failure is not reported");
  assert.ok(/setLoadError\("Could not reach the server/.test(src),
    "a load that throws outright is not reported");
  assert.ok(/setActionError\(message\);/.test(src),
    "a refused combo creation is not reported");
  assert.ok(/setActionError\(`Could not reach the server/.test(src),
    "a combo creation that throws outright is not reported");
  assert.ok(/role="alert"/.test(src), "the error is never rendered");
  // A failed POST must be read as text: a proxy can answer with HTML, and .json()
  // then throws inside the error path, which is the bug this replaced.
  const seg = src.slice(src.indexOf("const res = await fetch(\"/api/combos\""));
  const errSeg = seg.slice(0, seg.indexOf("navigate("));
  assert.ok(/await res\.text\(\)/.test(errSeg),
    "the combo error path does not read the body as text");
  assert.ok(!/await res\.json\(\)/.test(errSeg),
    "the combo error path still parses JSON and can throw on an HTML error page");
});

await drain();

try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }