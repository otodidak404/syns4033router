// /dashboard/system-prompt collapsed every failed run into one message.
//
// A model that does not exist, a model that exists but has no key, and a
// provider that answered with an error body all reach the same branch — the
// upstream body is read, extractText finds no assistant text, and the reason is
// discarded. Live, all three returned exactly:
//
//   "The model returned no text for this run."
//
// which is the one message an operator cannot act on: it names neither the
// model, the provider, nor the cause.
import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTE = path.join(HERE, "src", "routes", "system-prompts", "try", "route.ts");
const src = fs.readFileSync(ROUTE, "utf8");

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

t("an empty run explains itself", () => {
  assert.ok(/function failureReason\(raw\)/.test(src), "no failureReason helper");
  assert.ok(/error: failureReason\(raw\)/.test(src), "the empty branch still uses a fixed string");
});

t("the upstream body is passed in rather than dropped", () => {
  // The reason has to come from the same raw that extractText failed on.
  const i = src.indexOf("const raw =");
  const seg = src.slice(i, i + 1200);
  assert.ok(/extractText\(raw\)/.test(seg), "extractText no longer reads raw");
  assert.ok(/failureReason\(raw\)/.test(seg), "failureReason is called on something else");
});

t("it reads the usual error shapes, not just one", () => {
  const i = src.indexOf("function failureReason");
  const fn = src.slice(i, src.indexOf("\n}", i));
  for (const field of ["error", "message", "detail"]) {
    assert.ok(new RegExp(`body\\?\\.${field}`).test(fn), `${field} is not read`);
  }
  assert.ok(/err\.message/.test(fn), "a nested { message } error object is not handled");
  assert.ok(/slice\(0, 240\)/.test(fn), "an upstream error could be unbounded and flood the UI");
});

t("it still says something when the body is empty or unparseable", () => {
  const i = src.indexOf("function failureReason");
  const fn = src.slice(i, src.indexOf("\n}", i));
  // Two distinct paths can reach the fallback: a body that is empty, and a body
  // that is not JSON. Counting returns is too loose — removing one fallback
  // still leaves three returns and the suite stays green.
  const fallbacks = (fn.match(/The model returned no text for this run\./g) || []).length;
  assert.equal(fallbacks, 2,
    `expected the fallback on both the empty-body and the unparseable-body path, found ${fallbacks}`);
  assert.ok(/if \(!text\.trim\(\)\)/.test(fn), "the empty-body guard is gone");
});

// The helper is logic worth executing, not just matching.
t("it reports the reason, not the absence of one", async () => {
  const i = src.indexOf("function failureReason");
  const fnSrc = src.slice(i, src.indexOf("\n}\n", i) + 2)
    .replace(/^function failureReason/, "function failureReason");
  const failureReason = new Function(`${fnSrc}; return failureReason;`)();

  assert.match(failureReason('{"error":{"message":"model not found: foo/bar"}}'), /model not found: foo\/bar/);
  assert.match(failureReason('{"error":"upstream 503"}'), /upstream 503/);
  assert.match(failureReason('{"message":"quota exceeded"}'), /quota exceeded/);
  assert.match(failureReason('{"error":{"message":"' + "x".repeat(900) + '"}}'), /^x{240}$/);
  assert.match(failureReason(""), /no text for this run/);
  assert.match(failureReason("<html>502</html>"), /no text for this run/);
  assert.match(failureReason("{not json"), /no text for this run/);
  assert.match(failureReason(null), /no text for this run/);
});

t("the prompt limit the library enforces is the one the playground enforces", () => {
  const store = fs.readFileSync(path.join(HERE, "src", "routes", "system-prompts", "route.ts"), "utf8");
  const a = store.match(/MAX_PROMPT_CHARS\s*=\s*([\d_]+)/);
  const b = src.match(/MAX_PROMPT\s*=\s*([\d_]+)/);
  assert.ok(a && b, "a limit is missing");
  assert.equal(Number(a[1].replace(/_/g, "")), Number(b[1].replace(/_/g, "")),
    `store accepts ${a[1]} but the playground accepts ${b[1]}`);
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);