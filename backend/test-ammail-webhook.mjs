// POST /api/automation/ammail/webhook — the one unauthenticated, public endpoint
// in the automation menu.
//
// Two defects, both provable without an account:
//
//  1. The HMAC is computed over JSON.stringify(req.body), not over the bytes the
//     sender signed. Re-serialising cannot reproduce key order, whitespace or number
//     formatting, so a correctly signed delivery is rejected with 401.
//  2. With no secret configured the signature check returns true, so anyone who
//     finds the URL can write an OTP for any address into the store — including an
//     address the operator is currently waiting on.

import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname);
process.chdir(HERE);
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ammail-"));

const db = await import(pathToFileURL(path.join(HERE, "src/lib/localDb.js")).href);
const { POST_handler } = await import(
  pathToFileURL(path.join(HERE, "dist/routes/automation/ammail/webhook/route.js")).href
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

function res() {
  const r = { code: 200, body: null };
  return { r, status(c) { r.code = c; return this; }, json(b) { r.body = b; return r; } };
}

/** Deliver exactly these bytes, the way express.json's verify hook hands them over. */
async function deliver(rawText, parsedBody, headers = {}) {
  const r = res();
  await POST_handler({ body: parsedBody, headers, rawBody: rawText }, r);
  return r.r;
}

const SECRET = "s3cr3t-webhook-key";
const payload = {
  event: "email.received",
  data: { inbox: { address: "Operator@Example.com", alias: "Operator" },
          message: { id: "m1", from_address: "noreply@github.com",
                     subject: "Your code is 123456", snippet: "code 123456" } },
};
// The bytes a real sender would sign. Notice the spaces after the colons.
const rawBytes = JSON.stringify(payload, null, 2);

t("a correctly signed delivery is accepted", async () => {
  await db.updateSettings({ ammail_webhook_secret: SECRET });
  const sig = crypto.createHmac("sha256", SECRET).update(rawBytes).digest("hex");
  const r = await deliver(rawBytes, payload, { "x-tempmail-signature": `sha256=${sig}` });
  assert.equal(r.code, 200, `the signature was rejected: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.ok, true);
});

t("the signature is checked over the bytes that arrived, not a re-serialisation", async () => {
  // The defect: JSON.stringify(req.body) cannot reproduce pretty-printing, so the
  // HMAC of the raw delivery never matched and every real webhook got a 401.
  await db.updateSettings({ ammail_webhook_secret: SECRET });
  const sig = crypto.createHmac("sha256", SECRET).update(rawBytes).digest("hex");
  const r = await deliver(rawBytes, payload, { "x-tempmail-signature": `sha256=${sig}` });
  assert.equal(r.code, 200, `a correctly signed delivery was rejected: ${JSON.stringify(r.body)}`);
  assert.notEqual(
    crypto.createHmac("sha256", SECRET).update(JSON.stringify(payload)).digest("hex"), sig,
    "the test is not actually exercising a re-serialisation difference");
});

t("a delivery whose raw body is unavailable is refused, not waved through", async () => {
  await db.updateSettings({ ammail_webhook_secret: SECRET });
  const sig = crypto.createHmac("sha256", SECRET).update(rawBytes).digest("hex");
  const r = await deliver(rawBytes, payload, { "x-tempmail-signature": sig });
  const noRaw = res();
  await POST_handler({ body: payload, headers: { "x-tempmail-signature": sig } }, noRaw);
  assert.equal(noRaw.r.code, 400,
    `a request with no raw body was answered ${noRaw.r.code}: ${JSON.stringify(noRaw.r.body)}`);
  assert.equal(noRaw.r.body.error, "raw_body_unavailable");
  void r;
});

t("a delivery signed with the wrong key is refused", async () => {
  await db.updateSettings({ ammail_webhook_secret: SECRET });
  const sig = crypto.createHmac("sha256", "wrong-key").update(rawBytes).digest("hex");
  const r = await deliver(rawBytes, payload, { "x-tempmail-signature": sig });
  assert.equal(r.code, 401, `a forged signature was accepted: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error, "invalid_signature");
});

t("a delivery with no signature at all is refused when a secret is set", async () => {
  await db.updateSettings({ ammail_webhook_secret: SECRET });
  const r = await deliver(rawBytes, payload, {});
  assert.equal(r.code, 401, "an unsigned delivery was accepted");
});

t("the check compares in constant time", async () => {
  const src = fs.readFileSync(
    path.join(HERE, "dist/routes/automation/ammail/webhook/route.js"), "utf8");
  assert.ok(src.includes("timingSafeEqual"),
    "the signature is no longer compared with timingSafeEqual");
  assert.ok(!/expected\s*===\s*sig\b/.test(src),
    "the signature is compared with === somewhere");
});

t("with no secret the endpoint refuses instead of accepting anyone", async () => {
  await db.updateSettings({ ammail_webhook_secret: "" });
  const r = await deliver(rawBytes, payload, {});
  assert.equal(r.code, 503, `answered ${r.code}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error, "webhook_disabled");
  assert.equal(r.body.ok, false);
});

t("the verifier has no open path when the secret is empty", () => {
  const src = fs.readFileSync(
    path.join(HERE, "dist/routes/automation/ammail/webhook/route.js"), "utf8");
  const at = src.indexOf("verifyAmmailSignature(secret");
  const fn = src.slice(at, at + 420);
  // The compiler splits a short if across lines, so a literal space never matches.
  const flat = fn.replace(/\s+/g, " ");
  assert.ok(!/if \(!secret\) ?return true;/.test(flat),
    `verifyAmmailSignature still returns true with no secret:\n${fn.slice(0, 160)}`);
});

t("the server keeps the raw body for the signature to be checked against", () => {
  // The unit tests above hand `rawBody` to the route directly, so they cannot see
  // whether the production path still captures it. This is that check.
  const srv = fs.readFileSync(path.join(HERE, "src/server.ts"), "utf8");
  const at = srv.indexOf("express.json(");
  assert.ok(at > 0, "express.json is not registered");
  const seg = srv.slice(at, at + 700);
  // (?:^|[^\w]) so `_verify:` does not count as a verify hook.
  assert.ok(/(?:^|[^\w])verify\s*:/.test(seg),
    "express.json has no verify hook, so req.rawBody is never populated");
  assert.ok(/rawBody\s*=/.test(seg), "the verify hook does not store the raw body");
  assert.ok(/buf\.toString\("utf8"\)/.test(seg),
    "the raw body is not captured as utf8 text");
  // The capture must be bounded. The parser on this global accepts 128mb, so an
  // unbounded verify hook would let an unauthenticated caller pin a 128 MB string
  // per request by sending a large JSON body.
  assert.ok(/RAW_BODY_LIMIT_BYTES/.test(seg),
    "the raw-body capture has no size bound");
  // Evaluate the expression rather than reading its first number: "128 * 1024 * 1024"
  // parses as 128, which passes a naive bound and is exactly the value to catch.
  const expr = (srv.match(/RAW_BODY_LIMIT_BYTES\s*=\s*([^;]+);/) || [])[1];
  assert.ok(expr, "the raw-body bound is not a plain expression");
  assert.ok(/^[\d\s*+()-]+$/.test(expr.trim()),
    `the raw-body bound is not arithmetic: ${expr}`);
  const lim = new Function(`return ${expr.trim()}`)();
  assert.ok(Number.isFinite(lim), `the raw-body bound does not evaluate: ${expr}`);
  assert.ok(lim > 0 && lim <= 4 * 1024 * 1024,
    `the raw-body bound is ${lim} bytes; a webhook payload needs far less`);
  const guardAt = srv.indexOf("buf.length > RAW_BODY_LIMIT_BYTES", at);
  assert.ok(guardAt > at, "the capture is not guarded by the size check");
});

await drain();
try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }