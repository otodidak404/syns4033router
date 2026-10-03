// /dashboard/automation — the sixteen writers on the page.
//
// Every one of them did `const data = await res.json()` and only then looked at
// `res.ok`. A platform 502, a login redirect or a rate-limit page is HTML, so the
// parse threw *before* the status check: the error branch never ran, the catch wrote
// to the console, and the operator was told nothing at all. This is the same shape as
// the defects fixed on the web page, on the proxy-pools page and in handleSave.
//
// readJson is executed here against real Responses -- a JSON body, an HTML body, an
// empty body and a truncated one -- rather than being described.

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PAGE = path.join(HERE, "../frontend/src/pages/automation/page.jsx");
const src = fs.readFileSync(PAGE, "utf8");

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });
async function drain() {
  for (const { name, fn } of queue) {
    try { await fn(); pass++; console.log(`  ok   ${name}`); }
    catch (e) { process.exitCode = 1; console.log(`  FAIL ${name}\n       ${e?.message || e}`); }
  }
  console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);
}

// ── readJson, taken out of the page and run ──────────────────────────────────

function loadReadJson() {
  const at = src.indexOf("async function readJson(");
  assert.ok(at > 0, "readJson is not defined on the page");
  const lines = src.split("\n");
  const start = src.slice(0, at).split("\n").length - 1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === "}") {
      const body = lines.slice(start, i + 1).join("\n")
        .replace(/\/\*\*[\s\S]*?\*\//g, "")   // strip the explanatory comment
        .replace(/\/\/.*$/gm, "");
      return new Function("Response", `${body}\nreturn readJson;`)(Response);
    }
  }
  throw new Error("could not find the end of readJson");
}

const readJson = loadReadJson();

t("a JSON body is returned as it is", async () => {
  const r = new Response(JSON.stringify({ ok: true, job_id: 7 }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
  assert.deepEqual(await readJson(r), { ok: true, job_id: 7 });
});

t("an HTML error page becomes a message, not a thrown SyntaxError", async () => {
  // The exact case that used to reach console.error instead of the error branch.
  const r = new Response("<!DOCTYPE html><html><body>502 Bad Gateway</body></html>", {
    status: 502, headers: { "Content-Type": "text/html" },
  });
  const out = await readJson(r);
  assert.ok(out && typeof out === "object", "readJson did not return an object");
  assert.match(out.error, /502/, `the status is not in the message: ${JSON.stringify(out)}`);
});

t("an empty body is handled", async () => {
  const out = await readJson(new Response("", { status: 200 }));
  assert.ok(out && typeof out.error === "string", `empty body: ${JSON.stringify(out)}`);
});

t("a truncated body is handled", async () => {
  const out = await readJson(new Response('{"ok": tru', { status: 200 }));
  assert.ok(out && typeof out.error === "string", `truncated body: ${JSON.stringify(out)}`);
});

t("a JSON error body still surfaces the server's own message", async () => {
  const r = new Response(JSON.stringify({ error: "Account not found" }), { status: 404 });
  assert.equal((await readJson(r)).error, "Account not found");
});

// ── every writer goes through it ─────────────────────────────────────────────

t("no writer parses a response as JSON without a guard", () => {
  const bare = src.match(/(?<![\w.])await\s+res\.json\(\)/g) || [];
  assert.deepEqual(bare, [], `${bare.length} unguarded res.json() calls remain`);
  const guarded = src.match(/await\s+readJson\(/g) || [];
  assert.ok(guarded.length >= 15,
    `only ${guarded.length} writers use readJson; there were sixteen`);
});

t("a failed action is not reported to the console and nowhere else", () => {
  // The page mixes alert(), setAddGoogleStatus and setTestResult. Those are visible
  // even if they are not the pattern this router settled on. What is not acceptable
  // is a guard that neither logs visibly nor surfaces anything.
  // Only the catch blocks that guard a fetch. The page also parses localStorage in a
  // try/catch, and shouting at the operator about a corrupted local entry would be
  // wrong -- that path is allowed to stay quiet.
  const consoleOnly = (src.match(/catch\s*\([^)]*\)\s*\{\s*console\.(?:error|log)\([^)]*\);?\s*\}/g) || [])
    .filter((block) => {
      const i = src.indexOf(block);
      const before = src.slice(Math.max(0, i - 700), i);
      return /await\s+fetch\(/.test(before);
    });
  assert.deepEqual(consoleOnly, [],
    `${consoleOnly.length} fetch guards still report to the console only:\n${consoleOnly.join("\n")}`);

  const guards = [...src.matchAll(/catch\s*\([^)]*\)\s*\{[\s\S]{0,200}?\n\s*\}/g)]
    .filter((m) => /await\s+fetch\(/.test(src.slice(Math.max(0, m.index - 700), m.index)))
    .map((m) => m[0]);
  assert.ok(guards.length > 0, "no fetch guards were found at all");
  const VISIBLE = /alert\(|setAddGoogleStatus\(|setTestResult\(|setTestOutput\(|setActionError\(|notify\./;
  const silent = guards.filter((g) => !VISIBLE.test(g));
  assert.deepEqual(silent, [],
    `${silent.length} fetch guards catch without telling the operator:\n${silent.join("\n---\n")}`);
});

await drain();