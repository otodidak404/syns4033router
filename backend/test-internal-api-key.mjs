// getOrCreateInternalApiKey() backs every router-to-router self-call: the model
// test in the provider page, MITM auto-start, the model ping. Two failures made
// it silently dead —
//
//   1. the dynamic import resolved "../../shared/utils/machineId.js" from
//      src/lib/db/repos/, which is src/lib/shared/… and does not exist;
//   2. the rejected promise was cached, so the error repeated forever.
//
// Symptom was "HTTP 401: Missing API key" on every model in the provider page,
// including providers with a working key — a failure of ours reported as the
// operator's.
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intkey-test-"));
process.env.DATA_DIR = dir;

const REPO = path.join(path.dirname(new URL(import.meta.url).pathname));
const { getOrCreateInternalApiKey } = await import(
  path.join(REPO, "src/lib/db/repos/apiKeysRepo.js")
);

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

// Mint it inside the harness. At the top level a throw here would kill the
// process before any assertion is reported, which hides which check failed.
let key = null;
let mintError = null;
try { key = await getOrCreateInternalApiKey(); }
catch (e) { mintError = e; }

t("the internal key is minted", () => {
  assert.ok(
    key,
    `getOrCreateInternalApiKey() threw: ${mintError?.message || "no key returned"}`
  );
});

t("the key is a non-empty string", () => {
  assert.strictEqual(typeof key, "string");
  assert.ok(key.length >= 16, `too short: ${key.length}`);
});

t("the module that resolves the machine id is importable", () => {
  // The regression: this exact import used to throw ERR_MODULE_NOT_FOUND
  // because the relative path was one level short.
  const p = path.join(REPO, "src/shared/utils/machineId.js");
  assert.ok(fs.existsSync(p), `${p} does not exist`);
});

t("a repeated call returns the same key rather than minting a new one", async () => {
  if (!key) return; // already reported above
  const again = await getOrCreateInternalApiKey();
  assert.strictEqual(again, key);
});

t("a failure is not cached for the process lifetime", () => {
  // Reads the source rather than trying to inject a failure: the guard is the
  // .catch that clears internalKeyPromise, and its absence is invisible until
  // something breaks in production.
  const src = fs.readFileSync(
    path.join(REPO, "src/lib/db/repos/apiKeysRepo.js"), "utf8");
  const start = src.indexOf("export async function getOrCreateInternalApiKey");
  const body = src.slice(start, start + 1400);
  assert.ok(
    body.includes("internalKeyPromise = null"),
    "a rejected promise would stay cached forever — no reset found");
  assert.ok(
    body.includes(".catch("),
    "the async body has no .catch to reset the cache");
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);
fs.rmSync(dir, { recursive: true, force: true });