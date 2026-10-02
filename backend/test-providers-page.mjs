// /dashboard/providers wrote state to the UI before the write succeeded, and never
// looked at the result.
//
// fetch() rejects only on a network error. An HTTP 404 or 500 is a normal
// response, so Promise.all resolves and Promise.allSettled reports "fulfilled"
// with ok === false. Verified against the live deployment: a PUT to a missing
// connection returned 404, Promise.all's catch never ran, and allSettled
// reported fulfilled with ok === false. Every one of those call sites set local
// state first, so a rejected write left the card showing an order, an API-key
// gate or an enabled flag that the server never accepted.
//
// Seven sites were fixed here. The repo-wide version of that scan lives in
// test-usage-page.mjs — this file covers what is specific to this page.
import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

import { walk } from "./testlib/frontend-scan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), "utf8");
const PAGES = path.join(HERE, "..", "frontend", "src", "pages", "providers");

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const src = (rel) => read(path.join("..", "frontend", "src", "pages", "providers", rel));

t("expectOk exists and throws on a failed response", () => {
  const api = read("../frontend/src/shared/utils/api.js");
  assert.ok(/export async function expectOk\(response\)/.test(api), "expectOk is missing");
  // Scoped to the body: api.js also throws inside handleResponse, so testing the
  // whole file passes whether or not expectOk itself ever throws.
  const i = api.indexOf("export async function expectOk");
  const fn = api.slice(i, api.indexOf("\n}\n", i));
  assert.ok(/if \(response\.ok\) return response;/.test(fn), "ok responses are not passed through");
  assert.ok(/\bthrow\b/.test(fn), "a failed response does not throw");
  assert.ok(/response\.clone\(\)/.test(fn), "reading the body without cloning would consume it");
});

t("patch is available, which is why these sites hand-rolled fetch", () => {
  const api = read("../frontend/src/shared/utils/api.js");
  assert.ok(/export async function patch\(/.test(api), "no patch helper");
  assert.ok(/const api = \{[^}]*\bpatch\b/.test(api), "patch is not on the default export");
});

t("the abandoned rewrite is gone", () => {
  // 1722 lines with no importer, sitting beside the live 1762-line file under a
  // name that looks current. Editing the wrong one is the failure it invites.
  assert.ok(!fs.existsSync(path.join(PAGES, "[id]", "page.new.jsx")), "page.new.jsx is back");
  for (const f of walk(PAGES)) {
    assert.ok(!/page\.new/.test(fs.readFileSync(f, "utf8")),
      `${path.relative(PAGES, f)} still refers to page.new`);
  }
});

t("the live provider page is still there", () => {
  assert.ok(fs.existsSync(path.join(PAGES, "[id]", "page.jsx")), "the live page was removed instead");
  assert.ok(src("[id]/page.jsx").split("\n").length > 1500, "the live page shrank unexpectedly");
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);