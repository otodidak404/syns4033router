// tokenRefresh.js refreshes Leonardo and Weavy by shelling out to Python.
//
// This deployment provides neither: node:22-alpine has no interpreter and no
// virtualenv, and weavy_refresh.py is not in the repository at all. Both refreshes
// reached execFile and died with a bare ENOENT, which says nothing about the cause --
// an operator reading the logs cannot tell a missing runtime from a broken refresh.
//
// missingPythonRuntime is evaluated out of the module and run against real paths.

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = fs.readFileSync(path.join(HERE, "open-sse/services/tokenRefresh.js"), "utf8");

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

// ── the runtime really is absent ─────────────────────────────────────────────

t("the repository has no weavy_refresh.py and no venv", () => {
  assert.ok(!fs.existsSync(path.join(HERE, "src/automation/weavy_refresh.py")),
    "weavy_refresh.py now exists; the preflight and this assertion need revisiting together");
  assert.ok(!fs.existsSync(path.join(HERE, ".venv")),
    "a .venv appeared here; the alpine image still has no Python");
});

// ── the helper, run ──────────────────────────────────────────────────────────

function loadHelper() {
  // Line based: brace matching starts at the destructuring default in the signature
  // and stops immediately. The declaration ends at the first "}" in column 0.
  const at = SRC.indexOf("function missingPythonRuntime(");
  assert.ok(at > 0, "missingPythonRuntime is not defined");
  const lines = SRC.split("\n");
  const start = SRC.slice(0, at).split("\n").length - 1;
  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === "}") { end = i; break; }
  }
  assert.ok(end > start, "could not find the end of missingPythonRuntime");
  const body = lines.slice(start, end + 1).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  return new Function("fs", `${body}\nreturn missingPythonRuntime;`)(fs);
}

t("it names every missing piece", () => {
  const missing = loadHelper();
  const here = path.resolve(HERE);
  const out = missing(path.join(here, ".venv/bin/python"),
                      path.join(here, "src/automation/weavy_refresh.py"));
  assert.equal(out.length, 2, `expected both, got ${JSON.stringify(out)}`);
  assert.ok(out.some((x) => x.endsWith("weavy_refresh.py")));
  assert.ok(out.some((x) => x.endsWith("python")));
});

t("an inline-python caller passes no script", () => {
  const missing = loadHelper();
  const here = path.resolve(HERE);
  assert.deepEqual(missing(path.join(here, ".venv/bin/python"), null),
    [path.join(here, ".venv/bin/python")]);
});

t("a runtime that is present reports nothing missing", () => {
  const missing = loadHelper();
  assert.deepEqual(
    missing(path.join(HERE, "test-token-refresh-runtime.mjs"),
            path.join(HERE, "open-sse/services/tokenRefresh.js")),
    [], "the helper reports pieces that exist");
});

// ── both callers gate on it, before execFile ─────────────────────────────────

for (const [label, needle] of [
  ["Leonardo refresh", "Leonardo token refresh needs Python at"],
  ["Weavy refresh", "Weavy token refresh needs Python and"],
]) {
  t(`${label} checks the runtime before spawning`, () => {
    const msgAt = SRC.indexOf(needle);
    assert.ok(msgAt > 0, `${label} has no preflight message`);
    const gateAt = SRC.lastIndexOf("missingPythonRuntime(", msgAt);
    assert.ok(gateAt > 0, `${label} logs the reason but never checks`);
    const after = SRC.slice(gateAt, gateAt + 400);
    assert.ok(/if \(missingRuntime\.length\)/.test(after),
      `${label}: the result of the check is not branched on`);
    assert.ok(/return null;/.test(after), `${label}: it does not give up`);
    // and the spawn has to come after
    const execAt = SRC.indexOf("execFileAsync(", gateAt);
    assert.ok(execAt > msgAt, `${label}: it spawns before giving up`);
  });
}

t("the check precedes the spawn for both", () => {
  const leoGate = SRC.indexOf("needs Python at");
  const leoExec = SRC.indexOf("execFileAsync(", leoGate);
  assert.ok(leoGate > 0 && leoExec > leoGate, "the Leonardo spawn comes before its guard");
  const weaGate = SRC.indexOf("Weavy token refresh needs");
  const weaExec = SRC.indexOf("execFileAsync(", weaGate);
  assert.ok(weaGate > 0 && weaExec > weaGate, "the Weavy spawn comes before its guard");
});

drain();