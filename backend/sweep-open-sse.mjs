// Import-only sweep of open-sse/handlers — 51 modules of provider adapters and
// cores, none of which are request entrypoints.
//
// Import alone is the cheap half and catches two things that reading cannot: a
// module that throws at load time, and a binding that does not exist. Nothing is
// called here: these modules poll upstreams and open sockets, so calling them
// blind would make real network calls. The call-half lives in
// sweep-handlers.mjs for the eight request entrypoints that are safe to invoke.
import fs from "node:fs";
import path from "node:path";

const ROOT = "./open-sse/handlers";
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js")) files.push(p);
  }
})(ROOT);

const cap = (p, ms, tag) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`__TIMEOUT__${tag}`)), ms)),
]);

const report = {
  files: files.length,
  imported: [],
  importFail: [],
  importTimeout: [],
  exportNames: {},
};

for (const f of files) {
  let mod;
  try {
    mod = await cap(import(path.resolve(f)), 10000, "");
  } catch (e) {
    if (String(e.message).startsWith("__TIMEOUT__")) report.importTimeout.push(f);
    else report.importFail.push(`${f}  ${e.constructor.name}: ${String(e.message).slice(0, 90)}`);
    continue;
  }
  report.imported.push(f);
  const names = Object.keys(mod);
  report.exportNames[f] = names.length;
}

console.log("@@RESULT@@" + JSON.stringify(report));

for (const h of process._getActiveHandles?.() ?? []) h.unref?.();
for (const h of process._getActiveRequests?.() ?? []) h.unref?.();
setTimeout(() => process.exit(report.importFail.length ? 1 : 0), 250).unref();