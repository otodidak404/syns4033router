// /api/automation/ammail — where the OTP webhook points.
//
// Both the GET summary and the webhook-register action built the webhook address from
// req.headers["host"] and req.headers["x-forwarded-proto"]. For the register path that
// address is handed to the mail Worker, which POSTs every OTP delivery to it, signed
// with the webhook secret. A request carrying `Host: evil.example` therefore got the
// OTP feed pointed at the caller, with a real signature.
//
// The two are now different: the dashboard shows an address (labelled, and allowed to
// come from the Host header because a wrong-looking value on screen is a nuisance), and
// registration refuses to use Host at all.

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const LIB = path.join(HERE, "./src/lib/net/publicUrl.js");
const ROUTE = path.join(HERE, "./src/routes/automation/ammail/route.ts");

const { displayBaseUrl, registrationBaseUrl, isPlausibleHostHeader } = await import(LIB);

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

const req = (headers) => ({ headers });

// ── registration must never come from the request ───────────────────────────

t("registration refuses when nothing is configured", () => {
  const r = registrationBaseUrl({ tunnelUrl: "", env: {} });
  assert.equal(r.ok, false, "it registered a webhook with no trusted address at all");
  assert.match(r.reason, /AMMAIL_PUBLIC_URL/, "the reason does not name the variable to set");
});

t("registration ignores the request entirely", () => {
  // The route used to build this from headers; the function has no headers parameter at
  // all now, which is the property that makes the guarantee hold.
  assert.equal(registrationBaseUrl.length, 0, "it takes positional arguments again");
  assert.equal(typeof registrationBaseUrl({ tunnelUrl: "", env: {} }).baseUrl, "undefined");
});

t("registration uses the tunnel when there is one", () => {
  const r = registrationBaseUrl({ tunnelUrl: "https://abc.trycloudflare.com/", env: {} });
  assert.equal(r.ok, true);
  assert.equal(r.baseUrl, "https://abc.trycloudflare.com", "the trailing slash survived");
  assert.equal(r.source, "tunnel");
});

t("registration prefers an explicit public URL over the tunnel", () => {
  const r = registrationBaseUrl({
    tunnelUrl: "https://abc.trycloudflare.com",
    env: { AMMAIL_PUBLIC_URL: "https://router.example.com/" },
  });
  assert.equal(r.baseUrl, "https://router.example.com");
  assert.equal(r.source, "AMMAIL_PUBLIC_URL");
});

t("registration rejects a value that is not an http address", () => {
  for (const bad of ["not a url", "javascript:alert(1)", "//evil.example", "file:///etc/passwd", "ftp://x.example"]) {
    const r = registrationBaseUrl({ tunnelUrl: "", env: { AMMAIL_PUBLIC_URL: bad } });
    assert.equal(r.ok, false, `it accepted ${JSON.stringify(bad)} as the OTP webhook address`);
  }
});

t("the address it returns is the address it validated", () => {
  // The first version validated new URL(x).host and then returned x itself, so
  // https://user@evil.example passed the check and came back still carrying the
  // userinfo. What is registered has to be rebuilt from the parts that were checked.
  const r = registrationBaseUrl({ tunnelUrl: "", env: { AMMAIL_PUBLIC_URL: "https://user@evil.example/p?x=1#f" } });
  assert.equal(r.baseUrl, "https://evil.example",
    "the registered address still carries credentials, a path, a query or a fragment");
  for (const creds of ["https://user:pw@evil.example", "https://evil.example@attacker.test"]) {
    const got = registrationBaseUrl({ tunnelUrl: "", env: { AMMAIL_PUBLIC_URL: creds } });
    assert.ok(!got.baseUrl.includes("@"),
      `the registered address kept userinfo from ${creds}: ${got.baseUrl}`);
  }
  const viaTunnel = registrationBaseUrl({ tunnelUrl: "https://u@abc.trycloudflare.com/", env: {} });
  assert.equal(viaTunnel.baseUrl, "https://abc.trycloudflare.com",
    "the tunnel path returned the raw value too");
});

// ── display may come from the header, but must not be trusted ───────────────

t("display falls back to the Host header and says it is untrusted", () => {
  const d = displayBaseUrl(req({ host: "router.example.com", "x-forwarded-proto": "https" }), {});
  assert.equal(d.baseUrl, "https://router.example.com");
  assert.equal(d.trusted, false, "a Host header value is being reported as trusted");
  assert.equal(d.source, "host-header");
});

t("a configured address is trusted", () => {
  const d = displayBaseUrl(req({ host: "evil.example" }), { AMMAIL_PUBLIC_URL: "https://router.example.com" });
  assert.equal(d.baseUrl, "https://router.example.com");
  assert.equal(d.trusted, true);
});

t("a Host header carrying userinfo or a path is refused", () => {
  for (const bad of [
    "evil.example#@router.example.com",
    "router.example.com/../evil",
    "user@evil.example",
    "router.example.com router2",
    "",
  ]) {
    const d = displayBaseUrl(req({ host: bad }), {});
    assert.ok(!d.baseUrl.includes("evil"), `host ${JSON.stringify(bad)} produced ${d.baseUrl}`);
    assert.equal(d.trusted, false);
  }
});

t("a host header cannot smuggle a path past the webhook suffix", () => {
  const d = displayBaseUrl(req({ host: "evil.example#@router.example.com" }), {});
  const url = d.baseUrl ? `${d.baseUrl}/api/automation/ammail/webhook` : "";
  assert.ok(!url.includes("#"), `the fragment survived: ${url}`);
  assert.ok(!url.includes("@"), `the userinfo survived: ${url}`);
});

t("an unparseable header does not crash it", () => {
  for (const headers of [undefined, {}, { host: undefined }, { host: [] }, { host: [1, 2] }]) {
    const d = displayBaseUrl(req(headers), {});
    assert.equal(typeof d.baseUrl, "string");
  }
});

t("host header validation is exported and does what the route assumes", () => {
  assert.equal(isPlausibleHostHeader("router.example.com"), true);
  assert.equal(isPlausibleHostHeader("router.example.com:3001"), true);
  assert.equal(isPlausibleHostHeader("[::1]"), true);
  assert.equal(isPlausibleHostHeader("-bad.example.com"), false);
  assert.equal(isPlausibleHostHeader("bad host"), false);
});

// ── the route ────────────────────────────────────────────────────────────────

t("the route no longer reads the host header for registration", () => {
  const src = fs.readFileSync(ROUTE, "utf8");
  assert.ok(!/req\.headers\[["']host["']\]/.test(src),
    "the route still reads the host header somewhere");
  // Bound the slice to the branch. Running it to the end of the file let a later
  // action's res.status(400) satisfy the assertion, so removing this branch's refusal
  // stayed green.
  const regStart = src.indexOf('action === "webhook-register"');
  const regEnd = src.indexOf('action === "webhook-test"');
  assert.ok(regStart > 0 && regEnd > regStart, "the register branch boundaries moved");
  const reg = src.slice(regStart, regEnd);
  assert.ok(!/req\.headers/.test(reg), "the register branch still touches request headers");
  assert.ok(/registrationBaseUrl\(/.test(reg), "the register branch does not use the guard");
  assert.ok(/res\.status\(400\)/.test(reg),
    "the refusal is not a 400, so the dashboard cannot tell what to do");
  assert.ok(/if \(!target\.ok\)/.test(reg), "the guard result is never checked");
  assert.ok(/target\.baseUrl/.test(reg), "the registered address is not the validated one");
});

t("the route still shows an address in the dashboard", () => {
  const src = fs.readFileSync(ROUTE, "utf8");
  assert.ok(/displayBaseUrl\(/.test(src), "the dashboard no longer shows a webhook address");
  assert.ok(/webhook_url_trusted/.test(src), "the dashboard is not told the address is untrusted");
});

drain();
