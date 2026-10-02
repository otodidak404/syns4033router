// /dashboard/usage had the same defect as /dashboard/providers, in the bulk
// connection toggle on the Provider Limits panel.
//
// bulkSetActive awaited Promise.all over PUT /api/providers/:id and then
// reconciled the list. fetch() rejects only on a network error; an HTTP 404 or
// 500 is an ordinary response that resolves. So the aggregate resolved, the
// reconcile fetched the unchanged server state, and the operator was told the
// bulk enable or disable had worked when none of it had.
//
// The scan below is repo-wide, not page-scoped, and that is the point: the same
// pattern has now been found on four pages, each in a different shape, each by
// reading one page at a time. It turned up /dashboard/media-providers here — a
// menu nobody had audited — while looking for /dashboard/usage.
import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

import { describeOffenders, scanForUnguarded, walk } from "./testlib/frontend-scan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FE = path.join(HERE, "..", "frontend", "src");
const API = path.join(HERE, "..", "frontend", "src", "shared", "utils", "api.js");

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

t("expectOk is available for pages to use", () => {
  const src = fs.readFileSync(API, "utf8");
  assert.ok(/export async function expectOk\(response\)/.test(src), "expectOk is missing");
  // Scoped to the function body: api.js also throws inside handleResponse, so
  // testing the whole file passes whether or not expectOk itself ever throws.
  const i = src.indexOf("export async function expectOk");
  const fn = src.slice(i, src.indexOf("\n}\n", i));
  assert.ok(/if \(response\.ok\) return response;/.test(fn), "ok responses are not passed through");
  assert.ok(/\bthrow\b/.test(fn), "a failed response does not throw");
});

t("no batched write anywhere in the app is unguarded", () => {
  const { checked, offenders } = scanForUnguarded(FE);
  assert.ok(checked > 0, "the scan matched nothing — it is not finding anything because it is broken");
  assert.equal(offenders.length, 0, "unguarded batched writes:\n       " + describeOffenders(offenders));
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