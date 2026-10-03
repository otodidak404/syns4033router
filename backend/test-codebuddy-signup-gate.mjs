// /api/automation/codebuddy — starting a signup job.
//
// The per-account preflight inside the job already turned a missing interpreter into a
// clear message, but only after the caller had been handed a job id: the dashboard showed
// a running job that then failed once per account with the same reason. All three start
// points launched with .catch(console.error), so a failure to even begin also vanished
// into the console.
//
// The runtime is now checked once, per batch, before the job row is created.

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROUTE = path.join(HERE, "./src/routes/automation/codebuddy/route.ts");
const src = fs.readFileSync(ROUTE, "utf8");
const DOCKERFILE = fs.readFileSync(path.join(HERE, "../Dockerfile"), "utf8");

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

// The mapping, transcribed from signupScriptFor in the route.
function scriptFor(provider) {
  switch (provider) {
    case "leonardo": return "leonardo_signup.py";
    case "weavy": return "weavy_signup.py";
    case "kimi":
    case "kimi-coding": return "kimi_signup.py";
    case "qoder": return "qoder_signup.py";
    case "cloudflare": return "cloudflare_signup.py";
    default: return "codebuddy_signup.py";
  }
}

t("every provider maps to a script name, and the two Kimi spellings agree", () => {
  assert.equal(scriptFor("kimi"), scriptFor("kimi-coding"),
    "the gate and the runner disagree about which Kimi this is");
  for (const [p, script] of Object.entries({
    leonardo: "leonardo_signup.py", weavy: "weavy_signup.py",
    qoder: "qoder_signup.py", cloudflare: "cloudflare_signup.py",
    codebuddy: "codebuddy_signup.py", kimi: "kimi_signup.py",
  })) {
    assert.equal(scriptFor(p), script, `${p} maps elsewhere`);
  }
});

t("the route agrees with that mapping", () => {
  const at = src.indexOf("function signupScriptFor");
  assert.ok(at > 0, "there is no single mapping in the route");
  const fn = src.slice(at, src.indexOf("function venvPythonPath"));
  for (const script of ["leonardo_signup.py", "weavy_signup.py", "kimi_signup.py",
                        "qoder_signup.py", "cloudflare_signup.py", "codebuddy_signup.py"]) {
    assert.ok(fn.includes(script), `${script} is not in the route's mapping`);
  }
  assert.match(fn, /case "kimi":\s*\n?\s*case "kimi-coding":/, "the two Kimi spellings are not one case");
});

t("all three start points are gated", () => {
  const starts = [...src.matchAll(/runCodeBuddySignupJob\(jobId, targetIds/g)].map((m) => m.index);
  assert.equal(starts.length, 3, `expected three start points, found ${starts.length}`);
  // Every occurrence, not just the first: map(x => src.indexOf(x)) returns the same index
  // for all three, so two of them were never checked.
  assert.equal((src.match(/No job was started/g) || []).length, starts.length,
    "not every start point refuses before creating the job");
  for (const at of starts) {
    const before = src.slice(Math.max(0, at - 1200), at);
    const guardAt = src.lastIndexOf("missingSignupRuntimeFor(", at);
    // The job row written just before this launch is the one that matters: the check
    // has to run before it, or a refused request still leaves a job behind.
    const createAt = src.lastIndexOf("createCodeBuddyJob", at);
    assert.ok(createAt > 0 && guardAt > 0, "a start point has neither a guard nor a job row");
    assert.ok(guardAt < createAt,
      "the job row is created before the check runs, so a refusal still leaves a job behind");
    assert.ok(/res\.status\(501\)/.test(src.slice(guardAt, createAt)),
      "the refusal is not a 501, or it sits outside the guarded span");
  }
  assert.equal((src.match(/const refusal = missingSignupRuntimeFor\(/g) || []).length, starts.length,
    "a guard is computed but not used, or a start point has two");
});

t("the refusal names what is missing", () => {
  // indexOf finds the definition, which is hundreds of characters away from the message.
  const at = src.indexOf("= missingSignupRuntimeFor(batchProviders);");
  assert.ok(at > 0, "no call site to read the refusal from");
  const seg = src.slice(at, at + 420);
  assert.ok(/Missing:/.test(seg), "the message does not list what is absent");
  assert.ok(/refusal\.join|blocked\.join/.test(seg), "the message is not built from what was checked");
});

t("the check covers the python and the scripts of every provider in the batch", () => {
  const at = src.indexOf("function missingSignupRuntimeFor");
  const fn = src.slice(at, src.indexOf("\nfunction ", at + 10));
  assert.ok(/fs\.existsSync\(python\)/.test(fn), "the interpreter is not checked");
  assert.ok(/fs\.existsSync\(full\)/.test(fn), "the scripts are not checked");
  assert.ok(/new Set\(/.test(fn), "a repeated provider is checked repeatedly");
  assert.ok(/signupScriptFor/.test(fn), "the batch check does not use the shared mapping");
});

t("the per-account check inside the job still exists", () => {
  // Belt and braces: the batch check answers the request, the per-account one still
  // protects a job whose runtime disappears between start and run.
  // Matched inside a function body, not at the definition, or the definition itself
  // satisfies the assertion and removing the call stays green.
  const callAt = src.indexOf("const missingRuntime = missingSignupRuntime(venvPython, scriptPath);");
  assert.ok(callAt > 0, "the per-account call is gone; only the definition is left");
  assert.ok(/if \(missingRuntime\.length\)/.test(src.slice(callAt, callAt + 300)),
    "the per-account result is not checked");
  assert.ok(/const scriptPath = signupScriptPath\(account\.provider/.test(src),
    "the runner rebuilt the script path inline, so the gate and the runner can disagree");
  assert.ok(/const venvPython = venvPythonPath\(\);/.test(src),
    "the runner computes its own interpreter path again");
  assert.ok(/markCodeBuddyError\(account\.id, msg\)/.test(src),
    "an account can no longer be marked failed with the reason");
});

t("what the trailing catch covers, stated plainly", () => {
  // These three .catch calls stay. The batch gate in front of them has just checked the
  // interpreter and every script in the batch, and the runner has its own try, so this
  // only sees a failure of the runner's own catch or finally -- rare, but not nothing.
  // The protection against the ordinary case is the gate and the per-account check,
  // both asserted above. An earlier version of this assertion claimed the console
  // swallow was gone while it was still there and passed because of it.
  const catchers = src.match(/runCodeBuddySignupJob\([^)]*\)\.catch\(/g) || [];
  assert.equal(catchers.length, 3, "a start point changed how it launches the runner");
  const at = src.indexOf("async function runCodeBuddySignupJob");
  const fn = src.slice(at);
  assert.ok(/try \{[\s\S]{0,200}updateCodeBuddyJobStatus\(jobId, "running"\)/.test(fn),
    "the runner no longer wraps its body, so the trailing catch is the only net at all");
});

t("the image really lacks an interpreter, so this gate is not dead code", () => {
  const runner = DOCKERFILE.split(/FROM node:22-alpine AS runner/)[1] || "";
  assert.ok(!/apk add[^\n]*python/i.test(runner),
    "the runner now installs Python, so the whole gate needs redoing");
  for (const script of ["leonardo_signup.py", "weavy_signup.py", "kimi_signup.py", "qoder_signup.py"]) {
    const p = path.join(HERE, `./src/automation/${script}`);
    assert.ok(!fs.existsSync(p), `${script} is now in the tree, so the gate needs redoing`);
  }
});

drain();
