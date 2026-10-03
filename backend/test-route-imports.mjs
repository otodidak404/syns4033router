// Every route file is imported by the auto-router at boot, so a relative import
// that does not resolve takes the whole server down — not just that endpoint.
//
// It reaches production easily. `npm run build` and `tsc --noEmit` both resolve
// paths from src/, while the failure happens from dist/, where `src/` is stripped.
// A route one directory shallower than the one it was copied from compiles
// cleanly, passes typecheck, and only fails when the container starts.
//
// This resolves each relative specifier in the built output against the
// filesystem instead of importing it. Importing would run module-level code —
// database initialisation, network calls — which is why an earlier version of
// this check hung; and a path that does not exist is the entire failure mode
// anyway, so the filesystem is the right source of truth.
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DIST = path.join(HERE, "dist");

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const routeRoot = path.join(DIST, "routes");
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".js")) files.push(full);
  }
})(routeRoot);

// Relative specifiers only: bare and @/ specifiers resolve through the loader
// and node_modules, which this is not checking.
const SPECIFIER = /(?:^|[\s(])(?:import|export)[\s\S]{0,400}?from\s*["'](\.[^"']+)["']/g;
const BARE_IMPORT = /import\s*\(\s*["'](\.[^"']+)["']\s*\)/g;

function specifiersIn(file) {
  const src = fs.readFileSync(file, "utf8");
  const found = new Set();
  for (const m of src.matchAll(SPECIFIER)) found.add(m[1]);
  for (const m of src.matchAll(BARE_IMPORT)) found.add(m[1]);
  return [...found];
}

/**
 * Does this specifier point at a file or a directory index that exists?
 *
 * In src/ a specifier ending in `.js` routinely names a `.ts` file -- the
 * TypeScript convention the whole tree uses, e.g.
 * `import ... from "../claude-settings/route.js"` resolving to route.ts. Trying
 * `${base}.ts` alone does not cover that, because the `.js` is already part of
 * the path, so the swap has to happen on the extension.
 */
function resolves(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.js`, `${base}.ts`, path.join(base, "index.js")];
  if (base.endsWith(".js")) {
    const asTs = base.slice(0, -3) + ".ts";
    candidates.splice(1, 0, asTs, asTs.replace(/\.ts$/, ".tsx"));
  }
  if (base.endsWith(".mjs")) {
    candidates.splice(1, 0, base.slice(0, -4) + ".mts");
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return true;
  }
  return false;
}

t("the backend was built before this suite ran", () => {
  assert.ok(fs.existsSync(routeRoot), "dist/routes is missing — run `npm run build` first");
});

t("route files were found", () => {
  assert.ok(files.length > 100, `only ${files.length} files found`);
});

const broken = [];
let checked = 0;
for (const file of files) {
  for (const spec of specifiersIn(file)) {
    checked += 1;
    if (!resolves(file, spec)) {
      broken.push(`${path.relative(DIST, file)} → ${spec}`);
    }
  }
}

t("every relative import in dist/ resolves to a real file", () => {
  assert.strictEqual(
    broken.length, 0,
    `${broken.length} unresolvable import(s):\n       ` + broken.slice(0, 10).join("\n       ")
  );
});

// dist/ alone was not enough. A wrong depth in src/ still builds, still passes
// typecheck, and still passes the dist/ sweep above when dist is stale -- it only
// fails when the container boots, and the auto-router aborts the whole server on
// one bad route file. The path written here was ../../../../ where the module
// lives five levels up, so src/open-sse/utils/error.js was the file it looked for.
//
// The source tree is checked directly, and the two are reported together because
// a specifier can be fine in one and wrong in the other.
const SRC_ROUTE_ROOT = path.join(HERE, "src", "routes");
const srcFiles = [];
(function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) srcFiles.push(full);
  }
})(SRC_ROUTE_ROOT);

const srcBroken = [];
let srcChecked = 0;
for (const file of srcFiles) {
  for (const spec of specifiersIn(file)) {
    srcChecked += 1;
    if (!resolves(file, spec)) {
      srcBroken.push(`${path.relative(HERE, file)} → ${spec}`);
    }
  }
}

t("every relative import in src/routes resolves to a real file", () => {
  assert.ok(srcFiles.length > 100, `only ${srcFiles.length} source route files found`);
  assert.strictEqual(
    srcBroken.length, 0,
    `${srcBroken.length} unresolvable source import(s) -- the auto-router imports ` +
    `every route at boot, so one of these takes the entire server down:\n       `
    + srcBroken.slice(0, 10).join("\n       ")
  );
});

t("the source sweep inspected something", () => {
  assert.ok(srcChecked > srcFiles.length,
    `only ${srcChecked} specifiers across ${srcFiles.length} source files`);
});

t("the check actually inspected something", () => {
  assert.ok(checked > files.length, `only ${checked} specifiers across ${files.length} files`);
});

console.log(
  `\n${pass} passed — ${checked} relative imports across ${files.length} built files, `
  + `${srcChecked} across ${srcFiles.length} source files`
  + `${process.exitCode ? ", some failed" : ""}`
);