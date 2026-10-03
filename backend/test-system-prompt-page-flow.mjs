// /dashboard/system-prompt
//
// The injection path itself is sound and already covered: livePrompt.js resolves the
// entry for the model a request named, chatCore.js injects it, and the playground marks
// its own request with markInternal() on the Request object rather than a header, so
// "skip the library entry" cannot be forged from outside.
//
// What was wrong is the page. Three of its writers reported nothing when they failed:
//
//   * the three-way load swallowed every failure into console.log, leaving the page
//     showing no prompts, no providers and no aliases -- which reads as an empty
//     install rather than a failed request;
//   * the model catalogue for the test panel became [] with nothing said;
//   * Delete had no else branch, so a refused delete left the prompt on screen and
//     still live, and a network error threw out of the confirm callback unhandled.

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PAGE = path.join(HERE, "../frontend/src/pages/system-prompt/page.jsx");
const src = fs.readFileSync(PAGE, "utf8");

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

function body(name, startFrom = 0) {
  const at = src.indexOf(`const ${name} = `, startFrom);
  assert.ok(at > 0, `${name} is not defined`);
  const arrow = src.indexOf("=>", at);
  const open = src.indexOf("{", arrow);
  let depth = 0;
  for (let k = open; k < src.length; k += 1) {
    if (src[k] === "{") depth += 1;
    else if (src[k] === "}") { depth -= 1; if (depth === 0) return src.slice(at, k + 1); }
  }
  throw new Error(`no end for ${name}`);
}

// The load, transcribed: three requests, each answering independently.
function loadOutcome({ sp, prov, alias }) {
  const failed = [
    sp.ok ? null : "prompts",
    prov.ok ? null : "providers",
    alias.ok ? null : "aliases",
  ].filter(Boolean);
  return { entries: sp.ok ? 1 : 0, providers: prov.ok ? 1 : 0, error: failed.length ? `Could not load ${failed.join(", ")}` : null };
}

t("a failed load names the part that failed", () => {
  const o = loadOutcome({ sp: { ok: false }, prov: { ok: true }, alias: { ok: true } });
  assert.equal(o.error, "Could not load prompts");
  assert.equal(o.entries, 0, "the entries that did load are kept");
  assert.equal(o.providers, 1);
  assert.equal(loadOutcome({ sp: { ok: true }, prov: { ok: true }, alias: { ok: true } }).error, null);
  assert.match(loadOutcome({ sp: { ok: false }, prov: { ok: false }, alias: { ok: true } }).error,
    /prompts, providers/);
});

t("the page computes that message", () => {
  const fd = body("fetchData");
  assert.ok(!/console\.log\("Error fetching system prompts/.test(fd),
    "the load still only logs");
  assert.ok(/spRes\.ok \? null : "prompts"/.test(fd), "prompts is not named");
  assert.ok(/provRes\.ok \? null : "providers"/.test(fd), "providers is not named");
  assert.ok(/aliasRes\.ok \? null : "aliases"/.test(fd), "aliases is not named");
  // Set inside the try, on the success path: the catch also calls setLoadError, so
  // asserting only that the name appears is satisfied by the catch alone -- which is
  // exactly what happened when this check first went green against a dead page.
  const catchAt = fd.indexOf("} catch");
  const okAt = fd.indexOf("} catch");
  assert.ok(catchAt > 0, "the load has no catch");
  assert.ok(/failed\.length/.test(fd.slice(0, catchAt)),
    "the message is only computed in the catch, so a refused response is never reported");
  assert.ok(/Could not load/.test(fd.slice(0, catchAt)),
    "the per-part message is not built on the success path");
});

t("a load that throws outright is reported", () => {
  const fd = body("fetchData");
  assert.ok(/Could not reach the server/.test(fd), "an unreachable server says nothing");
});

t("the model catalogue failure is reported", () => {
  const at = src.indexOf('fetch("/api/models")');
  assert.ok(at > 0, "the catalogue load is gone");
  const seg = src.slice(at, at + 420);
  assert.ok(!/\.catch\(\(\) => setCatalog\(\[\]\)\)/.test(seg),
    "a failed catalogue load still becomes an empty list with nothing said");
  assert.ok(/Could not load the model list/.test(seg), "the failure is not reported");
  assert.ok(/if \(!r\.ok\) throw new Error/.test(seg), "a non-2xx is treated as an empty list");
});

t("a refused delete says the prompt is still live", () => {
  const at = src.indexOf("const deleteEntry = ");
  const seg = src.slice(at, at + 1400);
  assert.ok(/if \(!res\.ok\)/.test(seg), "the delete result is only checked for success");
  assert.ok(/still live/.test(seg), "the message does not say the prompt survives");
  assert.ok(/catch \(error\)/.test(seg), "a network error throws out of the confirm callback");
  assert.ok(/Could not reach the server/.test(seg), "an unreachable server says nothing");
  // and the local list must still only be pruned on success
  const okAt = seg.indexOf("if (res.ok)");
  assert.equal(okAt, -1, "the success branch is still an if rather than the fallthrough");
});

t("the failure is rendered", () => {
  assert.ok(/const \[loadError, setLoadError\] = useState\(null\)/.test(src), "no error state");
  assert.ok(/\{loadError && \(/.test(src), "the banner is dead markup");
  assert.ok(/role="alert"/.test(src), "the error is not announced");
  assert.ok(/aria-label="Retry"/.test(src), "there is no way to retry from the page");
});

t("the writers that were already correct stay that way", () => {
  // patchEntry is not optimistic: the list moves only after the server agreed, so a
  // refused toggle leaves the switch where it was rather than lying.
  const pe = body("patchEntry");
  assert.ok(/if \(!res\.ok\)/.test(pe), "patchEntry no longer checks its status");
  const mutate = pe.indexOf("setEntries(");
  assert.ok(mutate > pe.indexOf("if (!res.ok)"),
    "the entry is updated before the response is checked, which would need a rollback");
  const ce = body("createEntry");
  assert.ok(/if \(!res\.ok\)/.test(ce), "createEntry no longer checks its status");
});

t("the load banner sits inside the page's root element", () => {
  // Inserting between `return (` and the root div produced two siblings and a syntax
  // error three times in this repo, so it is checked rather than trusted.
  const ret = src.indexOf("  return (\n    <div className=\"relative flex");
  assert.ok(ret > 0, "the page root is not where it was");
  const banner = src.indexOf("{loadError && (");
  const root = src.indexOf("<div className=\"relative flex");
  assert.ok(banner > root, "the banner is outside the page root, which is not valid JSX");
});

drain();