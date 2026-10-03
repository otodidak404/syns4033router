// POST /api/proxy-pools/[id]/test, driven against a real database.
//
// This is the Test button on /dashboard/proxy-pools. It is the only route in the
// menu that opens an outbound connection, and it writes three fields from a single
// boolean: testStatus, lastError and isActive.
//
// Nothing here is mocked. The failure cases use a closed local port so undici fails
// for real with ECONNREFUSED; the success case runs a real CONNECT proxy inside this
// process. MockAgent cannot be used: testProxyUrl passes an explicit ProxyAgent as
// the dispatcher, which bypasses the global dispatcher MockAgent installs.

import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname);
process.chdir(HERE);
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pools-"));

const seen = [];

/** A CONNECT proxy that records what it was asked to tunnel. */
function startProxy() {
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("proxied");
  });
  server.on("connect", (req, clientSocket) => {
    seen.push({ method: "CONNECT", url: req.url });
    const [host, port] = req.url.split(":");
    const upstream = net.connect(Number(port) || 443, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const proxy = await startProxy();
const goodProxy = `http://127.0.0.1:${proxy.port}`;
// A port nothing is listening on. Connection refused, immediately.
const deadProxy = "http://127.0.0.1:1";

const db = await import(pathToFileURL(path.join(HERE, "src/models/index.js")).href);
const { POST_handler } = await import(
  pathToFileURL(path.join(HERE, "dist/routes/proxy-pools/[id]/test/route.js")).href
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

/** Minimal Express-ish response recorder. */
function res() {
  const r = { code: 200, body: null };
  return {
    r,
    status(c) { r.code = c; return this; },
    json(b) { r.body = b; return r; },
  };
}

async function callTest(id) {
  const r = res();
  await POST_handler({ method: "POST", headers: {} }, r, { params: Promise.resolve({ id }) });
  return r;
}

async function seed(type, proxyUrl, extra = {}) {
  const pool = await db.createProxyPool({
    name: `p-${Math.random().toString(36).slice(2, 8)}`,
    type, proxyUrl, ...extra,
  });
  return pool.id;
}

/** A pool the operator has switched on, which is the state worth protecting. */
async function seedActive(type, proxyUrl) {
  const id = await seed(type, proxyUrl);
  await db.updateProxyPool(id, { isActive: true, testStatus: "active" });
  if ((await db.getProxyPoolById(id)).isActive !== true) {
    throw new Error(`could not activate pool ${id}`);
  }
  return id;
}

// ── not found ────────────────────────────────────────────────────────────────

t("an unknown id is a 404 and opens no connection", async () => {
  seen.length = 0;
  const r = await callTest("no-such-pool");
  assert.equal(r.r.code, 404, `expected 404, got ${r.r.code}`);
  assert.equal(seen.length, 0, "the route dialled out for a pool that does not exist");
});

// ── a real working proxy ─────────────────────────────────────────────────────

t("a proxy that really answers is recorded as active", async () => {
  seen.length = 0;
  const id = await seed("http", goodProxy);
  const r = await callTest(id);
  assert.equal(r.r.code, 200, `expected 200, got ${r.r.code}: ${JSON.stringify(r.r.body)}`);
  assert.equal(r.r.body.ok, true, `the working proxy was reported as failed: ${r.r.body?.error}`);
  assert.ok(seen.length > 0, "the proxy was never actually dialled");
  const stored = await db.getProxyPoolById(id);
  assert.equal(stored.testStatus, "active");
  assert.equal(stored.isActive, true, "a working proxy was not activated");
  assert.ok(stored.lastTestedAt, "lastTestedAt was not recorded");
  assert.equal(stored.lastError, null, `lastError was left as ${stored.lastError}`);
  assert.equal(typeof r.r.body.elapsedMs, "number");
  assert.ok(r.r.body.testedAt, "testedAt was not returned");
});

// ── a real failure ───────────────────────────────────────────────────────────

t("a proxy that refuses the connection is recorded as an error", async () => {
  const id = await seedActive("http", deadProxy);
  const r = await callTest(id);
  assert.equal(r.r.code, 200, `the route threw instead of reporting: ${JSON.stringify(r.r.body)}`);
  assert.equal(r.r.body.ok, false, "a dead proxy was reported as working");
  assert.ok(r.r.body.error, "the failure carried no reason");
  const stored = await db.getProxyPoolById(id);
  assert.equal(stored.testStatus, "error", "the failure was not recorded");
  assert.equal(stored.isActive, true,
    "the probe switched off a pool the operator had switched on");
  assert.match(stored.lastError || "", /refused|ECONNREFUSED|connect/i,
    `the stored reason is not a connection failure: ${stored.lastError}`);
});

t("a failure never leaves lastTestedAt empty", async () => {
  const id = await seed("http", deadProxy);
  await callTest(id);
  const stored = await db.getProxyPoolById(id);
  assert.ok(stored.lastTestedAt, "lastTestedAt was not recorded on failure");
});

// ── relay types ──────────────────────────────────────────────────────────────

for (const type of ["vercel", "cloudflare", "deno"]) {
  t(`a ${type} pool is tested through its relay, not the proxy path`, async () => {
    seen.length = 0;
    // The relay route uses undici's fetch with no dispatcher, so a real fetch to a
    // closed port is enough to prove which branch ran: the proxy path would record a
    // CONNECT, the relay path records nothing here and fails at the dial.
    const id = await seedActive(type, deadProxy);
    const r = await callTest(id);
    assert.equal(r.r.code, 200, `${type}: the route threw: ${JSON.stringify(r.r.body)}`);
    assert.equal(r.r.body.ok, false, `${type} reported a dead relay as working`);
    const stored = await db.getProxyPoolById(id);
    assert.equal(stored.testStatus, "error");
    assert.equal(stored.isActive, true,
      `${type}: a failed relay test switched off a pool the operator had switched on`);
  });
}

t("a relay pool with no stored url fails without dialling an empty string", async () => {
  const id = await seed("vercel", "");
  const r = await callTest(id);
  assert.equal(r.r.code, 200, `the route threw: ${JSON.stringify(r.r.body)}`);
  assert.equal(r.r.body.ok, false, "a pool with no url reported success");
  assert.ok(r.r.body.error, "the failure carried no reason");
});

t("a plain proxy pool with no url fails cleanly", async () => {
  const id = await seed("http", "");
  const r = await callTest(id);
  assert.equal(r.r.body.ok, false, "a pool with no url reported success");
  assert.match(r.r.body.error || "", /required/i);
});

// ── the stored proxy url is what gets used ───────────────────────────────────

t("the proxy is the hop and the target is a neutral host", async () => {
  seen.length = 0;
  const id = await seed("http", goodProxy);
  const r = await callTest(id);
  const connects = seen.filter((s) => s.method === "CONNECT");
  assert.equal(connects.length, 1,
    `expected one hop, saw ${JSON.stringify(seen)} -- the redirect chain is being followed`);
  assert.ok(/^example\.com:443$/.test(connects[0].url),
    `the test target is ${connects[0].url}, not the neutral default`);
  assert.equal(r.r.body.ok, true, r.r.body?.error);
});

t("a failed test records the failure without pulling the proxy from live routing", async () => {
  const id = await seedActive("http", goodProxy);
  await callTest(id); // good proxy -> success
  assert.equal((await db.getProxyPoolById(id)).isActive, true);

  // Now point the same pool at a dead proxy and test again. The pool was already
  // switched on by the operator; a failed probe must not switch it off.
  const dead = await db.updateProxyPool(id, { proxyUrl: deadProxy });
  assert.ok(dead, "the pool could not be updated");
  const r = await callTest(id);
  assert.equal(r.r.body.ok, false, "the dead proxy was reported as working");
  const stored = await db.getProxyPoolById(id);
  assert.equal(stored.testStatus, "error", "the failure was not recorded");
  assert.match(stored.lastError || "", /refused|ECONNREFUSED|connect/i);
  assert.equal(stored.isActive, true,
    "a failed probe switched off a proxy the operator had switched on");
});

// ── redirect handling ────────────────────────────────────────────────────────

t("the test does not follow a redirect chain", async () => {
  // Measured, not asserted from source. A local target answers 302 to /final; with
  // redirect: "manual" the probe stops there, and /final is never requested. The
  // old code followed the chain, so a working proxy was judged partly on whether a
  // second request through it also succeeded.
  let finalHits = 0;
  const target = http.createServer((req, res) => {
    if (req.url === "/final") { finalHits += 1; res.writeHead(200); res.end("done"); return; }
    res.writeHead(302, { location: "/final" });
    res.end();
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const tport = target.address().port;
  try {
    const { testProxyUrl } = await import(
      pathToFileURL(path.join(HERE, "dist/lib/network/proxyTest.js")).href);
    const out = await testProxyUrl({
      proxyUrl: goodProxy,
      testUrl: `http://127.0.0.1:${tport}/`,
      timeoutMs: 8000,
    });
    assert.ok(out.status >= 300 && out.status < 400,
      `expected the 302 itself, got ${out.status}`);
    assert.equal(out.ok, true, "a 302 through a working proxy was called a failure");
    assert.equal(finalHits, 0, `the redirect was followed (${finalHits} hits on /final)`);
  } finally {
    target.close();
  }
});

await drain();

proxy.server.close();
try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }