// /dashboard/system-prompt — can the operator actually reach every preset?
//
// PROMPT_PRESETS filters on `p.prompt`, which drops the wildcard preset because it
// carries `prompt: null` and only moves the target. The page rendered PROMPT_PRESETS, so
// the "All models (*)" button was never built. applyPreset implements a wildcard branch
// for it and test-sysprompt-presets.mjs asserts that branch works -- so the feature had
// logic, tests and a documented note, and no way to click it.
//
// The same gap had a second edge: the model field's placeholder read "provider/model",
// so nothing on the form told the operator that "*" was a valid target at all.

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PRESETS_FILE = path.join(HERE, "../frontend/src/pages/system-prompt/presets.js");
const PAGE = path.join(HERE, "../frontend/src/pages/system-prompt/page.jsx");

const { PRESETS, PROMPT_PRESETS, GLOBAL_TARGET, applyPreset, getPreset } =
  await import(PRESETS_FILE);
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

t("every preset in the file is reachable from the page", () => {
  const rendered = page.includes("{PRESETS.map(");
  assert.ok(rendered,
    "the page still renders the filtered list, so any preset without a prompt is unreachable");
  const ids = PRESETS.map((p) => p.id);
  for (const id of ids) {
    assert.ok(getPreset(id), `preset ${id} cannot be looked up`);
  }
  // and the filter is still exported for callers that genuinely want only prompts
  assert.ok(PROMPT_PRESETS.every((p) => p.prompt), "PROMPT_PRESETS no longer holds only prompts");
});

t("the wildcard preset does what its note says", () => {
  const wildcard = getPreset("wildcard");
  assert.ok(wildcard, "the wildcard preset is gone");
  assert.equal(wildcard.target, GLOBAL_TARGET);
  assert.match(wildcard.note, /wildcard/i, "the note no longer says what it is for");

  const out = applyPreset({ model: "old/model", prompt: "MY OWN TEXT" }, "wildcard");
  assert.equal(out.model, GLOBAL_TARGET, "it did not move the target");
  assert.equal(out.prompt, "MY OWN TEXT", "it overwrote the operator's prompt");
});

t("a prompt preset does not touch the model", () => {
  const out = applyPreset({ model: "keep/me", prompt: "" }, "terse");
  assert.equal(out.model, "keep/me", "choosing a prompt preset moved the model");
  assert.match(out.prompt, /Answer in as few words/, "the prompt was not filled");
});

t("the wildcard is documented where the target is typed", () => {
  assert.ok(/placeholder="[^"]*\*/.test(page),
    "the model field still says only \"provider/model\", so nothing tells the operator * is valid");
  // and it must survive a future reword, so it has to name the character
  assert.ok(/or \* for every model/.test(page), "the hint does not name the wildcard character");
});

t("applyPreset is not called with an id that no longer exists", () => {
  const fill = page.slice(page.indexOf("const fill ="), page.indexOf("const fill =") + 400);
  assert.ok(/applyPreset\(/.test(fill), "the page no longer calls applyPreset");
  // An unknown id must leave the form untouched rather than blanking it.
  const same = applyPreset({ model: "m", prompt: "p" }, "no-such-preset");
  assert.deepEqual(same, { model: "m", prompt: "p" });
});

t("the page does not render the filtered list under any other name", () => {
  assert.ok(!/PROMPT_PRESETS\.map/.test(page),
    "a second render of the filtered list would still hide the wildcard");
  assert.ok(!/import \{[^}]*PROMPT_PRESETS[^}]*\} from "\.\/presets"/.test(page),
    "the page imports the filtered list again");
});

drain();