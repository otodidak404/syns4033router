import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), "utf8");

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const server = read("src/server.ts");

// /api/settings returns JWT_SECRET, API_KEY_SECRET and MACHINE_ID_SALT in
// plaintext, and /api/settings/database returns those with the whole config.
// Nothing told a cache not to keep them.
t("API responses are marked no-store", () => {
  assert.ok(/Cache-Control["',\s]+no-store/.test(server),
    "no Cache-Control: no-store anywhere in the middleware chain");
  assert.ok(/Pragma/.test(server) && /Expires/.test(server),
    "legacy caches also need Pragma and Expires");
});

t("the cache policy runs before the routes", () => {
  const at = server.indexOf("no-store");
  const firstRoute = server.indexOf('app.get("/api/health"');
  assert.ok(at > -1 && firstRoute > at,
    "the header has to be set before a handler can send a response");
});

t("it covers the mounted prefixes, case-insensitively", () => {
  const block = server.slice(server.indexOf("no-store") - 400, server.indexOf("no-store") + 700);
  for (const p of ["/api", "/v1", "/v1beta"]) {
    assert.ok(block.includes(`"${p}"`) || block.includes(`'${p}'`),
      `${p} is not covered`);
  }
  assert.ok(/toLowerCase\(\)/.test(block),
    "a case-sensitive prefix check would miss /API and /V1");
});

t("no dead ETag handling is claimed", () => {
  // An earlier version called res.removeHeader("ETag") here and asserted it
  // worked. It does not: this middleware runs before the handler, and Express
  // generates the ETag while sending the body. The header is still in the
  // response. It is harmless under no-store, so the code and the claim are
  // both gone rather than left asserting something untrue.
  assert.ok(!/removeHeader\(\s*["']ETag["']/.test(server),
    "an ETag removal that never takes effect is back");
  assert.ok(/harmless: no-store forbids a cache/.test(server),
    "the reason ETag can stay is not documented");
});

t("the middleware does not swallow the request", () => {
  const block = server.slice(server.indexOf("no-store") - 400, server.indexOf("no-store") + 900);
  assert.ok(/next\(\)/.test(block), "next() is not called, so no route would ever run");
  const head = block.slice(0, block.indexOf("next();"));
  assert.ok(!/\breturn\b/.test(head),
    "an early return before next() would skip every route");
});

// The README has to say it, because the export is a deliberate feature: the
// alternative — dropping the secrets — would restore a config that cannot
// verify its own sessions.
t("the README warns that the export is a live credential", () => {
  const rd = read("../README.md");
  assert.ok(/database export contains live credentials/i.test(rd),
    "no warning about the export in the README");
  assert.ok(/JWT_SECRET/.test(rd) && /plaintext/i.test(rd),
    "the warning does not name what is inside");
  assert.ok(/session signing|signs|signed/i.test(rd),
    "the warning does not explain why the signing secret is dangerous");
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);