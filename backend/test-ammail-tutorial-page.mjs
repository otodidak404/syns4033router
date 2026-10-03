// /dashboard/automation/ammail-tutorial
//
// Every command on this page exists to be pasted into a shell. The copy button called
// navigator.clipboard.writeText, ignored the rejected promise and the case where the
// clipboard does not exist at all over plain http, and then marked the button "Copied"
// regardless -- so a failed copy meant the operator pasted whatever was already on the
// clipboard into wrangler.
//
// Three smaller things in the same 254 lines: CopyButton was defined inside the
// component body, giving React a new component identity on every render; the Step 2
// command carried a developer machine's absolute path; and the guide's emphasis was
// written as markdown asterisks, which JSX renders literally.

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PAGE = path.join(HERE, "../frontend/src/pages/automation/ammail-tutorial/page.jsx");
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

const at = src.indexOf("const handleCopy = ");
const open = src.indexOf("{", src.indexOf("=>", at));
let depth = 0;
let end = at;
for (let k = open; k < src.length; k += 1) {
  if (src[k] === "{") depth += 1;
  else if (src[k] === "}") { depth -= 1; if (depth === 0) { end = k + 1; break; } }
}
const copy = src.slice(at, end);

t("a copy that failed is not reported as a copy", () => {
  assert.ok(/await navigator\.clipboard\.writeText\(val\)/.test(copy),
    "the write is not awaited, so a rejected promise was already reported as success");
  assert.ok(/navigator\.clipboard\?\.writeText/.test(copy),
    "a missing clipboard over plain http still throws on the spot");
  const ok = copy.indexOf("await navigator.clipboard.writeText");
  const mark = copy.indexOf("setCopiedStates");
  assert.ok(ok < mark, "the button is marked copied before the write resolves");
  assert.ok(/catch \(err\)/.test(copy) && /setCopyError\(/.test(copy),
    "the failure is not reported");
});

t("the failure tells the operator what to do instead", () => {
  assert.ok(/secure context is required/.test(copy), "the cause is not named");
  assert.ok(/copy it by hand/.test(copy), "no fallback instruction");
});

t("the error is rendered", () => {
  assert.ok(/const \[copyError, setCopyError\] = useState\(null\)/.test(src), "no error state");
  assert.ok(/\{copyError && \(/.test(src), "the banner is dead markup");
  assert.ok(/role="alert"/.test(src), "the error is not announced");
});

t("CopyButton is not rebuilt on every render", () => {
  const def = src.indexOf("function CopyButton");
  assert.ok(def > 0, "CopyButton is still a closure inside the component");
  assert.ok(def < src.indexOf("export default function AmmailTutorialPage"),
    "CopyButton is defined after the page component");
  const uses = src.match(/<CopyButton\b/g) || [];
  assert.ok(uses.length >= 8, `expected the guide's commands to still have buttons, found ${uses.length}`);
  for (const prop of ["copiedStates", "onCopy"]) {
    const passed = (src.match(new RegExp(`copiedStates=|${prop}=`, "g")) || []).length;
    assert.ok(src.includes(`${prop}={`) || src.includes(`${prop}=`),
      `the button never receives ${prop}`);
  }
  assert.equal((src.match(/copiedStates=\{copiedStates\}/g) || []).length, uses.length,
    "not every CopyButton receives the copied state");
});

t("the button reaches the handler through a prop, not a closure", () => {
  // CopyButton is module level. Its first version still called handleCopy and
  // setCopyError from the component, which is a ReferenceError on the page whose only
  // job is showing commands to copy.
  const at = src.indexOf("function CopyButton");
  const end = src.indexOf("\nexport default", at);
  assert.ok(at > 0 && end > at, "CopyButton is not a module-level component");
  const def = src.slice(at, end);
  for (const name of ["handleCopy", "setCopyError"]) {
    assert.equal((def.match(new RegExp(`\\b${name}\\b`, "g")) || []).length, 0,
      `the module-level button calls ${name}, which lives inside the component`);
  }
  assert.ok(/onCopy\(value\)/.test(def), "the button does not call the prop it was given");
  assert.ok(/copiedStates\[value\]/.test(def), "the button no longer reads the state it was given");
});

t("no developer machine path is offered as a command", () => {
  for (const m of src.matchAll(/\/home\/data\/Project[^\s"']*/g)) {
    assert.fail(`the guide tells the operator to run a path from a developer's machine: ${m[0]}`);
  }
  assert.ok(/cd \/path\/to\/your\/tempmail && npm install/.test(src),
    "the step no longer shows the command at all");
});

t("the guide's emphasis renders as emphasis, not as asterisks", () => {
  const literal = src.match(/\*\*[^*\n]+\*\*/g) || [];
  assert.deepEqual(literal, [],
    `markdown asterisks are rendered literally in the page: ${literal.slice(0, 4).join(", ")}`);
  assert.ok((src.match(/<strong/g) || []).length >= 8,
    "the emphasis the guide relies on is not there");
  const ticks = src.match(/`[^`\n]{1,40}`/g) || [];
  assert.deepEqual(ticks, [],
    `markdown backticks are rendered literally: ${ticks.slice(0, 4).join(", ")}`);
});

drain();