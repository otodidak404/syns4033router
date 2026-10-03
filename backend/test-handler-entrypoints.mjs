// Import the real handlers and call them, so a ReferenceError in a request path
// fails the suite instead of waiting to be found in production.
//
// This started with /v1/audio/speech answering 500 {"error": "apiKey is not
// defined"} for every model. Commit fd8fd30 replaced `if (settings.requireApiKey)
// { const apiKey = extractApiKey(request);` with `if (clientApiKeyRequired(...))`
// and took the declaration with it, leaving `if (!apiKey)` and
// `isValidApiKey(apiKey)` behind. Nothing exercised the path: the page's Test
// button needs provider credentials the operator may not have, and the endpoint
// was never called directly.
//
// Run under the same alias loader as `npm start`, because the handlers import
// through "@/".
import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HANDLERS = path.join(HERE, "src", "sse", "handlers");

let pass = 0;
const pending = [];
const t = (name, fn) => pending.push(
  Promise.resolve().then(fn)
    .then(() => { console.log(`  ok  ${name}`); pass++; })
    .catch((e) => { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }),
);

const post = (pathname, body) => new Request(`http://127.0.0.1${pathname}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

t("the search handler runs instead of throwing", async () => {
  // Same commit, same mistake as the speech handler: fd8fd30 rewrote
  // `if (settings.requireApiKey)` as `clientApiKeyRequired({ model: modelStr, …})`
  // in a function whose model binding is called providerInput. Every
  // /v1/search call that reached the gate threw.
  const { handleSearch } = await import(path.join(HANDLERS, "search.js"));
  for (const body of [
    { provider: "tidak/ada", query: "halo" },
    { model: "tidak/ada", query: "halo" },
  ]) {
    const res = await handleSearch(post("/api/v1/search", body));
    assert.ok(res instanceof Response, "did not return a Response");
    assert.notEqual(res.status, 500, `500 -- ${(await res.text()).slice(0, 120)}`);
  }
});

t("every clientApiKeyRequired call passes a bound model", () => {
  // The sweep found two; this catches the next one. All eight call sites are in
  // this tree and each argument has to be a binding somewhere in its file.
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) files.push(p);
    }
  })(HANDLERS);

  const sites = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/clientApiKeyRequired\(\{\s*model:\s*(\w+)/g)) {
      const varName = m[1];
      const bound = new RegExp(
        `\\b(?:const|let|var|function)\\s+${varName}\\b|\\b${varName}\\s*=\\s*[^=]|function\\s*\\([^)]*\\b${varName}\\b`,
      ).test(src);
      sites.push({ f: path.relative(HERE, f), varName, bound });
    }
  }
  assert.ok(sites.length >= 8, `only ${sites.length} call sites found; the tree changed`);
  const unbound = sites.filter((x) => !x.bound);
  assert.equal(unbound.length, 0,
    "clientApiKeyRequired called with an unbound model:\n       " +
    unbound.map((x) => `${x.f} -> ${x.varName}`).join("\n       "));
});

t("the speech handler runs instead of throwing", async () => {
  const { handleTts } = await import(path.join(HANDLERS, "tts.js"));
  // Each of these reaches the api-key gate. Before the fix the first line of it
  // threw ReferenceError: apiKey is not defined.
  for (const [label, body] of [
    ["no model", { input: "hi" }],
    ["no input", { model: "tidak/ada" }],
    ["unknown model", { model: "tidak/ada", input: "hi" }],
  ]) {
    const res = await handleTts(post("/api/v1/audio/speech", body));
    assert.ok(res instanceof Response, `${label}: did not return a Response`);
    assert.ok(res.status >= 400 && res.status < 600, `${label}: status ${res.status}`);
    assert.ok(res.status !== 500, `${label}: 500 — ${(await res.text()).slice(0, 120)}`);
  }
});

t("a malformed body is a 400, not a crash", async () => {
  const { handleTts } = await import(path.join(HANDLERS, "tts.js"));
  const res = await handleTts(post("/api/v1/audio/speech", "{not json"));
  assert.equal(res.status, 400);
});

t("every handler that reads apiKey declares it", () => {
  // The shape of the fd8fd30 bug, checked statically across the handler tree so
  // the next refactor of a key gate cannot repeat it. Property reads and SQL
  // column names are excluded by requiring a declaration somewhere in the file.
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) files.push(p);
    }
  })(HANDLERS);

  const declared = (src) =>
    /(?:const|let|var)\s+\w*\s*=.*\bapiKey\b|\bapiKey\s*[,)]|[\[{]\s*apiKey\s*[,}:\]]/.test(src);

  const offenders = files.filter((f) => {
    const src = fs.readFileSync(f, "utf8");
    if (!/\bapiKey\b/.test(src) || declared(src)) return false;
    // A bare member read like `creds?.apiKey` is not a reference to a binding.
    return !/[\w)\]]\s*\??\.\s*apiKey\b|\.apiKey\b/.test(src)
        || /\bapiKey\s*\)/.test(src) || /\bapiKey\s*,/.test(src);
  });

  assert.equal(offenders.length, 0,
    "apiKey is referenced with no declaration in:\n       " +
    offenders.map((f) => path.relative(HERE, f)).join("\n       "));
});

t("tts.js still imports what it uses", () => {
  const src = fs.readFileSync(path.join(HANDLERS, "tts.js"), "utf8");
  assert.ok(/extractApiKey,\s*isValidApiKey/.test(src), "the auth imports were dropped");
  assert.ok(/const apiKey = extractApiKey\(request\);/.test(src),
    "handleTts reads apiKey without extracting it");
  assert.ok(src.indexOf("const apiKey = extractApiKey") < src.indexOf("if (!apiKey)"),
    "the key is extracted after it is checked");
});

Promise.all(pending).then(() =>
  console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`));