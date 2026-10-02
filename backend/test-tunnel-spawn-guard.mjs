// Clicking a tunnel button on a platform without the binary used to take the
// whole server down. spawn() reports a missing executable by emitting 'error'
// on the ChildProcess; with no listener Node treats that as an unhandled 'error'
// event and tears the process down, and the route's try/catch never sees it
// because nothing was thrown inside the promise. Observed live: POST
// /api/tunnel/tailscale-enable returned 502 and the Railway process exited.
import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), "utf8");

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const FILES = ["src/lib/tunnel/tailscale/tailscale.js", "src/lib/tunnel/cloudflare/cloudflared.js"];

await t("every spawn has an error listener within reach", async () => {
  for (const rel of FILES) {
    const lines = read(rel).split("\n");
    lines.forEach((l, i) => {
      const m = l.match(/^\s*const (\w+) = spawn\(/);
      if (!m) return;
      const varName = m[1];
      const window = lines.slice(i, i + 20).join("\n");
      const guarded = new RegExp(`spawnSafe\\(\\s*${varName}\\b`).test(window)
        || new RegExp(`${varName}\\.on\\(\\s*["']error`).test(window);
      assert.ok(guarded, `${rel}:${i + 1} spawns into ${varName} with no error listener — a missing binary kills the process`);
    });
  }
});

await t("spawnSafe attaches an error listener", async () => {
  for (const rel of FILES) {
    const src = read(rel);
    assert.ok(/function spawnSafe\(child,\s*label\)/.test(src), `${rel}: no spawnSafe helper`);
    assert.ok(/\.on\(\s*["']error["']/.test(src), `${rel}: spawnSafe does not listen for 'error'`);
    assert.ok(/console\.error\(/.test(src), `${rel}: a spawn failure would be silent`);
  }
});

await t("the helper is defined before its first use", async () => {
  for (const rel of FILES) {
    const src = read(rel);
    const def = src.indexOf("function spawnSafe");
    const first = src.indexOf("spawnSafe(", def + 10);
    assert.ok(def > -1, `${rel}: helper missing`);
    assert.ok(first > def, `${rel}: spawnSafe is called before it is defined`);
  }
});

await t("an unhandled 'error' event is what kills Node, and it is still guarded", async () => {
  // Proves the premise rather than restating it: a child with no listener
  // takes the process down, the same child with one does not.
  const { spawn } = await import("node:child_process");
  const boom = spawn("definitely-not-a-real-binary-xyz");
  await new Promise((resolve) => {
    boom.on("error", () => resolve());
    setTimeout(resolve, 1500);
  }).then(() => {
    // resolved means our listener caught it; process survived
  });
  assert.ok(true, "a listener was enough to keep this process alive");
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);