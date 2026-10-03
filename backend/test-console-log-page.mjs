// /dashboard/console-log — the SSE console viewer.
//
// Ninety lines, and three things were wrong in it. The message handler parsed each
// frame with JSON.parse and no guard. The Clear button awaited the DELETE and never
// looked at the response. And `connected` was set from the EventSource open and error
// handlers but never rendered, so a stream that had died looked exactly like a console
// with nothing on it.

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PAGE = path.join(HERE, "../frontend/src/pages/console-log/ConsoleLogClient.jsx");
const src = fs.readFileSync(PAGE, "utf8");

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });
function drain() {
  for (const { name, fn } of queue) {
    try { fn(); pass++; console.log(`  ok   ${name}`); }
    catch (e) { process.exitCode = 1; console.log(`  FAIL ${name}\n       ${e?.message || e}`); }
  }
  console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);
}

const body = (name) => {
  const at = src.indexOf(`const ${name} = `);
  assert.ok(at > 0, `${name} is not defined`);
  let depth = 0;
  for (let k = src.indexOf("{", at); k < src.length; k += 1) {
    if (src[k] === "{") depth += 1;
    else if (src[k] === "}") { depth -= 1; if (depth === 0) return src.slice(at, k + 1); }
  }
  throw new Error(`no end for ${name}`);
};

t("the stream frame is parsed defensively", () => {
  const at = src.indexOf("es.onmessage =");
  assert.ok(at > 0, "no onmessage handler");
  const seg = src.slice(at, at + 500);
  assert.ok(/try \{\s*\n?\s*msg = JSON\.parse\(e\.data\)/.test(seg),
    "the frame is parsed with no guard, so one bad frame throws inside the handler");
  assert.ok(/catch \{\s*\n?\s*return;/.test(seg),
    "the catch does not skip the frame");
  // and it must not swallow everything after it
  assert.ok(seg.indexOf("catch") < seg.indexOf('msg.type === "init"'),
    "the catch swallows the rest of the handler");
});

t("a failed clear is reported instead of looking like it worked", () => {
  const clear = body("handleClear");
  assert.ok(/if \(!res\.ok\)/.test(clear),
    "the response status is never checked, so a refused delete looks like a clear");
  assert.ok(/HTTP \$\{res\.status\}/.test(clear), "the status is not named");
  assert.ok(/Could not clear the logs/.test(clear), "nothing is said about the failure");
  assert.ok(/setLogs\(\[\]\)/.test(clear),
    "the buffer is not cleared, so a stream that is already down leaves stale logs");
  assert.ok(!/console\.error/.test(clear), "the failure still only goes to the console");
});

t("the connection state is shown", () => {
  assert.ok(/setConnected\(false\)/.test(src), "the error handler no longer clears it");
  assert.ok(/const \[connected, setConnected\] = useState\(false\)/.test(src), "no such state");
  assert.ok(/!connected && \(/.test(src),
    "the state is still never rendered, so a dead stream looks like an empty console");
  assert.ok(/Live stream disconnected/.test(src), "nothing tells the operator it is gone");
});

t("the error is rendered and announced", () => {
  assert.ok(/const \[error, setError\] = useState\(null\)/.test(src), "no error state");
  assert.ok(/\{error && \(/.test(src), "the banner is dead markup");
  assert.ok(/role="alert"/.test(src), "the error is not announced");
});

t("the buffer still respects its cap", () => {
  const at = src.indexOf('msg.type === "line"');
  const seg = src.slice(at, at + 320);
  assert.ok(/slice\(-CONSOLE_LOG_CONFIG\.maxLines\)/.test(seg),
    "the ring buffer no longer trims to maxLines");
  const init = src.indexOf('msg.type === "init"');
  assert.ok(/slice\(-CONSOLE_LOG_CONFIG\.maxLines\)/.test(src.slice(init, init + 200)),
    "the init frame no longer trims to maxLines");
});

drain();