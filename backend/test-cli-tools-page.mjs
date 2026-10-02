// /dashboard/cli-tools had three writers that could fail in silence.
//
// fetch() rejects only on a network error. An HTTP 400 or 500 is an ordinary
// response that resolves, so `await fetch(...)` with the response discarded
// treats a rejected save as a successful one. Three shapes of it here:
//
//   MitmToolCard   `catch { /* ignore */ }` — a mapping is what redirects an
//                  intercepted IDE request, so a save that failed left the card
//                  showing a redirect that was not in force, while traffic kept
//                  flowing to the old target. Nothing was logged either.
//   OpenCodeToolCard  the modal closes and the model list is already in local
//                  state before the POST is even sent.
//   CopilotToolCard  same, and it is near-identical to the OpenCode one.
//
// The scan is repo-wide because the same shape has turned up on six pages now.
// A per-file check would have found only whichever file someone happened to open.
import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FE = path.join(HERE, "..", "frontend", "src");
const CARDS = path.join(FE, "pages", "cli-tools", "components");

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const read = (rel) => fs.readFileSync(path.join(CARDS, rel), "utf8");

const SWALLOWED = /catch\s*\{\s*\/\*[^*]*\*\/\s*\}/;

// ── the three that were broken ───────────────────────────────────────────────
t("the MITM mapping save reports failure instead of ignoring it", () => {
  const src = read("MitmToolCard.jsx");
  const i = src.indexOf("const saveMappings");
  const fn = src.slice(i, src.indexOf("}, [tool.id]);", i));
  assert.ok(!SWALLOWED.test(fn), "the catch still swallows everything");
  assert.ok(/if \(!res\.ok\)/.test(fn), "a failed response is still treated as success");
  assert.ok(/setSaveError\(/.test(fn), "nothing tells the operator the mapping did not save");
  assert.ok(/return false/.test(fn), "the caller cannot tell it failed");
});

t("the mapping failure is actually rendered, not just stored", () => {
  const src = read("MitmToolCard.jsx");
  assert.ok(/const \[saveError,\s*setSaveError\]\s*=\s*useState\(/.test(src),
    "saveError has no state — setting it would throw");
  assert.ok(/\{saveError\s*&&/.test(src),
    "saveError is never rendered, so a silent failure would stay silent");
});

t("the OpenCode model list rolls back when the save is rejected", () => {
  const src = read("OpenCodeToolCard.jsx");
  const i = src.indexOf("const saveModels");
  const fn = src.slice(i, src.indexOf("\n  };", i));
  assert.ok(/if \(!res\.ok\)/.test(fn), "a failed response is treated as success");
  // Twice: the !res.ok branch and the network-failure branch. Matching one of
  // them passes while the other is gone — the same trap the empty-state title
  // check fell into.
  const rollbacks = (fn.match(/setSelectedModels\(previous\.models\)/g) || []).length;
  assert.equal(rollbacks, 2,
    `expected the list restored on both the rejected and the unreachable path, found ${rollbacks}`);
  assert.ok(/const previous = \{ models: selectedModels/.test(fn),
    "nothing was captured to restore from");
  assert.ok(/setMessage\(\{ type: "error"/.test(fn), "the operator is not told");
});

t("the Copilot model list does the same", () => {
  const src = read("CopilotToolCard.jsx");
  const i = src.indexOf("const saveModels");
  const fn = src.slice(i, src.indexOf("\n  };", i));
  assert.ok(/if \(!res\.ok\)/.test(fn), "a failed response is treated as success");
  assert.ok(/setSelectedModels\(previous\)/.test(fn), "the list is not restored");
  assert.ok(/setMessage\(\{ type: "error"/.test(fn), "the operator is not told");
});

t("the Claude naming toggle rolls back when the save is rejected", () => {
  const src = read("ClaudeToolCard.jsx");
  const i = src.indexOf("const handleCcFilterNamingToggle");
  const fn = src.slice(i, src.indexOf("\n  };", i));
  assert.ok(/if \(!res\.ok\)/.test(fn), "a failed response is treated as success");
  assert.ok(/setCcFilterNaming\(previous\)/.test(fn), "the switch is not restored");
  assert.ok(/const previous = ccFilterNaming/.test(fn), "nothing was captured to restore from");
  assert.ok(!/\.catch\(\(\) => \{\}\)/.test(fn), "the failure is still discarded");
});

t("the translator reports a failed file save instead of discarding it", () => {
  // Found by the repo-wide scan rather than by reading the page: a save that
  // wrote the file and threw the result away is indistinguishable from one that
  // worked, and the content was simply lost.
  const p = path.join(FE, "pages", "translator", "page.jsx");
  const src = fs.readFileSync(p, "utf8");
  const i = src.indexOf("const save =");
  const fn = src.slice(i, src.indexOf("\n  };", i));
  assert.ok(/if \(!res\.ok\)/.test(fn), "a failed save is treated as success");
  assert.ok(/return false/.test(fn), "the caller cannot tell the save failed");
  assert.ok(!/\.catch\(\(\) => \{\}\)/.test(fn), "the failure is still discarded");
  assert.ok(/setError\(/.test(fn), "the operator is not told the file was not written");
  assert.ok(/const \[error,\s*setError\]\s*=\s*useState\(/.test(src), "error has no state");
  assert.ok(/\{error\s*&&/.test(src), "error is never rendered, so it would stay silent");
});

// ── repo-wide ───────────────────────────────────────────────────────────────
t("no writer in the app swallows its failure with an empty catch", () => {
  const offenders = [];
  for (const f of walk(FE)) {
    const src = fs.readFileSync(f, "utf8");
    // an empty catch immediately after a write, not anywhere
    src.split("\n").forEach((l, i) => {
      if (!SWALLOWED.test(l)) return;
      const before = src.split("\n").slice(Math.max(0, i - 8), i).join("\n");
      if (!/method:\s*"(PUT|POST|PATCH|DELETE)"/.test(before)) return;
      offenders.push(`${path.relative(FE, f)}:${i + 1}  ${l.trim()}`);
    });
  }
  assert.equal(offenders.length, 0, "a write whose failure is discarded:\n       " + offenders.join("\n       "));
});

t("every cli-tools card that writes checks the response", () => {
  const offenders = [];
  for (const f of walk(CARDS)) {
    const src = fs.readFileSync(f, "utf8");
    // A single fetch statement: up to the end of the options object.
    let idx = 0;
    while ((idx = src.indexOf("await fetch(", idx)) !== -1) {
      let d = 0, k = src.indexOf("(", idx);
      while (k < src.length) {
        if (src[k] === "(") d++;
        else if (src[k] === ")") { d--; if (d === 0) break; }
        k++;
      }
      const call = src.slice(idx, k + 1);
      // The check often sits well below the call — MitmServerCard assigns res
      // inside a branch and tests it 25 lines later — so a character window
      // both misses it and reads as a defect that is not there.
      // Bound the look-ahead by the end of the enclosing handler. indexOf
      // returns -1 when there is no such marker, and -1 + 4 is 3 — truthy, so the
      // fallback never fires and the window collapses to nothing, flagging writes
      // that do check their status three lines later.
      const end = src.indexOf("\n  };", k + 1);
      const after = src.slice(k + 1, end === -1 ? k + 1200 : end + 4);
      const isWrite = /method:\s*"(PUT|POST|PATCH|DELETE)"/.test(call);
      if (isWrite && !/\.ok\b|\.status\b|expectOk/.test(after)) {
        const ln = src.slice(0, idx).split("\n").length;
        offenders.push(`${path.basename(f)}:${ln}  ${path.basename(call.match(/["'`](\/api[^"'`]*)/)?.[1] ?? "?")}`);
      }
      idx = k + 1;
    }
  }
  assert.equal(offenders.length, 0, "writes whose result is discarded:\n       " + offenders.join("\n       "));
});

t("the page still reads every endpoint it declares", () => {
  const declared = new Set();
  for (const f of walk(CARDS)) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/["'`](\/api\/cli-tools\/[a-z-]+(?:\/[a-z-]+)?)/g)) declared.add(m[1]);
  }
  assert.ok(declared.size >= 10, `only ${declared.size} endpoints found — the scan is not looking properly`);
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);