// Import every request handler and CALL every exported single-argument function
// with a minimal Request.
//
// The TTS bug was a ReferenceError thrown on the first line of the body, so the
// cheap test is: does calling it throw before anything else happens? A real
// parser beats a regex for "is this identifier bound", and calling beats
// parsing for "does this path work".
//
// Timeouts on BOTH the import and the call: several handlers poll an upstream
// for images or video, and several modules do work at import time.
import fs from "node:fs";
import path from "node:path";

const ROOT = "./src/sse/handlers";
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js")) files.push(p);
  }
})(ROOT);

const mkReq = () => new Request("http://127.0.0.1/api/v1/audio/speech?response_format=json", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "x/y", input: "hi" }),
});

const cap = (p) => Promise.race([
  p,
  new Promise((r) => setTimeout(() => r("__TIMEOUT__"), 2500)),
]);

const report = { files: files.length, ok: [], importFail: [], importTimeout: [], refErr: [], other: [], timeout: [] };

for (const f of files) {
  let mod;
  try {
    // The import needs the cap too. Several modules do work at import time and
    // without this the sweep hangs indefinitely on the first one -- it sat at
    // 845s before this line existed.
    const raced = await Promise.race([
      import(path.resolve(f)),
      new Promise((_, rej) => setTimeout(() => rej(new Error("__IMPORT_TIMEOUT__")), 8000)),
    ]);
    mod = raced;
  } catch (e) {
    if (String(e.message) === "__IMPORT_TIMEOUT__") {
      report.importTimeout.push(f);
      continue;
    }
    report.importFail.push(`${f}  ${e.constructor.name}: ${String(e.message).slice(0, 70)}`);
    continue;
  }
  for (const [name, fn] of Object.entries(mod)) {
    if (typeof fn !== "function") continue;
    if (!/^handle|^POST_|^GET_/.test(name)) continue;
    if (fn.length > 1) continue;
    const label = `${f} :: ${name}`;
    let r;
    try {
      r = fn(mkReq());
    } catch (e) {
      const line = `${label}  ${e.constructor.name}: ${String(e.message).slice(0, 70)}`;
      (e instanceof ReferenceError ? report.refErr : report.other).push(line);
      continue;
    }
    if (r === "__TIMEOUT__" || (r && typeof r.then === "function")) {
      let out;
      try { out = await cap(r); } catch (e) {
        const line = `${label}  ${e.constructor.name}: ${String(e.message).slice(0, 70)}`;
        (e instanceof ReferenceError ? report.refErr : report.other).push(line);
        continue;
      }
      if (out === "__TIMEOUT__") { report.timeout.push(label); continue; }
    }
    report.ok.push(label);
  }
}

console.log("@@RESULT@@" + JSON.stringify(report));

// The sweep opens a SQLite handle and a fetch pool, so the event loop stays
// alive after the last line and the process is killed by the outer timeout --
// exit 124 on a run that actually completed. Report the verdict through the exit
// code too, so a caller can tell "clean finish" from "finished then hung".
process.exitCode = process.exitCode || (report.refErr.length || report.other.length ? 1 : 0);
setTimeout(() => process.exit(process.exitCode || 0), 250).unref();
for (const h of process._getActiveHandles?.() ?? []) h.unref?.();
for (const h of process._getActiveRequests?.() ?? []) h.unref?.();