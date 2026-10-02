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
import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), "utf8");
const PAGES = path.join(HERE, "..", "frontend", "src", "pages", "providers");

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const LIVE = ["page.jsx", "components/ConnectionsCard.jsx", "[id]/page.jsx"];

t("expectOk exists and throws on a failed response", () => {
  const api = read("../frontend/src/shared/utils/api.js");
  assert.ok(/export async function expectOk\(response\)/.test(api), "expectOk is missing");
  const i = api.indexOf("export async function expectOk");
  const fn = api.slice(i, api.indexOf("\n}", i));
  assert.ok(/if \(response\.ok\) return response;/.test(fn), "ok responses are not passed through");
  assert.ok(/\bthrow\b/.test(fn), "a failed response does not throw");
  assert.ok(/response\.clone\(\)/.test(fn), "reading the body without cloning would consume it");
});

t("patch is available, which is why these sites hand-rolled fetch", () => {
  const api = read("../frontend/src/shared/utils/api.js");
  assert.ok(/export async function patch\(/.test(api), "no patch helper");
  assert.ok(/const api = \{[^}]*\bpatch\b/.test(api), "patch is not on the default export");
});

t("no batched write on this page is left unguarded", () => {
  // Two things make this hard to get right: a fetch options object spans several
  // lines, and the guard is chained past the closing paren. So the batch is cut
  // out by matching its own brackets rather than by a fixed window — a window
  // wide enough to hold the multi-line fetch also reaches the next statement and
  // flags writes that were never part of the batch.
  const WRITE = /method:\s*"(PUT|POST|PATCH|DELETE)"/;
  for (const rel of LIVE) {
    const src = read(path.join("..", "frontend", "src", "pages", "providers", rel));
    for (const m of src.matchAll(/Promise\.all(Settled)?\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      let depth = 0;
      let close = open;
      for (; close < src.length; close++) {
        if (src[close] === "(") depth++;
        else if (src[close] === ")") { depth--; if (depth === 0) break; }
      }
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
        idx = k + 1;
        const method = chained.match(WRITE);
        if (!method) continue;                        // a GET, nothing to lose
        assert.ok(/\)\.then\(expectOk\)/.test(chained),
          `${rel}: a batched ${method[1]} has no expectOk — Promise.all resolves on a 404, so the failure never surfaces\n       ${chained.slice(0, 74).replace(/\s+/g, " ")}`);
      }
    }
  }
});

t("expectOk is imported wherever it is used", () => {
  for (const rel of LIVE) {
    const src = read(path.join("..", "frontend", "src", "pages", "providers", rel));
    const uses = (src.match(/\.then\(expectOk\)/g) || []).length;
    if (uses === 0) continue;
    assert.ok(/import \{[^}]*\bexpectOk\b[^}]*\} from "@\/shared\/utils\/api"/.test(src),
      `${rel} calls expectOk ${uses} times but never imports it`);
  }
});

t("the abandoned rewrite is gone", () => {
  // 1722 lines with no importer, sitting beside the live 1762-line file under a
  // name that looks current. Editing the wrong one is the failure it invites.
  assert.ok(!fs.existsSync(path.join(PAGES, "[id]", "page.new.jsx")),
    "page.new.jsx is back");
  for (const f of walk(PAGES)) {
    assert.ok(!/page\.new/.test(fs.readFileSync(f, "utf8")),
      `${path.relative(PAGES, f)} still refers to page.new`);
  }
});

t("the live provider page is still there", () => {
  assert.ok(fs.existsSync(path.join(PAGES, "[id]", "page.jsx")), "the live page was removed instead");
  const src = fs.readFileSync(path.join(PAGES, "[id]", "page.jsx"), "utf8");
  assert.ok(src.split("\n").length > 1500, "the live page shrank unexpectedly");
});

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);