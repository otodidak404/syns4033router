// /dashboard/skills — the page, as opposed to the routes behind it.
//
// The routes are the best covered of anything left in this repo: four suites, 48
// assertions, including the skill loader's unsafe-id rejection and its size cap. The
// page was untested.
//
// Its writers were already right -- each checks res.ok, parses defensively and rolls
// back. What was wrong was the load: three parallel fetches whose failures were
// swallowed by a console.log, leaving a page that showed no skills and no assignments
// with nothing said, which reads as "you have no skills".

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PAGE = path.join(HERE, "../frontend/src/pages/skills/page.jsx");
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

function body(name) {
  const at = src.indexOf(`const ${name} = useCallback(`);
  assert.ok(at > 0, `${name} is not defined`);
  const open = src.indexOf("{", src.indexOf("=>", at));
  let depth = 0;
  for (let k = open; k < src.length; k += 1) {
    if (src[k] === "{") depth += 1;
    else if (src[k] === "}") { depth -= 1; if (depth === 0) return src.slice(at, k + 1); }
  }
  throw new Error(`no end for ${name}`);
}

const fetchData = body("fetchData");

t("a load that fails is reported", () => {
  assert.ok(/setLoadError\(/.test(fetchData), "the load still only logs");
  const failed = fetchData.slice(fetchData.indexOf("const failed"));
  assert.ok(/msRes\.ok \? null : "skill assignments"/.test(failed),
    "the assignments fetch is not named when it fails");
  assert.ok(/provRes\.ok \? null : "providers"/.test(failed),
    "the providers fetch is not named when it fails");
  assert.ok(/aliasRes\.ok \? null : "aliases"/.test(failed),
    "the aliases fetch is not named when it fails");
  assert.ok(/Could not reach the server/.test(fetchData),
    "a load that throws outright is not reported");
});

t("the alias response is parsed defensively", () => {
  assert.ok(/await aliasRes\.text\(\)/.test(fetchData),
    "the alias response is still parsed with res.json(), which throws on an HTML error page");
  assert.ok(/JSON\.parse\(raw\)/.test(fetchData), "no defensive parse");
});

t("a successful load clears the error", () => {
  assert.ok(/else \{\s*setLoadError\(null\);/.test(fetchData),
    "the error is never cleared, so it would stick after a successful retry");
});

t("the error is rendered, and gated on it", () => {
  assert.ok(/const \[loadError, setLoadError\]\s*=\s*useState\(null\)/.test(src),
    "the page has no visible load error");
  assert.ok(/\{loadError && \(/.test(src),
    "the banner is not gated on the error, so it is dead markup");
  assert.ok(/role="alert"/.test(src), "the error is not announced");
  assert.ok(/aria-label="Retry"/.test(src), "there is no way to retry from the page");
});

t("the writers still check their status and parse defensively", () => {
  for (const name of ["toggle", "assign"]) {
    const at = src.indexOf(`const ${name} = async`);
    assert.ok(at > 0, `${name} is gone`);
    const seg = src.slice(at, at + 700);
    assert.ok(/if \(!res\.ok\)/.test(seg), `${name} no longer checks res.ok`);
    assert.ok(/res\.json\(\)\.catch\(\(\) => \(\{\}\)\)/.test(seg),
      `${name} parses its error body without a guard`);
  }
  const un = src.indexOf("const unassign =");
  const seg = src.slice(un, un + 500);
  assert.ok(/if \(!res\.ok\)/.test(seg), "unassign no longer checks res.ok");
});

drain();