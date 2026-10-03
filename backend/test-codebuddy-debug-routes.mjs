// /api/automation/codebuddy/test-proxy and /debug-vnc.
//
// Two debug routes that could never work in this image and did not say so.
//
// test-proxy runs src/automation/test_proxy.py. The image is node:22-alpine with no
// Python, so getVenvPython falls back to a bare "python3", the spawn dies with ENOENT,
// stdout is empty, and the route answered 200 with "Script error (exit null)".
//
// debug-vnc returned a 1x1 transparent PNG when there was no screenshot. A transparent
// pixel is a valid image, so a poller could not tell "nothing captured" from "blank
// screen" -- and with no X server, nothing is ever captured.

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const A = path.join(HERE, "./src/routes/automation/codebuddy");
const proxy = fs.readFileSync(path.join(A, "test-proxy/route.ts"), "utf8");
const vnc = fs.readFileSync(path.join(A, "debug-vnc/route.ts"), "utf8");

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

// The real image, read from the manifest rather than remembered.
const dockerfile = fs.readFileSync(path.join(HERE, "../Dockerfile"), "utf8");

t("the image this route depends on really has no Python", () => {
  assert.match(dockerfile, /FROM node:22-alpine[\s\S]*AS runner/,
    "the runner stage is no longer node:22-alpine, so this reasoning needs redoing");
  const installs = dockerfile.split(/FROM node:22-alpine AS runner/)[1] || "";
  assert.ok(!/apk add[^\n]*python/i.test(installs),
    "the runner now installs Python, so the preflight below is dead code");
  assert.ok(fs.existsSync(path.join(HERE, "./src/automation/test_proxy.py")),
    "the script the route runs is missing from the tree");
});

t("the proxy test says what is missing instead of blaming the script", () => {
  assert.ok(/function missingProxyTestRuntime/.test(proxy), "no preflight");
  const fn = proxy.slice(proxy.indexOf("function missingProxyTestRuntime"));
  assert.ok(/fs\.existsSync\(SCRIPT\)/.test(fn), "the script's presence is not checked");
  assert.ok(/probe\.error \|\| probe\.status !== 0/.test(fn),
    "a python that will not run is not detected");
  const gate = proxy.indexOf("missingProxyTestRuntime()");
  const spawn = proxy.indexOf("spawnSync(python, [");
  assert.ok(gate > 0 && spawn > 0, "either the preflight or the spawn is gone");
  assert.ok(gate < spawn, "the preflight runs after the spawn it was meant to prevent");
});

t("an unavailable runtime is 501, not a 200 that says ok:false", () => {
  assert.ok(/res\.status\(501\)\.json\(\{ ok: false/.test(proxy),
    "the dependency failure is not a 501");
  assert.ok(/res\.status\(502\)\.json/.test(proxy),
    "a script that produced nothing is still answered 200");
  assert.ok(!/res\.json\(\{\s*ok: false/.test(proxy),
    "a failure is still answered with a bare res.json, which is a 200");
});

t("the screenshot endpoint distinguishes missing from blank", () => {
  assert.ok(/X-Screenshot-Status/.test(vnc), "no status header at all");
  const at = vnc.indexOf('X-Screenshot-Status": "unavailable"');
  assert.ok(at > 0, "the unavailable header is gone");
  const un = vnc.slice(Math.max(0, at - 600), at);
  assert.ok(/transparent pixel/.test(un),
    "the fallback no longer says why it returns a blank image");
  assert.match(vnc, /"X-Screenshot-Status": "ok"/, "a served screenshot is not marked ok");
  // The stale path must be marked too, not just the file-absent path.
  assert.ok(vnc.includes('X-Screenshot-Status": "unavailable"'),
    "the stale or absent screenshot path does not say so");
});

drain();
