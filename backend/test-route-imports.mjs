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

/** Does this specifier point at a file or a directory index that exists? */
function resolves(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.ts`, path.join(base, "index.js")]) {
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

t("the check actually inspected something", () => {
  assert.ok(checked > files.length, `only ${checked} specifiers across ${files.length} files`);
});

console.log(
  `\n${pass} passed — ${checked} relative imports across ${files.length} built files checked`
  + `${process.exitCode ? ", some failed" : ""}`
);