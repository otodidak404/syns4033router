// The Cloudflare deploy action in POST /api/automation/ammail.
//
// Every wrangler invocation used to go through promisify(exec), which is /bin/sh -c
// on the assembled string. telegram_bot_token arrives in the request body and was
// interpolated into:
//
//     execAsync(`echo "${telegram_bot_token}" | npx wrangler secret put ...`)
//
// so a token containing a quote, $(...) or a backtick was parsed as shell syntax and
// ran as a command. These tests drive the real wrangler helper with a stub executable
// and a token that would be hostile if a shell were involved.

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = fs.readFileSync(
  path.join(HERE, "src/routes/automation/ammail/route.ts"), "utf8");

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });
async function drain() {
  for (const { name, fn } of queue) {
    try { await fn(); pass++; console.log(`  ok   ${name}`); }
    catch (e) { process.exitCode = 1; console.log(`  FAIL ${name}\n       ${e?.message || e}`); }
  }
  console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);
}

function helperBody() {
  const at = SRC.indexOf("function wrangler(");
  const lines = SRC.split("\n");
  const start = SRC.slice(0, at).split("\n").length - 1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === "}") return lines.slice(start, i + 1).join("\n");
  }
  throw new Error("could not find the end of wrangler()");
}

t("no wrangler invocation goes through a shell", () => {
  const shellCalls = SRC.match(/execAsync\((?:`|")[^)]*npx wrangler/g) || [];
  assert.deepEqual(shellCalls, [],
    `wrangler is still invoked through a shell:\n${shellCalls.join("\n")}`);
  assert.ok(!/execAsync\(`echo/.test(SRC),
    "a secret is still piped in with echo");
});

t("the token is passed on stdin, never on a command line", () => {
  const needle = 'wrangler(["secret", "put", "TELEGRAM_BOT_TOKEN"]';
  const at = SRC.indexOf(needle);
  assert.ok(at > 0, "TELEGRAM_BOT_TOKEN is not set through wrangler()");
  // To the end of that statement, not to the first ")" -- that one closes the array.
  const line = SRC.slice(at, SRC.indexOf("\n", at));
  assert.ok(/stdin:/.test(line),
    `the token is not on stdin:\n${line}`);
  // It is interpolated into the stdin *value*, which is the point; what matters is
  // that it is not in the argument array. The array ends at its own "]", which is
  // followed by ")" here rather than "," -- matching on "]," silently produced an
  // empty slice and passed for any argument list at all.
  const arrStart = line.indexOf("[", line.indexOf("wrangler("));
  const arrEnd = line.indexOf("]", arrStart);
  assert.ok(arrStart > 0 && arrEnd > arrStart, `could not read the argument array: ${line}`);
  const args = line.slice(arrStart, arrEnd + 1);
  assert.ok(!args.includes("telegram_bot_token"),
    `the token is in the argument list:\n${args}`);
});

t("the helper spawns without a shell", () => {
  assert.ok(SRC.includes("function wrangler("), "no wrangler helper");
  const body = helperBody();
  assert.ok(/spawn\(\s*"npx"/.test(body),
    "the helper does not spawn npx directly");
  assert.ok(!/shell\s*:\s*true/.test(body),
    "the helper explicitly enables a shell");
  // wrangler secret put reads the value from stdin; leaving it open hangs the deploy
  // until something else times out.
  assert.ok(/child\.stdin\.end\(/.test(body),
    "the helper never closes stdin, so `wrangler secret put` would wait forever");
});

await drain();