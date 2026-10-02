// /dashboard/combos had two defects, both proven against the live deployment.
//
// The list a combo walks is read with .length and spread into a new array. A
// string satisfies both, so POST /api/combos with
//
//   {"name":"x","models":"oc/space-bunny-free"}
//
// stored the string, and calling that combo tried "o", "c" and "/" as model
// names — the call came back "No active credentials for provider: openai",
// naming a provider the operator never configured. The 201 was the giveaway:
// the route validated the name and never looked at models.
//
// The round-robin switch set its state after awaiting a fetch whose response it
// never checked, so a rejected save left the toggle showing a strategy the
// server did not store.
import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), "utf8");

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const ROUTES = [
  "src/routes/combos/route.ts",
  "src/routes/combos/[id]/route.ts",
];
const PAGE = "../frontend/src/pages/combos/page.jsx";

// ── the backend ─────────────────────────────────────────────────────────────
t("both combo routes reject a non-array models", () => {
  for (const rel of ROUTES) {
    const src = read(rel);
    assert.ok(/function validateModels\(models\)/.test(src), `${rel}: no validateModels`);
    assert.ok(/!Array\.isArray\(models\)/.test(src),
      `${rel}: a string would pass — it has a length and spreads into characters`);
    assert.ok(/modelsCheck\.ok/.test(src), `${rel}: the validator is defined but never called`);
  }
});

t("non-string entries inside the array are refused too", () => {
  for (const rel of ROUTES) {
    const src = read(rel);
    const i = src.indexOf("function validateModels");
    const fn = src.slice(i, src.indexOf("\n}", i));
    assert.ok(/typeof m !== "string"/.test(fn), `${rel}: numeric or null entries pass`);
    assert.ok(/!m\.trim\(\)/.test(fn), `${rel}: an empty string passes`);
  }
});

t("an absent models field is allowed, an explicit one is checked", () => {
  const src = read(ROUTES[0]);
  const i = src.indexOf("function validateModels");
  const fn = src.slice(i, src.indexOf("\n}", i));
  assert.ok(/models === undefined \|\| models === null/.test(fn),
    "a create with no models at all would now be rejected");
  assert.ok(/models \|\| \[\]/.test(src), "the create path no longer defaults to an empty list");
});

// The rule itself, executed rather than only matched.
t("it accepts a real list and refuses the shapes that caused the bug", () => {
  const src = read(ROUTES[0]);
  const i = src.indexOf("function validateModels");
  const fnSrc = src.slice(i, src.indexOf("\n}\n", i) + 2);
  const validateModels = new Function(`${fnSrc}; return validateModels;`)();

  assert.equal(validateModels(["oc/space-bunny-free", "gemini/x"]).ok, true);
  assert.equal(validateModels([]).ok, true);
  assert.equal(validateModels(undefined).ok, true);
  assert.equal(validateModels(null).ok, true);

  assert.equal(validateModels("oc/space-bunny-free").ok, false, "the original bug shape");
  assert.equal(validateModels({ 0: "a", length: 1 }).ok, false, "array-like with a length");
  assert.equal(validateModels([123, null, { x: 1 }]).ok, false);
  assert.equal(validateModels(["ok", ""]).ok, false);
  assert.equal(validateModels(["ok", "   "]).ok, false);
});

t("name validation is still in place alongside it", () => {
  for (const rel of ROUTES) {
    const src = read(rel);
    assert.ok(/VALID_NAME_REGEX/.test(src), `${rel}: name validation was lost`);
  }
});

// ── the frontend ─────────────────────────────────────────────────────────────
t("the round-robin switch waits for the save before moving", () => {
  const src = read(PAGE);
  const i = src.indexOf("const handleToggleRoundRobin");
  const fn = src.slice(i, src.indexOf("\n  };", i));
  const setAt = fn.indexOf("setComboStrategies");
  const checkAt = fn.indexOf("if (!res.ok)");
  assert.ok(checkAt > -1, "the response status is never inspected");
  assert.ok(setAt > checkAt, "state moves before the save is known to have worked");
});

// ── what the page is actually for ────────────────────────────────────────────
t("the rotation the page writes is the one the runtime reads", () => {
  const page = read(PAGE);
  assert.ok(/comboStrategies/.test(page), "the page writes no comboStrategies");
  assert.ok(/fallbackStrategy: "round-robin"/.test(page),
    "the page writes a strategy value the runtime never compares against");

  // The runtime reads it in four handlers, so the toggle is only meaningful if
  // they all agree on the shape.
  const HANDLERS = ["chat", "fetch", "search", "tts", "imageGeneration"];
  for (const h of HANDLERS) {
    const src = read(`src/sse/handlers/${h}.js`);
    assert.ok(/comboStrategies/.test(src), `${h}.js never reads comboStrategies`);
    assert.ok(/\?\.fallbackStrategy/.test(src),
      `${h}.js reads the map but not the strategy field the page writes`);
  }
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);