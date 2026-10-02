// /dashboard/usage had the same defect as /dashboard/providers, in the bulk
// connection toggle on the Provider Limits panel.
//
// bulkSetActive awaited Promise.all over PUT /api/providers/:id and then
// reconciled the list. fetch() rejects only on a network error; an HTTP 404 or
// 500 is an ordinary response that resolves. So the aggregate resolved, the
// reconcile fetched the unchanged server state, and the operator was told the
// bulk enable or disable had worked.
//
// This suite is repo-wide on purpose. The same pattern has now been found on
// three separate pages, and each time it was a page-by-page hunt. A guard that
// only covers the page it was written for does not stop the fourth.
import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FE = path.join(HERE, "..", "frontend", "src");
const API = path.join(HERE, "..", "frontend", "src", "shared", "utils", "api.js");

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx|tsx|js|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

const WRITE = /method:\s*"(PUT|POST|PATCH|DELETE)"/;
// Promise.all / allSettled — the earlier form required a literal "settle" and
// matched nothing at all, which is how a real unguarded call went unflagged.
const BATCH = /Promise\.all(?:Settled)?\s*\(/g;   // matchAll needs the g flag

// A fetch options object spans several lines and the guard is chained past the
// closing paren, so the batch is cut out by matching its own brackets.
function batchedWrites(src) {
  const hits = [];
  for (const m of src.matchAll(BATCH)) {
    const open = m.index + m[0].length - 1;
    let depth = 0, close = -1;
    for (let j = open; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") { depth--; if (depth === 0) { close = j; break; } }
    }
    if (close < 0) continue;
    const batch = src.slice(open, close + 1);
    let idx = 0;
    while ((idx = batch.indexOf("fetch(", idx)) !== -1) {
      let d = 0, k = batch.indexOf("(", idx);
      while (k < batch.length) {
        if (batch[k] === "(") d++;
        else if (batch[k] === ")") { d--; if (d === 0) break; }
        k++;
      }
      const chained = batch.slice(idx, k + 40);
      const method = chained.match(WRITE);
      if (method) hits.push({ method: method[1], guarded: /\)\.then\(expectOk\)/.test(chained), chained });
      idx = k + 1;
    }
  }
  return hits;
}

t("expectOk is available for pages to use", () => {
  const src = fs.readFileSync(API, "utf8");
  assert.ok(/export async function expectOk\(response\)/.test(src), "expectOk is missing");
  // Scoped to the function: api.js also throws inside handleResponse, so testing
  // the whole file passes whether or not expectOk itself ever throws.
  const i = src.indexOf("export async function expectOk");
  const fn = src.slice(i, src.indexOf("\n}\n", i));
  assert.ok(/if \(response\.ok\) return response;/.test(fn), "ok responses are not passed through");
  assert.ok(/\bthrow\b/.test(fn), "a failed response does not throw");
});

t("no batched write anywhere in the app is unguarded", () => {
  const offenders = [];
  let checked = 0;
  for (const f of walk(FE)) {
    const src = fs.readFileSync(f, "utf8");
    for (const h of batchedWrites(src)) {
      checked++;
      if (!h.guarded) {
        offenders.push(`${path.relative(FE, f)}  batched ${h.method}  ${h.chained.split(/\s+/).join(" ").slice(0, 70)}`);
      }
    }
  }
  assert.ok(checked > 0, "the scan matched nothing — it is not finding anything because it is broken");
  assert.equal(offenders.length, 0, "unguarded batched writes:\n       " + offenders.join("\n       "));
});

t("every page that uses expectOk imports it", () => {
  for (const f of walk(FE)) {
    const src = fs.readFileSync(f, "utf8");
    if (!/\.then\(expectOk\)/.test(src)) continue;
    assert.ok(/import \{[^}]*\bexpectOk\b[^}]*\} from "@\/shared\/utils\/api"/.test(src),
      `${path.relative(FE, f)} calls expectOk but never imports it`);
  }
});

t("the usage page's bulk toggle checks before reconciling", () => {
  const p = path.join(FE, "pages", "usage", "components", "ProviderLimits", "index.jsx");
  const src = fs.readFileSync(p, "utf8");
  const i = src.indexOf("const bulkSetActive");
  const fn = src.slice(i, src.indexOf("\n  );", i));
  assert.ok(/Promise\.allSettled/.test(fn), "the failure is no longer inspected");
  assert.ok(/results\.some\(\(r\) => r\.status === "rejected"\)/.test(fn),
    "the results are collected but never checked");
  const checkAt = fn.indexOf('r.status === "rejected"');
  const reconcileAt = fn.indexOf("reconcileConnectionsPage");
  assert.ok(checkAt > -1 && reconcileAt > checkAt,
    "it reconciles before knowing whether the writes succeeded");
});

t("the usage endpoints the page reads all answer", () => {
  const R = path.join(HERE, "src", "routes", "usage");
  for (const r of ["chart", "providers", "request-details", "stats", "history", "[connectionId]"]) {
    assert.ok(fs.existsSync(path.join(R, r, "route.ts")), `usage/${r} has no route`);
  }
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);