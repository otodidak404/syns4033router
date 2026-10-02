// Six defects from the security audit, each with the reason it was wrong. The
// tests read the real source rather than restating the fix, so rewriting the
// line they describe turns these red.
import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const B = HERE;   // every path in this file is backend-relative
const read = (rel) => fs.readFileSync(path.join(B, rel), "utf8");

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

// ── 1. /api/version/shutdown was reachable without auth ─────────────────────
// PUBLIC_API_PATHS held "/api/version" so its subpaths matched the public branch
// and returned before ALWAYS_PROTECTED was ever consulted. That route calls
// process.exit(0): anyone who found the URL could take the server down.
t("the public branch cannot grant a path that is always protected", () => {
  const src = read("src/middleware/auth.ts");
  const guardAt = src.indexOf("const alwaysProtected");
  const publicAt = src.indexOf("PUBLIC_API_PATHS.some");
  assert.ok(guardAt > -1, "ALWAYS_PROTECTED is no longer evaluated at all");
  assert.ok(publicAt > guardAt,
    "the public branch still runs first, so a public parent still shadows its children");
});

t("the public branch is skipped for always-protected paths", () => {
  const src = read("src/middleware/auth.ts");
  const block = src.slice(src.indexOf("const alwaysProtected"), src.indexOf("if (!alwaysProtected)"));
  assert.ok(/if \(!alwaysProtected\)/.test(src),
    "the public allowlist must be gated on !alwaysProtected");
});

// ── 2. updateApiKey wrote undefined into the key column ─────────────────────
// rowToKey deliberately omits `key` because only the hash is stored. The UPDATE
// wrote merged.key anyway, silently storing NULL, so toggling a key's active flag
// destroyed it — the route's only mutation.
t("updateApiKey does not write the key column", () => {
  const src = read("src/lib/db/repos/apiKeysRepo.js");
  const fn = src.slice(src.indexOf("export async function updateApiKey"));
  const sql = fn.match(/UPDATE apiKeys SET ([^\n]+)/);
  assert.ok(sql, "the UPDATE statement is gone");
  assert.ok(!/\bkey\s*=/.test(sql[1]),
    `the UPDATE still writes key: ${sql[1]}`);
  assert.ok(!/merged\.key/.test(fn.slice(0, 400)),
    "merged.key is still being passed as a parameter");
});

// ── 3. provider-nodes/validate fetched any caller-supplied URL ──────────────
// isValidUrl only asks whether new URL() parses, so 127.0.0.1, [::1], 0.0.0.0
// and the decimal and octal spellings all passed. Every fetch is built from that
// baseUrl and failures echo the upstream body back, making it a read primitive.
t("provider-nodes validation runs the SSRF guard", () => {
  const src = read("src/routes/provider-nodes/validate/route.ts");
  assert.ok(src.includes("checkFetchableUrl"), "the route does not use the guard");
  assert.ok(/checkFetchableUrl\(baseUrl/.test(src),
    "the guard must be applied to the caller's baseUrl");
  const at = src.indexOf("checkFetchableUrl(baseUrl");
  const firstFetch = src.search(/fetchWithTimeout\(`\$\{/);
  assert.ok(at > -1 && firstFetch > -1 && at < firstFetch,
    "the check has to happen before anything is fetched");
});

t("a rejected base URL produces a 403, not a fetch", () => {
  const src = read("src/routes/provider-nodes/validate/route.ts");
  assert.ok(/status\(403\)/.test(src), "a rejected URL must be refused outright");
});

// ── 4. importDb stored restored API keys in plaintext ──────────────────────
// validateApiKey looks a key up by hash, so a plaintext key restored verbatim
// could never match again — it 401'd permanently.
t("restored keys are hashed unless they are already hashes", () => {
  const src = read("src/lib/db/index.js");
  const fn = src.slice(src.indexOf("export async function importDb"));
  assert.ok(/isHashedKey\(k\.key\) \? k\.key : hashApiKey\(k\.key\)/.test(fn),
    "importDb must hash a plaintext key but leave an existing hash alone");
});

// ── 5. caveman injection had no idempotency guard ───────────────────────────
// The live prompt and the skill injector both check for their block before
// writing; this one did not, so a second pass stacked another copy.
t("caveman injection is idempotent like the other two", () => {
  const src = read("open-sse/rtk/caveman.js");
  // The check has to be in the function body. Matching readSystemText anywhere
  // in the file passed even with the guard deleted, because the import remained.
  const body = src.slice(src.indexOf("export function injectCaveman"));
  assert.ok(/injectSystemText, readSystemText/.test(src),
    "readSystemText is not imported");
  assert.ok(/readSystemText\(body,\s*format\)\.includes\(/.test(body),
    "the guard must actually compare the existing system text before writing");
});

// ── 6. /v1/web/fetch threw before its own auth check ───────────────────────
// modelStr was never declared in that scope, so the ReferenceError fired before
// clientApiKeyRequired ran. Fail-closed by accident, but the endpoint was dead.
t("web fetch no longer references an undeclared variable", () => {
  const src = read("src/sse/handlers/fetch.js");
  assert.ok(!/\bmodelStr\b/.test(src), "modelStr is still referenced");
  const declared = new Set(
    [...src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1])
  );
  const params = new Set(
    [...src.matchAll(/function\s+\w+\s*\(([^)]*)\)/g)]
      .flatMap(m => m[1].split(",").map(x => x.trim().split("=")[0].trim()).filter(Boolean))
  );
  for (const name of ["providerInput", "body", "settings"]) {
    assert.ok(declared.has(name) || params.has(name),
      `${name} is used in the auth check but never introduced`);
  }
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);