// /dashboard/proxy-pools — the writers that decide whether a proxy stays in rotation.
//
// handleHealthCheck asks the server to test every selected pool, then offers to
// disable the ones that came back dead. Three defects lived in that one flow:
//
//  1. `await res.json()` on a response that a proxy answered with HTML threw, and
//     the catch marked the pool dead — a parse failure read as a dead proxy.
//  2. A non-2xx, including the 401 an expired dashboard session produces, also
//     marked the pool dead. Every proxy then looked dead, and confirming would
//     have disabled all of them.
//  3. The disable loop never checked res.ok and swallowed network errors, then
//     reported "Disabled N dead proxies" regardless of what was actually saved.
//
// The other writers are checked too, because a page where some writers are careful
// and one is not is how this keeps happening: handleToggleActive, bulkSetActive and
// bulkDelete already roll back and count.

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PAGE = path.join(HERE, "../frontend/src/pages/proxy-pools/page.jsx");
const src = fs.readFileSync(PAGE, "utf8");

/** The body of one handler, by its declaration line. */
function handler(name) {
  // fetchProxyPools is wrapped in useCallback, so match the name rather than the
  // exact prefix.
  const start = src.indexOf(`const ${name} = `);
  assert.ok(start > 0, `${name} not found in page.jsx`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} has no end`);
}

let pass = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }
function drain() {
  for (const { name, fn } of queue) {
    try { fn(); pass++; console.log(`  ok   ${name}`); }
    catch (e) { process.exitCode = 1; console.log(`  FAIL ${name}\n       ${e?.message || e}`); }
  }
  console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);
}

const health = handler("handleHealthCheck");

// ── the three outcomes ───────────────────────────────────────────────────────

t("a pool the server never judged is not counted as dead", () => {
  assert.ok(/unknownIds/.test(health),
    "handleHealthCheck has no bucket for a test it could not perform");
  // The distinction is worthless if every failure still lands in deadIds. The
  // first catch in the handler belongs to the JSON parse, so start after it.
  const afterParse = health.slice(health.indexOf("} catch { data = null; }") + 26);
  const at = afterParse.indexOf("} catch {");
  assert.ok(at >= 0, "the request catch is missing from handleHealthCheck");
  // Bounded: the request catch is a bare block, not the rest of the handler.
  const reqCatch = afterParse.slice(at, afterParse.indexOf("}", at + 10) + 1);
  assert.ok(reqCatch.length < 200, `the request catch looks unbounded: ${reqCatch.length}`);
  assert.ok(/unknownIds\.push\(pool\.id\)/.test(reqCatch),
    `a thrown request still marks the pool dead: ${reqCatch.slice(0, 90)}`);
  assert.ok(!/deadIds\.push\(pool\.id\)/.test(reqCatch),
    "the request catch still marks the pool dead");
});

t("a non-2xx test response is unknown, not dead", () => {
  assert.ok(/if \(!res\.ok\)[\s\S]{0,120}unknownIds\.push/.test(health),
    "an expired session or a 500 still marks the pool dead");
  assert.ok(!/if \(res\.ok && data\.ok\) alive \+= 1; else deadIds\.push\(pool\.id\);/.test(health),
    "the old two-bucket line is still there");
});

t("only a successful response with ok:true counts as alive", () => {
  assert.ok(/data && data\.ok === true/.test(health),
    "aliveness is not decided by data.ok === true");
});

t("the test response is parsed defensively", () => {
  assert.ok(/await res\.text\(\)/.test(health),
    "the handler still calls res.json() directly, which throws on an HTML error page");
  assert.ok(!/await res\.json\(\)/.test(health),
    "handleHealthCheck still parses the test response as JSON without a guard");
});

// ── the disable loop ─────────────────────────────────────────────────────────

t("the disable loop checks each write", () => {
  assert.ok(/if \(res\.ok\) disabled \+= 1;/.test(health),
    "the disable loop does not count what was actually saved");
  assert.ok(!/catch \{\}/.test(health),
    "the disable loop still swallows its errors");
  assert.ok(/failedIds\.push\(id\)/.test(health),
    "a failed disable is not recorded");
});

t("the summary names what failed instead of claiming success", () => {
  assert.ok(/notify\.success\(`Disabled \$\{disabled\} dead proxies`\)/.test(health),
    "the success message does not use the real count");
  assert.ok(/notify\.error\([\s\S]{0,200}Disabled \$\{disabled\} of \$\{deadIds\.length\}/.test(health),
    "a partial disable is not reported as an error");
  assert.ok(!/notify\.success\(`Disabled \$\{deadIds\.length\}/.test(health),
    "the message still claims every id was disabled");
});

t("the confirmation says which pools were left alone", () => {
  assert.ok(/Could not check/.test(health),
    "the dialog does not mention the pools that could not be checked");
  assert.ok(/left alone/.test(health),
    "the dialog does not say the unchecked pools are untouched");
});

// ── the load path ────────────────────────────────────────────────────────────

t("a failed load is visible rather than an empty page", () => {
  const load = handler("fetchProxyPools");
  assert.ok(/if \(!res\.ok\)/.test(load),
    "fetchProxyPools ignores the status");
  assert.ok(/setLoadError\(/.test(load), "a failed load sets nothing");
  // The banner existing is not the claim; it has to be gated on the error, or it is
  // dead markup that never appears.
  assert.ok(/\{loadError && \(/.test(src), "the banner is not gated on loadError");
  assert.ok(/role="alert"/.test(src), "the error is never rendered");
  assert.ok(/aria-label="Retry"/.test(src), "there is no way to retry from the page");
});

// ── the writers that were already right ──────────────────────────────────────

t("the toggle still rolls back on failure", () => {
  const h = handler("handleToggleActive");
  assert.ok(/if \(!res\.ok\)/.test(h), "handleToggleActive lost its status check");
  // Both the failure branch and the catch branch roll back. Replacing only the
  // first occurrence left the second, which is why this control was green first.
  const rollbacks = h.match(/isActive: pool\.isActive/g) || [];
  assert.equal(rollbacks.length, 2,
    `expected a rollback in the failure branch and in the catch, found ${rollbacks.length}`);
});

t("the bulk writers still count ok and failed", () => {
  for (const name of ["bulkSetActive", "bulkDelete"]) {
    const h = handler(name);
    assert.ok(/failed/.test(h), `${name} no longer counts failures`);
    assert.ok(/res\.ok/.test(h), `${name} no longer checks the status`);
  }
});

t("the save path reports a failure that is not JSON", () => {
  const save = handler("handleSave");
  assert.ok(/await res\.text\(\)/.test(save),
    "the save error branch still assumes JSON");
  assert.ok(/catch[\s\S]{0,140}notify\.error/.test(save),
    "a thrown save is still only logged to the console");
});

drain();
