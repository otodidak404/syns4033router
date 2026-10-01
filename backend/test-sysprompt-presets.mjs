// The preset module is plain data plus one pure reducer, so it is tested without
// React: a preset that fills the wrong field, or clobbers a prompt the operator
// already wrote, is the kind of bug that only shows up after it ships.
import assert from "assert";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { PRESETS, PROMPT_PRESETS, GLOBAL_TARGET, getPreset, applyPreset } =
  await import(path.join(HERE, "../frontend/src/pages/system-prompt/presets.js"));

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

t("the wildcard target matches the backend constant", () => {
  assert.strictEqual(GLOBAL_TARGET, "*");
});

t("preset ids are unique", () => {
  const ids = PRESETS.map((p) => p.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

t("every preset has a name and a note", () => {
  for (const p of PRESETS) {
    assert.ok(p.name && p.name.trim(), `${p.id} has no name`);
    assert.ok(p.note && p.note.trim(), `${p.id} has no note`);
  }
});

t("every prompt preset carries a non-empty prompt", () => {
  for (const p of PROMPT_PRESETS) {
    assert.ok(p.prompt && p.prompt.trim().length > 40, `${p.id} prompt too thin`);
  }
});

t("prompt presets are a subset carrying prompts", () => {
  for (const p of PROMPT_PRESETS) assert.ok(p.prompt);
  assert.ok(PROMPT_PRESETS.length >= 4);
  assert.strictEqual(PROMPT_PRESETS.some((p) => p.prompt === null), false);
});

t("filling a prompt preset sets the prompt and leaves the model alone", () => {
  const out = applyPreset({ model: "cc/claude-opus-4-8", prompt: "" }, "unfiltered");
  assert.strictEqual(out.model, "cc/claude-opus-4-8");
  assert.ok(out.prompt.includes("uncensored gateway"));
});

t("the wildcard preset sets the target and leaves the prompt alone", () => {
  const out = applyPreset({ model: "", prompt: "MY OWN TEXT" }, "wildcard");
  assert.strictEqual(out.model, "*");
  assert.strictEqual(out.prompt, "MY OWN TEXT", "the wildcard preset must not overwrite the prompt");
});

t("an unknown preset id returns the form untouched", () => {
  const form = { model: "m", prompt: "p" };
  assert.deepStrictEqual(applyPreset(form, "nope"), form);
  assert.strictEqual(getPreset("nope"), null);
});

t("getPreset finds a preset by id", () => {
  assert.strictEqual(getPreset("terse").id, "terse");
});

t("applyPreset does not mutate the form it is given", () => {
  const form = { model: "m", prompt: "p" };
  applyPreset(form, "unfiltered");
  assert.deepStrictEqual(form, { model: "m", prompt: "p" });
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);