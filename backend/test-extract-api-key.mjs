// extractApiKey decides whether a request is authenticated at all, so the cases
// it rejects are indistinguishable from a wrong key to the client. The auth
// scheme is case-insensitive per RFC 7235: comparing it case-sensitively turned
// a valid key into a 401 with nothing to explain why.
import assert from "assert";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { extractApiKey } = await import(
  path.join(HERE, "src/sse/services/auth.js")
);

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const req = (headers) => ({ headers });

t("the standard scheme works", () => {
  assert.strictEqual(extractApiKey(req({ authorization: "Bearer sk-abc123" })), "sk-abc123");
});

t("the scheme is case-insensitive: bearer", () => {
  assert.strictEqual(extractApiKey(req({ authorization: "bearer sk-abc123" })), "sk-abc123");
});

t("the scheme is case-insensitive: BEARER", () => {
  assert.strictEqual(extractApiKey(req({ authorization: "BEARER sk-abc123" })), "sk-abc123");
});

t("the scheme is case-insensitive: BeArEr", () => {
  assert.strictEqual(extractApiKey(req({ authorization: "BeArEr sk-abc123" })), "sk-abc123");
});

t("surrounding whitespace is tolerated", () => {
  assert.strictEqual(extractApiKey(req({ authorization: "  Bearer sk-abc123  " })), "sk-abc123");
});

t("extra spaces between scheme and key are tolerated", () => {
  assert.strictEqual(extractApiKey(req({ authorization: "Bearer    sk-abc123" })), "sk-abc123");
});

t("an x-api-key header is accepted", () => {
  assert.strictEqual(extractApiKey(req({ "x-api-key": "sk-abc123" })), "sk-abc123");
});

t("a Fetch-style Headers object is accepted", () => {
  const h = new Headers({ authorization: "bearer sk-abc123" });
  assert.strictEqual(extractApiKey(req(h)), "sk-abc123");
});

t("no header yields null", () => {
  assert.strictEqual(extractApiKey(req({})), null);
});

t("a bare token without a scheme is not accepted", () => {
  // Accepting this would make a malformed header look authenticated; the client
  // gets a clear 401 instead.
  assert.strictEqual(extractApiKey(req({ authorization: "sk-abc123" })), null);
});

t("another scheme is not treated as a key", () => {
  assert.strictEqual(extractApiKey(req({ authorization: "Basic dXNlcjpwYXNz" })), null);
});

t("an empty bearer header yields null rather than an empty string", () => {
  assert.strictEqual(extractApiKey(req({ authorization: "Bearer " })), null);
  assert.strictEqual(extractApiKey(req({ authorization: "Bearer" })), null);
});

t("a key containing characters a greedy split would trim is kept whole", () => {
  assert.strictEqual(extractApiKey(req({ authorization: "Bearer a.b-c_d" })), "a.b-c_d");
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);