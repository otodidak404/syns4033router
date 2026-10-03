// The three relay sources that /dashboard/proxy-pools deploys.
//
// Two defects, both invisible to the unbound-identifier guard:
//
//  1. The Cloudflare and Deno relays read `req.headers[...]` and `req.method`, but
//     their parameter is `request`. Every request through those two relays raised
//     `ReferenceError: req is not defined`. The guard walks the AST of the route
//     file; this code lives inside a template literal, so to the parser it was a
//     string and was never checked. The same parser is used here, on the string.
//
//  2. All three fetch whatever `x-relay-target` names, with no check. The fetch runs
//     on Vercel / Cloudflare / Deno, not on this router, so `checkFetchableUrl`
//     cannot see it: deploying a relay published an open proxy that could reach the
//     host's loopback, link-local and private ranges on the operator's own account.
//
// The guard function is evaluated out of the deployed source and run against real
// URLs, so "it has a check" is separated from "the check works".

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { parse } from "@babel/parser";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROUTES = path.join(HERE, "src/routes/proxy-pools");

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

/** Everything between the first pair of backticks: the code the platform runs. */
function relaySource(name) {
  const src = fs.readFileSync(path.join(ROUTES, name, "route.ts"), "utf8");
  const i = src.indexOf("`");
  const j = src.indexOf("`", i + 1);
  assert.ok(i > 0 && j > i, `${name}: no relay template literal found`);
  const raw = src.slice(i + 1, j);
  assert.ok(raw.length > 200, `${name}: extracted only ${raw.length} chars`);
  // What the platform actually receives: the template literal's escapes are
  // resolved before the string is evaluated. Parsing the raw source instead made
  // `target.replace(/\\/$/, "")` look like a malformed regular expression, which
  // is an artefact of reading the file rather than of what gets deployed.
  return raw
    .replace(/\\([\\`$])/g, "$1")
    .replace(/\`/g, "`");
}

const RELAYS = {
  vercel: relaySource("vercel-deploy"),
  "cloudflare-deploy": relaySource("cloudflare-deploy"),
  deno: relaySource("deno-deploy"),
};

/** Globals the edge runtimes provide. */
const PLATFORM_GLOBALS = new Set([
  "fetch", "Headers", "Response", "Request", "URL", "URLSearchParams",
  "console", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "TextEncoder", "TextDecoder", "atob", "btoa", "crypto", "AbortController",
  "Deno", "module", "exports", "require", "process", "Buffer", "structuredClone",
  "Array", "Object", "JSON", "String", "Number", "Boolean", "Promise", "Error",
  "RegExp", "Map", "Set", "Symbol", "Math", "Date", "isNaN", "parseInt",
  "parseFloat", "encodeURIComponent", "decodeURIComponent", "self", "globalThis",
]);

// ── 1. it parses at all ──────────────────────────────────────────────────────

for (const [kind, source] of Object.entries(RELAYS)) {
  t(`the ${kind} relay source parses as a module`, () => {
    assert.doesNotThrow(
      () => parse(source, { sourceType: "module", errorRecovery: false }),
      "the deployed relay does not parse, so it never ran at all");
  });
}

// ── 2. the relay runs, and only reads what it binds ──────────────────────────
//
// This used to be a scope walker over the AST, which reported every `const` in the
// file as unbound. Running the deployed code is both simpler and stronger: a
// ReferenceError cannot survive being called.

/** Strip the module syntax the platform handles, leaving plain statements. */
function asScript(source, kind) {
  if (kind === "vercel") {
    return `${source.replace(/export const config = /, "const config = ")
                    .replace(/export default async function/, "async function")}`;
  }
  if (kind === "cloudflare-deploy") {
    return `${source.replace(/export default\s*\{/, "const __worker = {")}`;
  }
  return `const __cap = { fn: null };
const Deno = { serve: (h) => { __cap.fn = h; } };
${source}
return __cap.fn;`;
}

/** Build the callable the platform installs, with `fetch` bound to our stub. */
function buildHandler(kind, source, fetchImpl) {
  const script = asScript(source, kind);
  if (kind === "vercel") {
    const f = new Function("fetch", "Headers", "Response", "URL", `${script}\nreturn handler;`);
    return f(fetchImpl, Headers, Response, URL);
  }
  if (kind === "cloudflare-deploy") {
    const f = new Function("fetch", "Headers", "Response", "URL",
      `${script}\nreturn __worker.fetch;`);
    return f(fetchImpl, Headers, Response, URL);
  }
  const f = new Function("fetch", "Headers", "Response", "URL", script);
  return f(fetchImpl, Headers, Response, URL);
}

/** A Request that carries the relay headers. */
function makeRequest(target, path = "/x", method = "GET") {
  return new Request("https://relay.example.test/", {
    method,
    headers: { "x-relay-target": target, "x-relay-path": path },
  });
}

for (const [kind, source] of Object.entries(RELAYS)) {
  t(`the ${kind} relay runs and refuses without reaching fetch`, async () => {
    let fetched = null;
    const fetchImpl = async (u) => { fetched = u; return new Response("upstream"); };
    let handler = null;
    assert.doesNotThrow(() => { handler = buildHandler(kind, source, fetchImpl); },
      `${kind} could not be loaded`);
    assert.equal(typeof handler, "function", `${kind} exposes no handler`);

    const res = await handler(makeRequest("http://169.254.169.254/latest/meta-data/"));
    assert.equal(res.status, 403,
      `${kind} answered ${res.status} for the metadata address, not 403`);
    assert.equal(fetched, null, `${kind} fetched ${fetched} after refusing it`);
    const body = await res.json();
    assert.ok(typeof body.error === "string" && body.error.length > 0,
      `${kind} refused without saying why`);
  });

  t(`the ${kind} relay still relays a public target`, async () => {
    let fetched = null;
    const fetchImpl = async (u, init) => {
      fetched = String(u);
      return new Response("page body", { status: 200, headers: { "content-type": "text/plain" } });
    };
    const handler = buildHandler(kind, source, fetchImpl);
    const res = await handler(makeRequest("https://example.com", "/page"));
    assert.equal(res.status, 200, `${kind} answered ${res.status} for a public target`);
    assert.ok(fetched && fetched.startsWith("https://example.com/page"),
      `${kind} fetched ${fetched} instead of the target plus path`);
    assert.equal(await res.text(), "page body", `${kind} did not pass the body through`);
  });

  t(`the ${kind} relay cannot be walked to another host through x-relay-path`, async () => {
    // "https://example.com" + "@evil.com/" resolves to evil.com. The check runs on
    // the assembled URL for exactly this reason.
    let fetched = null;
    const fetchImpl = async (u) => { fetched = String(u); return new Response("x"); };
    const handler = buildHandler(kind, source, fetchImpl);
    const res = await handler(makeRequest("https://example.com", "@169.254.169.254/"));
    assert.notEqual(res.status, 200, `${kind} followed the path into another host`);
    assert.equal(fetched, null, `${kind} fetched ${fetched}`);
  });

  t(`the ${kind} relay refuses a private target reached through the path`, async () => {
    let fetched = null;
    const fetchImpl = async (u) => { fetched = u; return new Response("x"); };
    const handler = buildHandler(kind, source, fetchImpl);
    // The path is appended to the target, so a blocked host must stay blocked even
    // when the request looks well formed.
    const res = await handler(makeRequest("http://192.168.0.1", "/admin"));
    assert.equal(res.status, 403, `${kind} answered ${res.status}`);
    assert.equal(fetched, null, `${kind} fetched ${fetched}`);
  });
}

// ── 3. the target is checked, and the check works ────────────────────────────

const BLOCKED = [
  "http://169.254.169.254/latest/meta-data/",
  "http://127.0.0.1:8080/",
  "http://localhost/",
  "http://[::1]/",
  "http://10.1.2.3/",
  "http://192.168.0.1/",
  "http://172.16.5.4/",
  "http://100.64.0.1/",
  "http://metadata.google.internal/",
  "file:///etc/passwd",
  "gopher://example.com/",
];

/** Evaluate the guard the way the platform would: take it from the deployed source. */
function loadGuard(kind) {
  const source = RELAYS[kind];
  const cut = source.search(/export\s+default|Deno\.serve/);
  const head = (cut > 0 ? source.slice(0, cut) : source).replace(/\bexport\s+/g, "");
  assert.ok(head.includes("isForbiddenTarget"),
    `${kind} deploys no target check at all`);
  return new Function("URL", `${head}\nreturn isForbiddenTarget;`)(URL);
}

for (const kind of Object.keys(RELAYS)) {
  t(`the ${kind} relay refuses a target it must not fetch`, () => {
    const isForbiddenTarget = loadGuard(kind);
    for (const bad of BLOCKED) {
      const reason = isForbiddenTarget(bad);
      assert.ok(typeof reason === "string" && reason.length > 0,
        `${kind} would fetch ${bad}`);
    }
    assert.equal(isForbiddenTarget("https://example.com/page"), null,
      `${kind} refuses a legitimate public URL`);
    assert.equal(isForbiddenTarget("http://example.com:8080/a?b=c#d"), null,
      `${kind} refuses a public URL with a port and a query`);
  });
}

t("the guard does not fire on names that merely look private", () => {
  const isForbiddenTarget = loadGuard("vercel");
  for (const ok of ["https://127.0.0.1.nip.io/", "https://example.com",
                    "https://a10.b.com/", "https://192.168.example.org/",
                    "https://notlocalhost.example/"]) {
    assert.equal(isForbiddenTarget(ok), null, `${ok} was refused`);
  }
});

t("the guard is applied to the target before the fetch", () => {
  for (const kind of Object.keys(RELAYS)) {
    const source = RELAYS[kind];
    const fetchAt = source.indexOf("await fetch(targetUrl");
    assert.ok(fetchAt > 0, `${kind} does not fetch the target`);
    const before = source.slice(0, fetchAt);
    assert.ok(before.includes("isForbiddenTarget(target"),
      `${kind} calls fetch without checking the target first`);
    assert.ok(/status:\s*403/.test(before),
      `${kind} refuses a blocked target without a 403`);
  }
});

await drain();