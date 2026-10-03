// Call the exported functions of every open-sse module, not just import them.
//
// Import alone cannot see the fault this exists for: /v1/audio/speech answered
// 500 {"error":"apiKey is not defined"} and /v1/search answered 500 {"error":
// "modelStr is not defined"} because both threw ReferenceError on the first line
// of the body. Every module imported cleanly the whole time, and eslint no-undef
// was only run by hand. A function body has to be entered.
//
// 175 files / 51 modules under open-sse; the callables are the provider cores
// and adapters. Each is invoked with a minimal argument and a hard timeout,
// because several open SSE polls upstream.
//
// Anything caught that is not a ReferenceError is reported too: an unhandled
// TypeError on the first line is the same class of startup crash.

import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(process.cwd(), "open-sse");
const CALL_TIMEOUT_MS = 2500;
const IMPORT_TIMEOUT_MS = 20000;

const timeout = (ms, label) =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(`__timeout__ ${label}`)), ms));

async function withTimeout(promise, ms, label) {
  return Promise.race([promise, timeout(ms, label)]);
}

const reachable = new Set(["Request", "Response", "Headers", "URL", "URLSearchParams", "fetch"]);

const fs = await import("node:fs");
const allFiles = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".js")) allFiles.push(full);
  }
};
walk(ROOT);
allFiles.sort();

const report = { files: allFiles.length, imported: 0, importFail: [], importTimeout: [],
                 refErr: [], other: [], called: [], timeout: [] };

for (const file of allFiles) {
  const rel = path.relative(ROOT, file);
  let mod;
  try {
    mod = await withTimeout(import(pathToFileURL(file).href), IMPORT_TIMEOUT_MS, `import ${rel}`);
    report.imported++;
  } catch (e) {
    (String(e?.message).includes("__timeout__") ? report.importTimeout : report.importFail)
      .push(`${rel}: ${e?.message?.slice(0, 120)}`);
    continue;
  }

  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== "function") continue;
    if (reachable.has(name)) continue;
    if (/^(use|[A-Z])/.test(name) && /^[A-Z]/.test(name) && name.length > 1) {
      // Classes are not request entrypoints; skip rather than construct one.
      if (/^class\s/.test(String(value))) continue;
    }

    const arity = value.length;
    const arg = arity >= 1
      ? new Request("http://127.0.0.1:9/probe", { method: "POST", body: "{}" })
      : undefined;

    try {
      await withTimeout(
        Promise.resolve().then(() => value(arg)),
        CALL_TIMEOUT_MS,
        `${rel}:${name}`,
      );
      report.called.push(`${rel}:${name}`);
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("__timeout__")) report.timeout.push(`${rel}:${name}`);
      else if (e instanceof ReferenceError) report.refErr.push(`${rel}:${name}  ${msg}`);
      else report.other.push(`${rel}:${name}  ${e?.constructor?.name}: ${msg.slice(0, 100)}`);
    }
  }
}

console.log("@@RESULT@@" + JSON.stringify(report));

// These open SQLite handles and keep the loop alive; the caller reads @@RESULT@@.
setTimeout(() => process.exit(report.refErr.length ? 1 : 0), 300);