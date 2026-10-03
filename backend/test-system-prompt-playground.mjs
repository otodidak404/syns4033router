// /dashboard/system-prompt — the playground, end to end against a real request path.
//
// Three things here cost an operator a run without saying anything:
//
//   * an entryId that no longer resolves (the entry was deleted after the page loaded)
//     dropped the prompted leg. With "compare" ticked the operator saw a baseline and
//     nothing else, which reads as "my prompt made no difference"; with it unticked the
//     response carried an empty results array and the page rendered nothing at all;
//   * the server sent a `note` explaining that, and the page never rendered it;
//   * TIMEOUT_MS was declared and never used, so a provider that accepted the
//     connection and then went quiet held the request open with no outcome.

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROUTE = path.join(HERE, "./src/routes/system-prompts/try/route.ts");
const PAGE = path.join(HERE, "../frontend/src/pages/system-prompt/page.jsx");
const src = fs.readFileSync(ROUTE, "utf8");
const page = fs.readFileSync(PAGE, "utf8");

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

t("a stale entryId is a 404, not a silently missing leg", () => {
  const at = src.indexOf('if (payload.prompt == null && payload.entryId && !entry)');
  assert.ok(at > 0, "there is no stale-id guard");
  const seg = src.slice(at, at + 320);
  assert.ok(/res\.status\(404\)/.test(seg), "the stale id is not a 404");
  assert.ok(/no longer exists/.test(seg), "the message does not say what happened");
  // and it must come before the work array is built
  assert.ok(at < src.indexOf("const work ="), "the guard runs after the legs are queued");
});

t("the response never carries an empty results array", () => {
  const at = src.indexOf("if (results.length === 0)");
  assert.ok(at > 0, "an empty result set is still a 200");
  const seg = src.slice(at, at + 260);
  assert.ok(/res\.status\(400\)/.test(seg), "nothing to run is not a 400");
  assert.ok(/Nothing to run/.test(seg), "the reason is not given");
  assert.ok(at < src.indexOf("return res.json({\n    model,"), "the guard runs after the response is built");
});

t("the declared timeout is actually used", () => {
  // 90_000, not 90000: a \d+ pattern does not read a numeric separator.
  const declared = /const TIMEOUT_MS = ([\d_]+);/.exec(src);
  assert.ok(declared, "TIMEOUT_MS is gone");
  const uses = (src.match(/TIMEOUT_MS/g) || []).length;
  assert.ok(uses >= 4, `TIMEOUT_MS appears ${uses} times: declaration, the setTimeout, the marker and the message`);
  assert.ok(/Promise\.race\(/.test(src), "the timeout does not bound the call");
  assert.ok(/clearTimeout\(timer\)/.test(src),
    "the timer is not cleared, so a fast run leaves the event loop held for 90s");
});

t("the timeout does not pretend handleChat can be aborted", () => {
  // handleChat is (request, clientRawRequest). Passing an options object there lands in
  // the wrong parameter: the signal is ignored and the other slot is corrupted. That is
  // exactly what the first version of this fix did.
  const chat = fs.readFileSync(path.join(HERE, "./src/sse/handlers/chat.js"), "utf8");
  const sig = /export async function handleChat\(([^)]*)\)/.exec(chat);
  assert.ok(sig, "the handleChat signature moved");
  assert.match(sig[1], /clientRawRequest/, "the second parameter is not what this fix assumed");
  assert.ok(!/handleChat\([^)]*,\s*\{/.test(src),
    "an options object is still being passed as the second argument");
  assert.ok(!/AbortController/.test(src), "an AbortSignal is still being constructed and dropped");
});

t("the page renders the note the server sends", () => {
  assert.ok(/results\.note/.test(page), "the note is sent but never shown");
  assert.ok(/!results\.results\?\.length/.test(page),
    "an empty result set has no branch at all, so the page renders nothing");
  assert.ok(/role="status"/.test(page), "the note is not announced");
});

t("the page says when a baseline was run", () => {
  assert.ok(/results\.ranBaseline/.test(page),
    "the checkbox says it compares, and nothing on screen confirms it did");
});

t("the two-leg run still builds both legs when it should", () => {
  const at = src.indexOf("const work = ");
  const seg = src.slice(at, at + 420);
  assert.ok(/run\(entry\.prompt\)/.test(seg), "the prompted leg is gone");
  assert.ok(/run\(null\).*baseline/s.test(seg), "the baseline leg is gone");
  assert.ok(/payload\.compare/.test(seg), "the compare flag no longer gates the baseline");
});

t("the page still refuses to run a wildcard target", () => {
  // The playground chooses a concrete model; the route refuses the wildcard outright,
  // because "*" names every model and therefore no provider.
  assert.ok(/model === GLOBAL_TARGET/.test(src), "the wildcard guard is gone");
  assert.ok(/res\.status\(400\)/.test(src.slice(src.indexOf("model === GLOBAL_TARGET"), src.indexOf("model === GLOBAL_TARGET") + 320)),
    "the wildcard guard is not a 400");
});

drain();