// /dashboard/mitm is an eleven-line page delegating to the cli-tools cards; the
// MITM engine behind it is ~3800 lines. Two defects, both about what reaches disk.
//
// The dump files are a debugging aid, and dumpRequest wrote
//
//   headers: req.headers
//
// verbatim — no redaction anywhere in the file. An intercepted IDE request
// carries that tool's session cookie and the provider API key this router
// substituted, and the dump lands in DATA_DIR at the default 0644, readable by
// anything on the host. LOG_BLACKLIST_URL_PARTS filters by URL, so it never saw
// a header.
//
// The CA private key was written the same way. Anyone holding a MITM CA's key
// can impersonate any site that CA has been trusted for, which is the whole
// attack.
import assert from "assert";
import fs from "node:fs";
import os from "node:os";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MITM = path.join(HERE, "..", "backend", "src", "mitm");
const GITIGNORE = path.join(HERE, "..", ".gitignore");

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

// ── the CA key ───────────────────────────────────────────────────────────────
t("the CA private key is written owner-only", () => {
  const src = fs.readFileSync(path.join(MITM, "cert", "rootCA.js"), "utf8");
  const m = src.match(/writeFileSync\(\s*ROOT_CA_KEY_PATH[^)]*\)/);
  assert.ok(m, "the CA key write disappeared");
  assert.ok(/mode:\s*0o600/.test(m[0]), `CA key has no 0o600: ${m[0]}`);
});

t("the certificate stays world-readable, it is public by nature", () => {
  const src = fs.readFileSync(path.join(MITM, "cert", "rootCA.js"), "utf8");
  const m = src.match(/writeFileSync\(\s*ROOT_CA_CERT_PATH[^)]*\)/);
  assert.ok(m, "the certificate write disappeared");
  assert.ok(/mode:\s*0o644/.test(m[0]), `certificate mode: ${m[0]}`);
});

// ── the dumps ───────────────────────────────────────────────────────────────
t("dumpRequest does not write headers verbatim", () => {
  const src = fs.readFileSync(path.join(MITM, "logger.js"), "utf8");
  const i = src.indexOf("function dumpRequest");
  const fn = src.slice(i, src.indexOf("\n}\n", i));
  assert.ok(!/headers:\s*req\.headers\b/.test(fn),
    "headers are still written raw — the credential reaches disk");
  assert.ok(/headers:\s*redactHeaders\(req\.headers\)/.test(fn), "the dump does not redact");
});

t("response headers are redacted too", () => {
  const src = fs.readFileSync(path.join(MITM, "logger.js"), "utf8");
  assert.ok(/headers\s*=\s*redactHeaders\(h\)/.test(src),
    "the response dumper still stores raw upstream headers");
});

t("the header list covers the credentials that actually appear", () => {
  const src = fs.readFileSync(path.join(MITM, "logger.js"), "utf8");
  const i = src.indexOf("const SENSITIVE_HEADERS");
  const block = src.slice(i, src.indexOf("]);", i));
  for (const h of ["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"]) {
    assert.ok(block.includes(`"${h}"`), `${h} is not on the list`);
  }
  assert.ok(/toLowerCase\(\)/.test(src), "the match is case-sensitive; Node lower-cases incoming headers");
});

t("a redacted header keeps its name so the dump still reads as a request", () => {
  const src = fs.readFileSync(path.join(MITM, "logger.js"), "utf8");
  const i = src.indexOf("function redactHeaders");
  const fn = src.slice(i, src.indexOf("\n}\n", i));
  // out[k] = … — the key survives, only the value goes
  assert.ok(/out\[k\]\s*=/.test(fn), "the header name is not preserved");
  // Dropping the key instead of redacting its value would leave a dump missing
  // the header entirely, which reads as a different request than the real one.
  assert.ok(!/\bcontinue\b|delete out\[/.test(fn),
    "headers are dropped rather than marked, so the dump loses useful shape");
});

t("dump files are written owner-only", () => {
  const src = fs.readFileSync(path.join(MITM, "logger.js"), "utf8");
  const i = src.indexOf("function dumpRequest");
  const fn = src.slice(i, src.indexOf("\n}\n", i));
  assert.ok(/mode:\s*0o600/.test(fn), "the dump is still world-readable");
});

// The redaction itself, executed rather than matched.
t("it strips the credentials and leaves everything else", () => {
  const src = fs.readFileSync(path.join(MITM, "logger.js"), "utf8");
  const start = src.indexOf("const REDACTED");
  const end = src.indexOf("function dumpRequest");
  const mod = { exports: {} };
  new Function("module", "exports", src.slice(start, end) + "\nmodule.exports = { redactHeaders, REDACTED };")(mod, mod.exports);
  const { redactHeaders, REDACTED } = mod.exports;

  // Node lower-cases incoming header names, but the matcher compares with
  // toLowerCase() so a mixed-case key is still caught while its original
  // spelling is kept — the dump then still reads like a real request.
  const out = redactHeaders({
    host: "api.example.com",
    authorization: "Bearer sk-live-abc123",
    Cookie: "session=xyz; other=1",
    "X-API-Key": "key-999",
    "content-type": "application/json",
    "X-Custom": "keep-me",
  });

  assert.equal(out.authorization, REDACTED, "authorization survived");
  assert.equal(out.Cookie, REDACTED, "a mixed-case Cookie survived");
  assert.equal(out["X-API-Key"], REDACTED, "a mixed-case X-API-Key survived");
  assert.equal(out.cookie, undefined, "the original spelling must not be changed");
  assert.equal(out.host, "api.example.com", "host must survive");
  assert.equal(out["content-type"], "application/json", "content-type must survive");
  assert.equal(out["X-Custom"], "keep-me", "unrelated headers must survive");
  assert.ok(!JSON.stringify(out).includes("sk-live-abc123"), "the token is still in the output");
  assert.ok(!JSON.stringify(out).includes("session=xyz"), "the cookie value is still in the output");
});

// ── belt and braces: git must refuse these even if DATA_DIR is misconfigured ──
t(".gitignore refuses private keys and certificates", () => {
  const g = fs.readFileSync(GITIGNORE, "utf8");
  for (const pat of ["*.key", "*.pem", "*.pfx", "*.crt"]) {
    assert.ok(g.split("\n").includes(pat), `.gitignore does not list ${pat}`);
  }
  assert.ok(g.split("\n").includes("/data"), ".gitignore does not exclude /data");
});

t("no key or certificate is tracked today", () => {
  // Only the source file that generates them may be present.
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(key|pem|crt|pfx|p12)$/i.test(e.name)) offenders.push(p);
    }
  };
  walk(path.join(HERE, ".."));
  assert.equal(offenders.length, 0, "key material in the tree:\n       " + offenders.join("\n       "));
});

// The engine itself must still start: redaction is on the request path.
t("the logger still loads", () => {
  const require = createRequire(import.meta.url);
  const target = path.join(MITM, "logger.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mitm-logger-"));
  const before = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  delete require.cache[require.resolve(target)];
  try {
    assert.ok(require(target) && typeof require(target) === "object", "logger.js did not export an object");
  } finally {
    // Leaving DATA_DIR pointed at a deleted temp dir would poison the next suite.
    if (before === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = before;
    delete require.cache[require.resolve(target)];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);