// /dashboard/callback — the OAuth landing route.
//
// The status logic was `if (!(code || error)) { manual } else { success }`. An error
// therefore fell through to success: press Allow at the provider, refuse there, and
// this page reported "Authorization Successful!" with a green tick.
//
// The authorization code was also written to localStorage on every load of this route
// and never removed, leaving a credential sitting on the origin until the user cleared
// it by hand.

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PAGE = path.join(HERE, "../frontend/src/pages/callback/page.jsx");
const src = fs.readFileSync(PAGE, "utf8");

// Scanning raw text matches prose. The first version of the guard below failed because
// this file's own comment quotes the old expression verbatim, so comments are stripped
// before anything is looked for in it.
function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const jsx = codeOnly(src);

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

// The decision the page makes, transcribed. Running it is the point: the previous
// version of this table said an error was a success.
function decide({ code, error }) {
  if (error) return "error";
  if (!code) return "manual";
  return "success";
}

t("a completed authorization is a success", () => {
  assert.equal(decide({ code: "abc", error: null }), "success");
});

t("a refused authorization is not a success", () => {
  assert.equal(decide({ code: null, error: "access_denied" }), "error",
    "a denial reached the success branch, which is the bug");
  assert.notEqual(decide({ code: null, error: "access_denied" }), "success");
});

t("an error wins even if a code is somehow present", () => {
  assert.equal(decide({ code: "abc", error: "server_error" }), "error",
    "an error must not be overridden by a code");
});

t("neither parameter asks the operator to copy the URL", () => {
  assert.equal(decide({ code: null, error: null }), "manual");
});

t("the page checks the error before the code", () => {
  const err = jsx.indexOf("if (error) {");
  const code = jsx.indexOf("if (!code) {");
  const done = jsx.indexOf('setStatus("success")');
  assert.ok(err > 0 && code > 0 && done > 0, "one of the three branches is gone");
  assert.ok(err < code, "the error is checked after the code");
  assert.ok(code < done, "success is reachable before the code is required");
  assert.ok(!/if \(!\(code \|\| error\)\)/.test(jsx),
    "the old combined guard is still in place");
});

t("the error is rendered", () => {
  assert.ok(/status === "error"/.test(jsx), "no error panel");
  assert.ok(/Authorization Failed/.test(jsx), "the error panel does not name the failure");
  assert.ok(/errorDescription \|\| error/.test(jsx),
    "the panel does not show what the provider said");
});

t("the authorization code is not stored when none arrived", () => {
  const at = jsx.indexOf('localStorage.setItem("oauth_callback"');
  assert.ok(at > 0, "the code is no longer stored at all, so this cannot be checked");
  // walk back for the guard
  const before = jsx.slice(Math.max(0, at - 400), at);
  const guard = before.lastIndexOf("if (code) {");
  assert.ok(guard > -1, "the store is not gated on a code having arrived");
  const between = jsx.slice(guard, at);
  assert.ok(!/if \(!code\)/.test(between), "the store is gated on something else");
});

drain();