// POST /api/automation/codebuddy drives a Python script that drives a browser.
//
// This deployment provides neither: the image is node:22-alpine with no
// interpreter and no virtualenv, and four of the five signup scripts are not in the
// repository at all. spawn() then failed with a bare ENOENT for every account, which
// records the failure but says nothing about why, so an operator reading the job log
// has no way to tell a missing runtime from a broken signup.
//
// The failure path itself was already correct -- child.on("error") marks the account
// and the job failed rather than crashing the process -- and that is asserted here so
// it stays that way.

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROUTES = path.join(HERE, "src/routes/automation/codebuddy");

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

const read = (f) => fs.readFileSync(path.join(ROUTES, f), "utf8");

// ── the runtime really is absent ─────────────────────────────────────────────

const AUTOMATION = path.join(HERE, "src/automation");
const present = fs.readdirSync(AUTOMATION).sort();
t("the repository says which signup scripts exist", () => {
  for (const script of ["leonardo_signup.py", "weavy_signup.py",
                        "kimi_signup.py", "qoder_signup.py", "codebuddy_signup.py"]) {
    assert.ok(!present.includes(script),
      `${script} now exists -- this deployment still cannot run it, so the ` +
      "preflight message and this assertion need revisiting together");
  }
  assert.ok(present.includes("cloudflare_signup.py"),
    "cloudflare_signup.py disappeared; it is the one script that does exist");
});

t("no virtualenv is present", () => {
  assert.ok(!fs.existsSync(path.join(HERE, ".venv")),
    "a .venv appeared here; the alpine image still has no Python");
});

// ── both routes preflight before spawning ────────────────────────────────────

for (const file of ["route.ts", "[id]/route.ts"]) {
  const src = read(file);

  t(`${file} checks the runtime before it spawns`, () => {
    const venvAt = src.indexOf('path.resolve(process.cwd(), ".venv/bin/python")');
    // The call site, not the helper's declaration -- both mention the same two names.
    const checkAt = src.indexOf("missingSignupRuntime(venvPython, scriptPath);", venvAt);
    const spawnAt = src.search(/\bspawn\(venvPython/);
    assert.ok(venvAt > 0, `${file} does not resolve the interpreter`);
    assert.ok(checkAt > 0, `${file} has no preflight`);
    assert.ok(spawnAt > 0, `${file} never spawns`);
    assert.ok(venvAt < checkAt && checkAt < spawnAt,
      `${file}: the preflight must sit between resolving the interpreter and spawning ` +
      `(venv ${venvAt}, check ${checkAt}, spawn ${spawnAt})`);
  });

  t(`${file} names what is missing instead of leaving a bare ENOENT`, () => {
    const seg = src.slice(src.indexOf("const missingRuntime"), src.indexOf("const missingRuntime") + 620);
    assert.ok(seg.includes("missingRuntime.length"), `${file} does not branch on the check`);
    assert.ok(seg.includes("markCodeBuddyError"), `${file} does not record the failure`);
    assert.ok(seg.includes('status: "failed"'), `${file} does not fail the job`);
    assert.ok(/deployment does not/.test(seg), `${file} does not say why`);
    assert.ok(seg.includes("scriptPath"), `${file} does not name the script`);
  });

  t(`${file} still handles a spawn error rather than crashing`, () => {
    assert.ok(/child\.on\(\s*["']error["']/.test(src),
      `${file} lost its spawn error listener`);
    assert.ok(/status:\s*["']failed["']/.test(src),
      `${file} no longer marks the job failed on a spawn error`);
  });
}

// ── the message the operator will actually read ──────────────────────────────

t("the preflight reports every missing piece, not just the first", () => {
  const src = read("route.ts");
  const from = src.indexOf("function missingSignupRuntime");
  const fn = src.slice(from, from + 700);
  const end = fn.indexOf("\n}");
  const body = fn.slice(0, end + 2);
  assert.ok(body.includes("fs.existsSync"), `the helper does not check existence:\n${body}`);
  const missing = new Function("fs", `${body}\nreturn missingSignupRuntime;`)(fs);
  const here = path.resolve(HERE);
  const out = missing(path.join(here, ".venv/bin/python"),
                      path.join(here, "src/automation/leonardo_signup.py"));
  assert.equal(out.length, 2, `expected both missing, got ${JSON.stringify(out)}`);
  assert.ok(out.some((x) => x.endsWith("leonardo_signup.py")));
  assert.ok(out.some((x) => x.endsWith("python")));

  // A runtime that is present reports nothing missing.
  assert.deepEqual(
    missing(path.join(HERE, "test-automation-signup-runtime.mjs"),
            path.join(AUTOMATION, "cloudflare_signup.py")),
    [], "the preflight reports pieces that exist");
});

drain();