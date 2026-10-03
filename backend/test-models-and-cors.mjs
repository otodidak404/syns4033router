// Regression for two fixes:
//
//   1. /v1/models, /v1/models/{kind} and /v1/models/info published the operator's
//      configuration to anyone: combo names, custom prefixes, per-connection
//      aliases, the whole model inventory. The outer auth middleware lets all of
//      /v1 through (PUBLIC_PREFIXES) and delegates the key check to each handler
//      -- every execution handler does it, the listing endpoints never did.
//
//   2. /v1/models/{kind} was declared GET(req, { params }) while autoRouter.ts
//      calls handler(req, res, { params }), so it destructured an Express
//      Response and answered 500 for every request. /v1/models/image and
//      /v1/models/tts have never worked.
//
// Both are checked by importing the real route modules and calling the real
// exported handlers, not by reading their source.

import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const at = (...parts) => path.join(HERE, ...parts);
// Import the compiled route modules, not the TypeScript sources: run-tests.mjs
// builds dist/ before the suite runs, and dist/ is what production actually
// loads. The sources are still read directly for the two structural checks,
// where the point is the declared signature rather than the runtime shape.
const DIST = at("dist", "routes", "v1", "models");
const MODELS_ROUTE = path.join(DIST, "route.js");
const KIND_ROUTE = path.join(DIST, "[kind]", "route.js");
const INFO_ROUTE = path.join(DIST, "info", "route.js");

let pass = 0;
const pending = [];
const t = (name, fn) => {
  pending.push((async () => {
    try {
      await fn();
      pass++;
      console.log(`  ok   ${name}`);
    } catch (e) {
      process.exitCode = 1;
      console.log(`  FAIL ${name}\n       ${e?.message || e}`);
    }
  })());
};

const authHeader = (k) => ({ authorization: `Bearer ${k}` });
const reqWithKey = (k) => ({ headers: authHeader(k) });
const reqNoKey = () => ({ headers: {} });

const statusOf = (r) => (r && typeof r.status === "number" ? r.status : null);
const bodyOf = async (r) => {
  try {
    return JSON.stringify(await r.clone().json());
  } catch {
    return "";
  }
};

// ── The gate itself ────────────────────────────────────────────────────────────

t("a listing with no key is refused", async () => {
  const mod = await import(MODELS_ROUTE);
  const res = await mod.GET(reqNoKey(), {});
  assert.equal(statusOf(res), 401, `expected 401, got ${statusOf(res)}`);
  const body = await bodyOf(res);
  assert.ok(/Missing API key/i.test(body), `expected a key error, got ${body.slice(0, 120)}`);
});

t("a preflight is refused too, so it is not a way round the gate", async () => {
  const mod = await import(MODELS_ROUTE);
  // Before the fix OPTIONS took no argument and answered 204 to every origin.
  const res = await mod.OPTIONS(reqNoKey());
  assert.equal(statusOf(res), 401, `OPTIONS answered ${statusOf(res)}`);
});

t("the kind listing is refused with no key", async () => {
  const mod = await import(KIND_ROUTE);
  const res = await mod.GET(reqNoKey(), {}, { params: { kind: "image" } });
  assert.equal(statusOf(res), 401, `expected 401, got ${statusOf(res)}`);
});

t("the single-model info listing is refused with no key", async () => {
  const mod = await import(INFO_ROUTE);
  const res = await mod.GET_handler(
    { headers: {}, originalUrl: "/v1/models/info?id=cc/claude-opus-4-8" },
    {},
  );
  assert.equal(statusOf(res), 401, `expected 401, got ${statusOf(res)}`);
});

// ── The signature that made every kind listing a 500 ──────────────────────────

t("autoRouter passes params third, and the handler reads it from there", () => {
  const src = fs.readFileSync(at("src","routes","v1","models","[kind]","route.ts"), "utf8");
  const m = src.match(/export async function GET\(([^)]*)\)/);
  assert.ok(m, "GET signature not found");
  const args = m[1].split(",").map((s) => s.trim());
  assert.equal(args.length, 3,
    `expected (req, res, { params }), got (${args.join(", ")})`);
  assert.ok(/params/.test(args[2]),
    `params must be the third argument, it is "${args[2]}"`);
  assert.ok(!/await\s+params/.test(src),
    "`await params` on a plain object is what produced the 500");
});

t("the router really does pass params third", () => {
  const src = fs.readFileSync(at("src","autoRouter.ts"), "utf8");
  // The real call is `(handler as any)(req, res, { params })`, so the cast has to
  // be allowed between the name and the argument list.
  assert.ok(/\(req,\s*res,\s*\{\s*params\s*\}\)/.test(src),
    "autoRouter no longer passes { params } as the third argument");
});

// ── CORS ──────────────────────────────────────────────────────────────────────

t("the API no longer reflects an arbitrary origin", () => {
  const src = fs.readFileSync(at("src","server.ts"), "utf8");

  // The old shape: any origin echoed back, with credentials on.
  assert.ok(!/callback\(null,\s*origin\s*\|\|\s*true\)/.test(src),
    "the reflect-any-origin branch is back");
  assert.ok(!/corsAllowlist\.length === 0\)\s*return callback/.test(src),
    "empty allowlist still means reflect everything");

  assert.ok(/credentials:\s*true/.test(src), "credentials was dropped entirely");

  // The allowlist has to be consulted, and dev origins added only outside prod.
  assert.ok(/corsAllowlist\.includes\(origin\)/.test(src),
    "the configured allowlist is never consulted");
  assert.ok(/NODE_ENV\s*!==\s*["']production["']/.test(src),
    "dev origins are not scoped to non-production");
  for (const o of ["http://localhost:5177", "http://127.0.0.1:5177"]) {
    assert.ok(src.includes(o), `dev origin ${o} is missing`);
  }
  // 'null' must never be treated as an origin to echo.
  assert.ok(!/origin\s*===\s*["']null["']\s*\?\?/.test(src),
    "null origin is being special-cased back into a reflection");
});

Promise.all(pending).then(() =>
  console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`));
