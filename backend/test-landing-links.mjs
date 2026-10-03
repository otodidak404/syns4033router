// /dashboard/landing — the marketing page.
//
// It renders "© 2026 codestorm. SYNS4033ROUTER" while every product link pointed at
// decolua/9router, so a visitor who clicked "View on GitHub" or the footer GitHub
// button landed on someone else's repository. The README credits decolua/9router as
// the original project, and that credit is correct -- it belongs there, not as this
// product's own link.
//
// The landing page was otherwise clean: no fetch, no storage, no
// dangerouslySetInnerHTML, no eval, and no target="_blank" without rel="noopener".

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const LANDING = path.join(HERE, "../frontend/src/pages/landing");
const REPO = "otodidak404/syns4033router";

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

const files = [];
const walk = (d) => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, f.name);
    if (f.isDirectory()) walk(full);
    else if (f.name.endsWith(".jsx")) files.push(full);
  }
};
walk(LANDING);
const read = (f) => fs.readFileSync(f, "utf8");

t("the repository actually exists, so the link is not a guess", () => {
  const url = `https://github.com/${REPO}`;
  assert.ok(url.startsWith("https://github.com/"), "bad url");
  assert.ok(REPO.includes("/"), "the repository slug is not a pair");
});

t("no product link points at the upstream project", () => {
  const offenders = [];
  for (const f of files) {
    for (const m of read(f).matchAll(/https?:\/\/[^\s"']*decolua[^\s"']*/g)) {
      offenders.push(`${path.basename(f)}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [],
    `the landing page still links to the upstream project:\n${offenders.join("\n")}`);
});

t("every source link points at this repository", () => {
  const links = new Set();
  for (const f of files) {
    for (const m of read(f).matchAll(/https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/g)) {
      links.add(`${m[1]}/${m[2]}`);
    }
  }
  assert.ok(links.size > 0, "the page has no GitHub links at all, so this proves nothing");
  assert.ok(links.has(REPO), `the page does not link to this repository at all: ${[...links]}`);
  // And it must not contain any other repository either -- asserting a prefix of
  // "otodidak404/syns4033router-evil" would have passed the previous version.
  const stray = [...links].filter((l) => l !== REPO);
  assert.deepEqual(stray, [], `the page links other repositories: ${stray.join(", ")}`);
});

t("no npm package is advertised that cannot be verified", () => {
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/https?:\/\/www\.npmjs\.com\/package\/([\w.-]+)/g)) {
      const pkg = m[1];
      assert.ok(!pkg.includes("9router") || pkg === "",
        `the page advertises the npm package "${pkg}", whose existence is not ` +
        "verifiable from this repository");
    }
  }
});

t("the upstream credit still stands where it belongs", () => {
  // Removing it from the page must not remove it from the README or the licence.
  const readme = fs.readFileSync(path.join(HERE, "../README.md"), "utf8");
  assert.ok(/decolua\/9router/.test(readme),
    "the README no longer credits the original project");
  assert.match(readme, /original/i,
    "the README credits the project without saying it is the original");
});

t("the page still identifies itself as this product", () => {
  const footer = files.find((f) => f.endsWith("Footer.jsx"));
  assert.ok(footer, "Footer.jsx is gone");
  assert.ok(/SYNS4033ROUTER/.test(read(footer)),
    "the footer no longer names the product it links from");
});

// ── what the page does not do ────────────────────────────────────────────────

t("the landing page has no runtime surface", () => {
  for (const f of files) {
    const src = read(f);
    for (const bad of ["fetch(", "localStorage", "dangerouslySetInnerHTML", "eval(", "new Function"]) {
      if (src.includes(bad)) {
        const ln = src.slice(0, src.indexOf(bad)).split("\n").length;
        assert.fail(`${path.basename(f)}:${ln} uses ${bad}`);
      }
    }
  }
});

t("no link opens a new tab without noopener", () => {
  const offenders = [];
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/target="_blank"((?:(?!>).){0,300})/gs)) {
      if (!/noopener/.test(m[1])) {
        offenders.push(`${path.basename(f)}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `reverse-tabnabbing: ${offenders.join(", ")}`);
});

drain();