// Verifies the CORS policy in both modes: the default (reflect any origin, which
// the hosted dashboard needs) and a configured allowlist (which must reject
// unlisted origins). Boots the built server twice against a scratch data dir.
//
//   npm run build && node scripts/audit/cors-check.mjs
//
// Boots via `npm start` from the repo root, not `node dist/server.js` — the
// backend resolves its `@/` import alias relative to the root node_modules, so
// starting it from backend/ fails to import the route files.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(env, port) {
  const proc = spawn("npm", ["start"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: `/tmp/cors-${port}`, ...env },
    stdio: "ignore",
  });
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return proc;
    } catch {}
    await sleep(500);
  }
  proc.kill();
  throw new Error(`server did not come up on ${port}`);
}

const acao = async (port, origin) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Origin: origin } });
  return r.headers.get("access-control-allow-origin");
};

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name} — got ${JSON.stringify(got)}`);
  ok ? pass++ : fail++;
};

console.log("CORS — default (no allowlist)");
let p = await boot({}, 20987);
check("dashboard origin is reflected", await acao(20987, "https://dashboard.example"), "https://dashboard.example");
check("app root still serves", (await fetch("http://127.0.0.1:20987/")).status, 200);
p.kill();
await sleep(1000);
rmSync("/tmp/cors-20987", { recursive: true, force: true });

console.log("CORS — allowlist configured");
p = await boot({ CORS_ALLOWED_ORIGINS: "https://ok.example" }, 20988);
check("listed origin is allowed", await acao(20988, "https://ok.example"), "https://ok.example");
check("unlisted origin is blocked", await acao(20988, "https://evil.example"), null);
check("app root still serves", (await fetch("http://127.0.0.1:20988/")).status, 200);
p.kill();
await sleep(1000);
rmSync("/tmp/cors-20988", { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);