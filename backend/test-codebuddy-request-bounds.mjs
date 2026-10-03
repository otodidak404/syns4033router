// /api/automation/codebuddy — what a request is allowed to ask for.
//
// Three things in route.ts accepted whatever the body said. The inbox count had no
// ceiling, and each inbox is a serial network call with up to three retries, so one
// request could ask for more inboxes than there are and never return. The provider name
// was concatenated into `profiles/<provider>` and chooses the auth shape used later.
// And a clear-logs whose database update threw logged the error and answered { ok:
// true }, so a clear that did not happen read as one that did.

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROUTE = path.join(HERE, "./src/routes/automation/codebuddy/route.ts");
const src = fs.readFileSync(ROUTE, "utf8");

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

const limit = Number((src.match(/const MAX_GENERATED_INBOXES = (\d+);/) || [])[1]);

// The bound, transcribed.
function clampCount(raw) {
  return Math.min(Math.max(parseInt(raw) || 1, 1), limit);
}

t("the ceiling exists and is a number a person could mean", () => {
  assert.ok(Number.isInteger(limit), "MAX_GENERATED_INBOXES is missing or not an integer");
  assert.ok(limit >= 1 && limit <= 100, `${limit} is not a batch size`);
});

t("a count past the ceiling is clamped, not honoured", () => {
  assert.equal(clampCount(100000), limit);
  assert.equal(clampCount(999999999), limit);
  assert.equal(clampCount(Number.MAX_SAFE_INTEGER), limit);
  // "1e9" is not a decimal integer, so parseInt reads it as 1. That is safe, not a bug:
  // the property that matters is that nothing reaches the loop above the ceiling.
  for (const wild of ["1e9", "1e309", "  5000  ", "+9999", "0x1000", Infinity, -Infinity, NaN]) {
    const got = clampCount(wild);
    assert.ok(Number.isInteger(got) && got >= 1 && got <= limit,
      `count ${String(wild)} produced ${got}, which is outside 1..${limit}`);
  }
});

t("an ordinary count still works", () => {
  assert.equal(clampCount(1), 1);
  assert.equal(clampCount(5), 5);
  assert.equal(clampCount(limit), limit, "the ceiling itself is rejected");
});

t("a nonsense count still means one", () => {
  for (const bad of [undefined, null, "", "abc", {}, [], -5, 0]) {
    const got = clampCount(bad);
    assert.ok(got >= 1 && got <= limit, `count ${JSON.stringify(bad)} produced ${got}`);
  }
});

t("the route clamps rather than passing the body value through", () => {
  const at = src.indexOf('action === "auto-generate-email"');
  assert.ok(at > 0, "the action is gone");
  const end = src.indexOf('action === "add-google"');
  const seg = src.slice(at, end);
  assert.ok(/Math\.min\(Math\.max\(parseInt\(count\) \|\| 1, 1\), MAX_GENERATED_INBOXES\)/.test(seg),
    "the count is still taken straight from the body");
  assert.ok(!/const numCount = parseInt\(count\) \|\| 1;/.test(seg),
    "the unclamped assignment is still there");
});

t("the provider is checked against a set, not concatenated into a path", () => {
  assert.ok(/const TARGET_PROVIDERS = new Set\(/.test(src), "no allow-list");
  const block = src.slice(src.indexOf("function normaliseTargetProvider"));
  assert.ok(/TARGET_PROVIDERS\.has\(/.test(block), "the allow-list is not consulted");
  // An empty set would reject everything, which reads as "validation working".
  const listed = (src.match(/const TARGET_PROVIDERS = new Set\(\[([\s\S]*?)\]\);/) || [])[1] || "";
  const members = (listed.match(/"[^"]+"/g) || []);
  assert.ok(members.length >= 4,
    `the allow-list has ${members.length} members, so every provider would be rejected`);
  for (const used of (src.match(/provider === "([a-z-]+)"/g) || []).map((x) => x.match(/"([a-z-]+)"/)[1])) {
    assert.ok(members.includes(`"${used}"`),
      `the route special-cases "${used}" downstream but the allow-list rejects it`);
  }
  assert.ok(/throw new HttpError\(400/.test(block), "an unknown provider is not a 400");
  // Every binding of targetProvider must come through the allow-list. Checking this by
  // enumerating the calls misses the case where a call is removed, which is exactly the
  // mutation, so the assignments are checked instead.
  const bindings = src.match(/const targetProvider = [^;]+;/g) || [];
  assert.ok(bindings.length >= 2, `expected both actions to bind a provider, found ${bindings.length}`);
  for (const b of bindings) {
    assert.ok(/normaliseTargetProvider\(/.test(b),
      `a provider is taken from the request without being checked: ${b}`);
  }
  // Traversal strings must not survive into anything that builds a path.
  const pathUse = src.match(/path\.(?:resolve|join)\([^)]*targetProvider[^)]*\)/g) || [];
  for (const use of pathUse) {
    assert.ok(/normaliseTargetProvider/.test(src.slice(0, src.indexOf(use))),
      "a path is built from a provider that was not validated first");
  }
});

t("a rejected provider is a 400, not a 500", () => {
  assert.ok(/error instanceof HttpError \? error\.status : 500/.test(src),
    "every failure is still a 500, so a bad request looks like a server fault");
});

t("a clear-logs that failed is not reported as cleared", () => {
  const at = src.indexOf('action === "clear-logs"');
  const end = src.indexOf("Unknown action");
  const seg = src.slice(at, end);
  assert.ok(/ok: false/.test(seg), "the failure branch still says ok:true");
  assert.ok(/res\.status\(500\)/.test(seg), "the failure is not a 500");
  assert.ok(/Could not clear/.test(seg), "the failure does not say what failed");
  // and the success answer must come after the try, not inside the catch
  const catchAt = seg.indexOf("catch");
  const okAt = seg.lastIndexOf("return res.json({ ok: true })");
  assert.ok(okAt > catchAt, "the success answer is still inside the catch");
});

drain();