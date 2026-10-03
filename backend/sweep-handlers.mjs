// Import every request handler and CALL every exported single-argument function
// with a minimal Request.
//
// The TTS bug was a ReferenceError thrown on the first line of the body, so the
// cheap test is: does calling it throw before anything else happens? A real
// parser beats a regex for "is this identifier bound", and calling beats
// parsing for "does this path work".
//
// Per-call timeout, because several handlers poll an upstream for images or
// video and would otherwise hang the sweep.
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

const report = { files: files.length, ok: [], importFail: [], refErr: [], other: [], timeout: [] };

for (const f of files) {
  let mod;
  try {
    mod = await import(path.resolve(f));
  } catch (e) {
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