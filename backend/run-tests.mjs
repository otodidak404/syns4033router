// Runs every runtime suite. Suites whose modules import "@/…" aliases run
// under the build loader; the rest need nothing special.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOADER = "./bin/alias-loader.mjs";

const SUITES = [
  ["test-caveman.mjs", false],
  ["test-skill-loader.mjs", false],
  ["test-skill-wiring.mjs", false],
  ["test-model-skill.mjs", false],
  ["test-live-prompt.mjs", true],
  ["test-sysprompt-db-error.mjs", true],
  ["test-sysprompt-presets.mjs", false],
  ["test-extract-api-key.mjs", true],
  ["test-api-key-gate.mjs", true],
  ["test-api-key-rehash.mjs", true],
  ["test-route-imports.mjs", false],
  ["test-ssrf-guard.mjs", true],
  ["test-playground-extract.mjs", false],
  ["test-playground-target-model.mjs", false],
  ["test-audit-fixes.mjs", false],
  ["test-no-store.mjs", false],
  ["test-model-catalogue.mjs", false],
  ["test-internal-api-key.mjs", true],
  ["test-skills-route.mjs", true],
  ["test-auth-gate.mjs", true],
  ["test-tunnel-spawn-guard.mjs", false],
  ["test-endpoint-page.mjs", false],
  ["test-req-body-parsed.mjs", false],
  ["test-providers-page.mjs", false],
  ["test-system-prompt-page.mjs", false],
  ["test-combos-page.mjs", false],
  ["test-usage-page.mjs", false],
  ["test-quota-page.mjs", false],
  ["test-mitm-page.mjs", false],
  ["test-cli-tools-page.mjs", false],
  ["test-docs-page.mjs", false],
  ["test-media-providers-page.mjs", false],
  // imports through "@/" — needs the alias loader
      ["test-handler-entrypoints.mjs", true],
      // imports the compiled route modules from dist/, also through "@/"
      ["test-models-and-cors.mjs", true],
      // parses every .js/.ts under src and open-sse with @babel; no alias loader
      ["test-unbound-identifiers.mjs", false],
      // swaps globalThis.fetch, so it must run in its own process
      ["test-stt-flow.mjs", true],
      // reads the media-provider frontend components from disk; no alias loader
      ["test-media-shared-cards.mjs", false],
      // reads the real catalogue and the real video adapter map
      ["test-video-flow.mjs", true],
      // drives the real handleFetchCore against a stubbed fetch
      ["test-web-fetch-flow.mjs", true],
      // drives handleFetch over the real auth and db modules
      ["test-web-handler-branches.mjs", true],
      // runs a real CONNECT proxy and a real refused connection
      ["test-proxy-pool-test.mjs", true],
      ["test-proxy-pools-page.mjs", false],
    ];

let failed = 0;
let total = 0;

// The alias loader resolves "@/…" to dist/, so a fresh clone has nothing to
// point at until the backend is built. Build once, up front, rather than
// letting two suites fail with an opaque module-not-found.
if (!fs.existsSync(path.join(HERE, "dist"))) {
  console.log("dist/ missing — building backend first\n");
  const build = spawnSync("npm", ["run", "build"], { cwd: HERE, encoding: "utf8", shell: true });
  if (build.status !== 0) {
    console.error("build failed:\n" + (build.stdout || "") + (build.stderr || ""));
    process.exit(1);
  }
}

for (const [file, needsLoader] of SUITES) {
  const args = needsLoader ? ["--loader", LOADER, file] : [file];
  const r = spawnSync(process.execPath, args, { cwd: HERE, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const line = out.split("\n").find(l => /^\d+ passed/.test(l.trim()));

  const count = line ? parseInt(line) : 0;
  total += count;
  if (r.status !== 0 || !line) {
    failed++;
    console.log(`FAIL ${file}`);
    console.log(out.split("\n").filter(l => /FAIL|Error/.test(l)).slice(0, 6).map(l => "     " + l).join("\n"));
  } else {
    console.log(`  ok  ${file.padEnd(26)} ${count} passed`);
  }
}

console.log(`\n${total} assertions${failed ? ` — ${failed} suite(s) failed` : " — all suites passed"}`);
process.exit(failed ? 1 : 0);