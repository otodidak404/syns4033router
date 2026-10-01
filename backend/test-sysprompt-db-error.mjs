// Acceptance criterion 4: GODMODE_JB must survive a database *error*, not just
// an empty database.
//
// getSystemPrompts is reached through a re-export chain and cannot be mocked,
// and a DATA_DIR that is unusable at import time crashes the process instead of
// throwing inside resolvePromptForRequest — which is correct fail-fast boot
// behaviour, not the case under test. So this boots against a real temporary
// database, breaks that database while the process is running, and then calls
// the resolver: the shape of a disk filling up, a file truncated, a lock held.
import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sysprompt-db-"));
process.env.GODMODE_JB = "ENV-SURVIVED-DB-ERROR";
process.env.DATA_DIR = dir;

const { resolvePromptForRequest } = await import("./open-sse/rtk/livePrompt.js");

// Sanity: with an intact database and no matching entry, the env prompt is used.
{
  const entry = await resolvePromptForRequest("gr/nusa-9", null);
  if (!entry || entry.prompt !== "ENV-SURVIVED-DB-ERROR") {
    console.error("  FAIL pre-break: env prompt not applied to a healthy database");
    process.exit(1);
  }
  console.log("  ok  healthy database, no matching entry -> env prompt");
}

// Now break the database underneath the running process.
const dbPath = path.join(dir, "db", "data.sqlite");
try {
  fs.writeFileSync(dbPath, "this is not a sqlite database");
  fs.chmodSync(dbPath, 0o000);
} catch (e) {
  console.error(`  FAIL could not break the database: ${e.message}`);
  process.exit(1);
}

let entry = null;
let threw = null;
try {
  entry = await resolvePromptForRequest("gr/nusa-9", null);
} catch (e) {
  threw = e;
}
try { fs.chmodSync(dbPath, 0o644); } catch { /* already gone */ }

if (threw) {
  console.error(`  FAIL db-error: resolvePromptForRequest threw ${threw.code || threw.message}`);
  console.error("       the operator's prompt must survive a database failure, not crash the request");
  process.exit(1);
}
if (!entry) {
  console.error("  FAIL db-error: returned null — the operator prompt was stripped by a database error");
  process.exit(1);
}
if (entry.prompt !== "ENV-SURVIVED-DB-ERROR") {
  console.error(`  FAIL db-error: got ${JSON.stringify(entry.prompt)}`);
  process.exit(1);
}

console.log(`  ok  a database error still yields the env prompt (${entry.label})`);
fs.rmSync(dir, { recursive: true, force: true });
console.log("\n2 passed");