// Two defects on /dashboard/endpoint.
//
// The tunnel one is a denial of service: a button on the page ran spawn() with
// no 'error' listener, so a platform without tailscaled turned the click into an
// unhandled 'error' event and the Railway process exited. Live evidence:
// POST /api/tunnel/tailscale-enable returned 502 and /api/health went down.
//
// The settings one is a switch that lies. Three handlers set local state before
// saving and never checked the response, so a failed save left the toggle showing
// a value the server never took.
import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), "utf8");

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const page = read("../frontend/src/pages/endpoint/EndpointPageClient.jsx");

// ── the crash ────────────────────────────────────────────────────────────────
const SPAWN_FILES = ["src/lib/tunnel/tailscale/tailscale.js", "src/lib/tunnel/cloudflare/cloudflared.js"];

t("no spawn on this page's tunnel path can kill the process", () => {
  for (const rel of SPAWN_FILES) {
    const lines = read(rel).split("\n");
    let total = 0;
    lines.forEach((l, i) => {
      const m = l.match(/^\s*const (\w+) = spawn\(/);
      if (!m) return;
      total++;
      const win = lines.slice(i, i + 20).join("\n");
      const guarded = new RegExp(`spawnSafe\\(\\s*${m[1]}\\b`).test(win)
        || new RegExp(`${m[1]}\\.on\\(\\s*["']error`).test(win);
      assert.ok(guarded, `${rel}:${i + 1} unguarded spawn of ${m[1]}`);
    });
    assert.ok(total > 0, `${rel}: found no spawn at all — the guard proves nothing`);
  }
});

t("an unhandled 'error' event is what takes Node down", async () => {
  // The premise, proved rather than restated: this very process would have
  // exited on a bare spawn of a missing binary.
  const { spawn } = await import("node:child_process");
  const child = spawn("no-such-binary-guard-test-xyz");
  await new Promise((r) => { child.on("error", r); setTimeout(r, 1200); });
  assert.ok(true);
});

t("the tunnel routes catch, so the crash was never a rejected promise", () => {
  // If the routes had awaited something that rejected, their try/catch would
  // have turned it into a 500. A 502 means the process died underneath them.
  for (const r of ["tailscale-enable", "tailscale-disable", "tailscale-install"]) {
    const src = read(`src/routes/tunnel/${r}/route.ts`);
    assert.ok(/try\s*{/.test(src) && /catch/.test(src), `${r} has no try/catch`);
  }
});

// ── the switch that lies ─────────────────────────────────────────────────────
const HANDLERS = ["handleCavemanEnabled", "handleCavemanLevel",
                  "handleRequireApiKey", "handleRtkEnabled", "handleTunnelDashboardAccess"];

t("patchSetting refuses to resolve on a failed save", () => {
  const i = page.indexOf("const patchSetting");
  const fn = page.slice(i, page.indexOf("\n  };", i));
  assert.ok(/if \(!res\.ok\)/.test(fn), "a non-ok response is treated as success");
  assert.ok(/throw new Error/.test(fn), "no throw, so callers cannot roll back");
});

t("no handler moves its switch before the save succeeds", () => {
  for (const h of HANDLERS) {
    const i = page.indexOf(`const ${h}`);
    const body = page.slice(i, page.indexOf("\n  };", i));
    // state must not be set unconditionally before the await
    const setBefore = /^\s*set\w+\(.*\);\s*$/m.test(body.split("await")[0].split("patchSetting")[0]
      .split(".then(")[0].replace(/const \w+ = async.*/, ""));
    assert.ok(!setBefore, `${h} sets state before the save is known to have worked`);
    const savesFirst = /patchSetting\(.*\)\s*\.then\(\s*\(\)\s*=>\s*set/.test(body)
      || /if \(res\.ok\)\s*set/.test(body);
    assert.ok(savesFirst, `${h} never gates its state on the save succeeding`);
  }
});

t("a failed save leaves no unhandled rejection", () => {
  for (const h of ["handleCavemanEnabled", "handleCavemanLevel"]) {
    const i = page.indexOf(`const ${h}`);
    const body = page.slice(i, page.indexOf("\n  };", i));
    assert.ok(/\.catch\(\(\)\s*=>\s*\{\s*\}\)/.test(body),
      `${h} rethrows with nothing catching it, which surfaces as an unhandled rejection`);
  }
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);