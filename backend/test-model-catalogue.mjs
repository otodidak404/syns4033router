// The model catalogue exists in two files: the frontend ships its own copy and
// the backend keeps another under open-sse/config. Nothing connected them.
//
// That is not a neutral duplication. OpenCode Free had all five of its catalogue
// entries commented out in both, so it appeared in no picker and in no
// /v1/models listing while still working when called directly — and fixing only
// one copy left /api/models still reporting zero oc/* models after a deploy.
import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(HERE, "open-sse/config/providerModels.js");
const FRONTEND = path.join(HERE, "../frontend/src/shared/config/providerModels.js");

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

/** The model ids declared under one provider key, ignoring commented lines. */
function idsFor(file, key) {
  const src = fs.readFileSync(file, "utf8");
  const start = src.indexOf(`\n  ${key}: [`);
  assert.ok(start !== -1, `${key} has no catalogue entry in ${path.basename(file)}`);
  const block = src.slice(start, src.indexOf("\n  ],", start));
  return block.split("\n")
    .filter(l => l.trim().startsWith("{") && !l.trim().startsWith("//"))
    .map(l => l.match(/id:\s*"([^"]+)"/)?.[1])
    .filter(Boolean);
}

const be = idsFor(BACKEND, "oc");
const fe = idsFor(FRONTEND, "oc");

t("the oc catalogue is not empty", () => {
  assert.ok(be.length > 0,
    "an empty oc catalogue is what made the provider invisible in every picker");
});

t("the backend and frontend catalogues agree", () => {
  assert.deepStrictEqual([...be].sort(), [...fe].sort(),
    `drift between copies:\n  backend: ${be}\n  frontend: ${fe}`);
});

t("no oc model is left commented out", () => {
  const src = fs.readFileSync(BACKEND, "utf8");
  const start = src.indexOf("\n  oc: [");
  const block = src.slice(start, src.indexOf("\n  ],", start));
  const commented = block.split("\n").filter(l => l.trim().startsWith("// { id:"));
  assert.strictEqual(commented.length, 0,
    "commented-out ids stay invisible; remove them rather than leave them parked");
});

t("the free model the deployment is verified against is listed", () => {
  assert.ok(be.includes("space-bunny-free"),
    "space-bunny-free is confirmed working over /v1; it must be nameable in the UI");
});

t("every listed oc model is a free one", () => {
  // The provider is noAuth: true. Listing a paid id here would promise a model
  // that cannot run without a key the provider never asked for.
  const notFree = be.filter(m => !m.includes("free"));
  assert.deepStrictEqual(notFree, [],
    `non-free ids under a noAuth provider: ${notFree}`);
});

t("no id is duplicated within the oc catalogue", () => {
  assert.strictEqual(new Set(be).size, be.length, "duplicate ids in the oc catalogue");
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);