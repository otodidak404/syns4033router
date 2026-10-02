// express.json() has already consumed and parsed the request stream by the time a
// handler runs, so req.body is a plain object. Two handlers still treated it as a
// promise and called .catch on it, which throws a TypeError before the handler
// does any work. Live: POST /api/tunnel/tailscale-install returned 500 with
// "req.body.catch is not a function", and the same pattern had already broken
// /api/system-prompts/try earlier in this project.
import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "src");  // backend/src

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);

t("express.json runs before any handler", () => {
  const server = fs.readFileSync(path.join(SRC, "server.ts"), "utf8");
  assert.ok(/app\.use\(\s*express\.json\(/.test(server),
    "no express.json — then req.body is undefined, not a promise either");
});

t("no handler treats req.body as a promise", () => {
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    src.split("\n").forEach((l, i) => {
      if (/req\.body\.(then|catch|finally)\b/.test(l) || /await\s+req\.body\b/.test(l)) {
        bad.push(`${path.relative(SRC, f)}:${i + 1}  ${l.trim().slice(0, 70)}`);
      }
    });
  }
  assert.equal(bad.length, 0, "req.body used as a promise:\n    " + bad.join("\n    "));
});

t("the two handlers that had it now fall back safely", () => {
  for (const rel of ["routes/tunnel/tailscale-install/route.ts", "routes/auth/oidc/test/route.ts"]) {
    const src = fs.readFileSync(path.join(SRC, rel), "utf8");
    assert.ok(/const body = req\.body \|\| \{\};/.test(src),
      `${rel} does not guard for a missing body`);
    assert.ok(!/req\.body\.catch/.test(src), `${rel} still calls .catch on req.body`);
  }
});

t("the handler reads the body it was given", () => {
  const src = fs.readFileSync(path.join(SRC, "routes/tunnel/tailscale-install/route.ts"), "utf8");
  const m = src.match(/const body = req\.body \|\| \{\};/);
  assert.ok(m, "no body assignment");
  assert.ok(/body\.sudoPassword/.test(src),
    "body is assigned but never read — the original intent was lost");
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);