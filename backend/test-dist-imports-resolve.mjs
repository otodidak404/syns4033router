// A module that exists in src and in dist, imported without its extension, stops the
// whole server from starting.
//
//   Failed to import 1 route file(s):
//   automation/ammail/route.js: Cannot find module '/app/backend/dist/lib/net/publicUrl'
//
// The server runs as `node --loader ./bin/alias-loader.mjs dist/server.js`. That loader
// resolves the "@/..." aliases and nothing else; a relative specifier is left to Node's
// own resolver, which requires the extension. So an alias is fine and an extensionless
// relative import is not, and only importing the compiled modules shows which is which.
//
// This went to production because `npm run test` and `npm run typecheck` are run by
// run-tests.mjs, which only applies the loader to the suites that ask for it -- a new
// suite that forgets does not get it, and then every "@/..." import looks broken while
// the extensionless one is masked. This suite registers with the loader and says why.

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL, fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "dist");
const SRC = path.join(HERE, "src");

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

t("dist exists, so this suite is not passing vacuously", () => {
  assert.ok(fs.existsSync(DIST), "dist is missing -- run the build before this suite");
  assert.ok(fs.existsSync(path.join(SRC, "routes")), "src is missing");
});

// Every relative specifier in every compiled file under dist must resolve as Node would.
t("every relative import in dist carries a resolvable extension", () => {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".js")) files.push(full);
    }
  };
  // Only what the server loads. dist/shared/components is copied verbatim from src and
  // imports .jsx siblings for the frontend bundler; nothing in the request path ever
  // imports it, and flagging those would be noise rather than a defect.
  walk(path.join(DIST, "routes"));

  const unresolved = [];
  let checked = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/\bfrom\s*"(\.[^"]+)"/g)) {
      const spec = m[1];
      checked += 1;
      // Bare specifiers are the loader's business; relative ones are Node's.
      const base = path.resolve(path.dirname(f), spec);
      const ok = fs.existsSync(base)
        || fs.existsSync(base + ".js")
        || fs.existsSync(base + ".mjs")
        || fs.existsSync(base + ".json")
        || fs.existsSync(path.join(base, "index.js"));
      // The compiler emits a real extension, so anything without one is a defect even
      // when a fallback happened to find the file.
      const hasExt = /\.(js|mjs|cjs|json)$/.test(spec);
      if (!ok || !hasExt) {
        unresolved.push(`${path.relative(DIST, f)}: "${spec}"${ok ? " (resolved only by fallback)" : ""}`);
      }
    }
  }
  assert.ok(checked > 20, `only ${checked} relative imports found -- the walk is not reaching the tree`);
  assert.deepEqual(unresolved, [],
    `compiled modules import without an extension, which Node cannot resolve:\n${unresolved.slice(0, 12).join("\n")}`);
});

t("the module that caused the outage is present in dist and named in the route", async () => {
  const lib = path.join(DIST, "lib/net/publicUrl.js");
  assert.ok(fs.existsSync(lib), "the module is missing from dist");
  const route = fs.readFileSync(path.join(DIST, "routes/automation/ammail/route.js"), "utf8");
  assert.match(route, /publicUrl\.js"/,
    "the compiled route does not name the extension, so it will not import at runtime");
});

// The decisive one: import the compiled route the way buildAutoRouter does.
t("the compiled route that caused the outage imports", async () => {
  const route = path.join(DIST, "routes/automation/ammail/route.js");
  assert.ok(fs.existsSync(route), "the compiled route is missing");
  const mod = await import(pathToFileURL(route).href);
  assert.ok(typeof mod.POST_handler === "function" || typeof mod.POST === "function",
    `the route module loaded but exported ${Object.keys(mod).join(", ")}`);
});

drain();