// /dashboard/quota is an eleven-line wrapper that renders the same
// ProviderLimits component as /dashboard/usage. The audit found no defect of its
// own, and this suite locks in why, so the next person does not go looking again:
//
//   1. the wrapper really is a passthrough, not a page that diverges silently
//   2. the empty state explains itself rather than rendering a bare empty table
//   3. the bulk toggle it inherits is guarded — the fix landed on the shared
//      component, so both routes get it
//
// The empty-list behaviour worth stating plainly: /api/providers/client filters
// to usage-eligible connections (oauth, cookie, or one of
// USAGE_APIKEY_PROVIDERS). An ordinary API-key connection — gemini, ollama,
// openrouter — has no upstream quota endpoint, so it is correctly absent. A
// deployment with only API-key connections therefore sees an empty list, and the
// page has to say why rather than look broken.
import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

import { batchedWrites, walk } from "./testlib/frontend-scan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FE = path.join(HERE, "..", "frontend", "src");
const read = (rel) => fs.readFileSync(path.join(HERE, rel), "utf8");
const QUOTA = path.join(FE, "pages", "quota", "page.jsx");
const LIMITS = path.join(FE, "pages", "usage", "components", "ProviderLimits", "index.jsx");
const CLIENT = path.join(HERE, "src", "routes", "providers", "client", "route.ts");

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

t("the quota page is the shared component, not a fork", () => {
  const src = fs.readFileSync(QUOTA, "utf8");
  assert.ok(/ProviderLimits/.test(src), "quota no longer renders ProviderLimits");
  // The import is relative, so match the suffix rather than the alias form.
  assert.ok(/\.\.\/usage\/components\/ProviderLimits/.test(src),
    "it points somewhere other than the usage component — the two pages may have diverged");
  assert.ok(!/fetch\(/.test(src), "the wrapper has its own data fetching; it should not");
});

t("the empty state explains why there is nothing to show", () => {
  const src = fs.readFileSync(LIMITS, "utf8");
  // Twice: once in the empty-state config, once as the heading it renders. A
  // single occurrence means half of it is gone — matching one of them still
  // passes, which is how the first version of this assertion missed a mutation.
  const heading = (src.match(/No Providers Connected/g) || []).length;
  assert.equal(heading, 2,
    `expected the empty-state title in both the config and the heading, found ${heading}`);
  assert.ok(/OAuth/.test(src), "the empty state no longer says which connections qualify");
  assert.ok(/quota limits and usage/.test(src), "the explanation was trimmed to nothing");
});

t("the empty list is the eligibility filter, not a fault", () => {
  const route = fs.readFileSync(CLIENT, "utf8");
  const i = route.indexOf("function isUsageEligible");
  const fn = route.slice(i, route.indexOf("\n}", i));
  assert.ok(/USAGE_SUPPORTED_PROVIDERS/.test(fn), "the provider gate is gone");
  assert.ok(/authType === "oauth"/.test(fn) && /authType === "cookie"/.test(fn),
    "oauth and cookie connections are no longer admitted");
  assert.ok(/USAGE_APIKEY_PROVIDERS/.test(fn), "the API-key carve-out is gone");
  assert.ok(/filter\(isUsageEligible\)/.test(route),
    "the filter is defined but not applied — every connection would be returned");
});

t("the bulk toggle both routes inherit is guarded", () => {
  const src = fs.readFileSync(LIMITS, "utf8");
  const writes = batchedWrites(src);
  assert.ok(writes.length > 0, "the scan found no batched write — it is not looking");
  for (const w of writes) {
    assert.ok(w.guarded, `batched ${w.method} with no expectOk: ${w.snippet}`);
  }
  const i = src.indexOf("const bulkSetActive");
  const fn = src.slice(i, src.indexOf("\n  );", i));
  assert.ok(/results\.some\(\(r\) => r\.status === "rejected"\)/.test(fn),
    "the settled results are collected but never read");
  assert.ok(fn.indexOf('r.status === "rejected"') < fn.indexOf("reconcileConnectionsPage"),
    "it reconciles before knowing whether the writes succeeded");
});

t("ProviderLimits takes no props, so both routes get the same behaviour", () => {
  const src = fs.readFileSync(LIMITS, "utf8");
  const m = src.match(/export default function ProviderLimits\(([^)]*)\)/);
  assert.ok(m, "the export shape changed");
  assert.equal(m[1].trim(), "",
    `ProviderLimits now takes (${m[1]}) — the quota page passes none, so behaviour would differ between routes`);
  assert.ok(/const \[page, setPage\] = useState\(1\)/.test(src),
    "`page` is no longer internal state; the quota route has no props to supply it");
});

t("no file under pages/quota or the shared component is dead", () => {
  const files = walk(path.join(FE, "pages", "quota"));
  assert.ok(files.length > 0, "the quota page directory is empty");
  for (const f of files) {
    assert.ok(!/\.new\.jsx$/.test(f), `${path.relative(FE, f)} is an abandoned rewrite`);
  }
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);