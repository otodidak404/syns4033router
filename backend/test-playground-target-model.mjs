// The playground ran a global entry against the wildcard itself.
//
// A global entry's model is the token "*": it selects every model at injection
// time and names none of them. The playground passed that token straight through
// as the model to test on, so handleChat resolved no provider and returned in
// about three milliseconds — reported as ok:true with empty text, which the
// dashboard renders as "(empty reply)". That is indistinguishable from a prompt
// that broke, and it is what made every global entry look broken.
//
// Both halves are pinned here: the route must refuse the token with a message
// that says why, and the page must not send an entry's own model as the target.
import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const routePath = path.join(HERE, "src/routes/system-prompts/try/route.ts");
const pagePath = path.join(HERE, "../frontend/src/pages/system-prompt/page.jsx");

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const route = fs.readFileSync(routePath, "utf8");
const page = fs.readFileSync(pagePath, "utf8");

// ── the backend refuses the wildcard ─────────────────────────────────────────
t("the route rejects the wildcard with a reason", () => {
  assert.ok(route.includes("=== GLOBAL_TARGET"),
    "the route must refuse the global token before running anything");
  assert.ok(/Pick a concrete model/.test(route),
    "the refusal has to explain that a global entry names no model to test on");
});

t("the refusal is a 400, not a silent empty run", () => {
  const i = route.indexOf("=== GLOBAL_TARGET");
  assert.ok(/status\(400\)/.test(route.slice(i, i + 600)),
    "an unrunnable request is a client error, not a successful empty result");
});

t("the route does not report an empty run as ok:true", () => {
  // runLeg marks ok:true the moment handleChat returns without throwing, so a
  // body with no text must not be able to look like a successful run.
  assert.ok(/return text\s*\?/.test(route),
    "runLeg must branch on whether the run produced text");
  assert.ok(/ok: false/.test(route) && /returned no text/.test(route),
    "an empty extraction must be reported as a failure, with a reason");
});

// ── the frontend no longer inherits the entry's model as the target ─────────
t("the playground computes a runnable model", () => {
  assert.ok(page.includes("runnableModel"),
    "the playground must resolve its own target model");
});

t("the request sends the runnable model, not the entry's", () => {
  assert.ok(/model:\s*runnableModel/.test(page),
    "the request must send the resolved target");
  assert.ok(!/model:\s*selected\.model/.test(page),
    "sending the entry's own model is what sent the wildcard");
});

t("an entry that names no model is detected by the wildcard token", () => {
  assert.ok(/selected\.model !== GLOBAL_TARGET/.test(page),
    "the page must compare against the same token the backend uses");
});

t("Run stays disabled until there is a model to run", () => {
  assert.ok(/disabled=\{busy \|\| !message\.trim\(\) \|\| !selected \|\| !runnableModel\}/.test(page),
    "running with no target model is what produced the instant empty reply");
});

t("a global entry gets a model chosen for it, not one demanded", () => {
  // Asking the operator to type an id made testing a global prompt a chore for
  // no gain. A model must be chosen automatically, and shown, not requested.
  assert.ok(/autoModel/.test(page),
    "the playground must choose a model for a global entry");
  assert.ok(/id\.startsWith\("oc\/"\)/.test(page),
    "the default must prefer a provider that runs with no provider key");
  // The phrase survives as the picker's modal title, so what matters is that no
  // input asks the operator to supply the id.
  const demandsAnId = /placeholder="[^"]*(?:e\.g\.|\.\/|name provider|type)[^"]*"/i.test(page)
    && /value=\{targetModel\}/.test(page);
  assert.ok(!demandsAnId,
    "the free-text field is gone; nothing should be demanded of the operator");
});

t("the chosen model is visible and overridable", () => {
  assert.ok(/Testing against/.test(page),
    "the operator has to see which model a global entry will run on");
  assert.ok(/Ganti/.test(page),
    "and needs a way to choose a different one");
});

t("the default is fetched rather than hard-coded", () => {
  assert.ok(/fetch\("\/api\/models"\)/.test(page),
    "the catalogue is the source of truth; a hard-coded id would go stale");
});

// A stray JSX block left at module scope parses cleanly — it is a valid
// expression statement — so tsc and vite both accept it, and it only fails when
// the page runs, as a ReferenceError that blanks the whole route. A browser run
// is what caught it; this is here so the next one does not need one.
t("no JSX sits outside a component", () => {
  const firstImport = page.search(/^import /m);
  assert.ok(firstImport !== -1, "the module should start with imports");
  const head = page.slice(0, firstImport);
  assert.ok(!head.includes("className"),
    `JSX above the first import is module-scope and will throw at runtime:\n${head.slice(0, 400)}`);
});

t("the module opens with an import, not markup", () => {
  const first = page.split("\n").find(l => l.trim() && !l.trim().startsWith("//"));
  assert.ok(first.startsWith("import "),
    `first statement should be an import, got: ${first}`);
});

t("the playground block appears exactly once", () => {
  const n = page.split("Testing against").length - 1;
  assert.strictEqual(n, 1,
    `${n} copies of the chooser block; a duplicate outside the component blanks the page`);
});

// tsc does not catch a useState pair that was deleted while its reads and
// writes stayed: the identifier resolves nowhere and the component throws on
// first render. Checking the whole file is too weak — the same setter name may
// legitimately exist in another component — so this is scoped per component.
t("every state setter a component calls is declared in it", () => {
  const GLOBALS = new Set(["setTimeout", "setInterval", "setImmediate", "setSelectionRange"]);
  const components = [...page.matchAll(/function\s+(\w+)\s*\(/g)];
  const problems = [];
  components.forEach((c, n) => {
    const from = c.index + c[0].length;
    const to = n + 1 < components.length ? components[n + 1].index : page.length;
    const body = page.slice(from, to);

    const local = new Set();
    for (const m of body.matchAll(/const\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*(set[A-Za-z_$][\w$]*)\s*\]/g)) {
      local.add(m[1]);
      local.add(m[2]);
    }
    for (const m of body.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) local.add(m[1]);
    for (const m of body.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*,/g)) local.add(m[1]);
    for (const m of body.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) local.add(m[1]);
    for (const m of body.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);

    const used = new Set(
      [...body.matchAll(/\b(set[A-Z][\w$]*)\s*\(/g)].map(m => m[1])
    );
    for (const name of used) {
      if (GLOBALS.has(name)) continue;
      // Deliberately no file-wide fallback: a useState declared in a sibling
      // component is a different binding and resolves to nothing here.
      if (local.has(name)) continue;
      problems.push(`${c[1]}: ${name}`);
    }
  });

  assert.deepStrictEqual(problems, [],
    `setters called but not declared in their component: ${problems}`);
});

t("every identifier the playground reads is declared", () => {
  const i = page.indexOf("function Playground(");
  const j2 = page.indexOf("\nfunction ", i + 10);
  const body = page.slice(i, j2 === -1 ? page.length : j2);
  const declared = new Set(
    [...page.matchAll(/(?:const|let|function)\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1])
  );
  for (const name of ["catalog", "autoModel", "entryNamesAModel", "runnableModel", "targetModel"]) {
    assert.ok(new RegExp(`const\\s+(?:\\[[\\s\\S]*?)?\\b${name}\\b`).test(body) ||
              declared.has(name),
      `${name} is read in Playground but never declared`);
  }
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);