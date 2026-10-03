// Regression for the three components the STT page renders but nothing covered.
//
//   /dashboard/media-providers/stt/[id] mounts, in order:
//     NoAuthProxyCard or ConnectionsCard   (providers/components)
//     ModelsCard                            (kindFilter="stt")
//     ProviderInfoCard, SttExampleCard
//
// A changelog entry for d276325 claimed ConnectionsCard had been fixed. The test
// written for that work never mentioned it — the string "ConnectionsCard" does not
// appear in test-providers-page.mjs at all. Both components are 300-600 lines of
// writer code reachable from every media-provider detail page, including STT, and
// were unchecked.
//
// The rule is mechanical: a write must not be able to reach the next statement on
// failure. fetch() rejects only on a network error, so a 400/404/409 is a resolved
// promise and every `if (res.ok) { ... }` with no else is a write that reports
// success while the server refused it.
//
// Every check below walks lines rather than pattern-matching whole blocks: this
// file has three fetches to /api/settings and the same URL twice for reads and
// writes, and a regex over it kept asserting against the wrong occurrence.

import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FE = path.join(HERE, "..", "frontend", "src");
const read = (...p) => fs.readFileSync(path.join(FE, ...p), "utf8");

const conn = read("pages", "providers", "components", "ConnectionsCard.jsx").split("\n");
const models = read("pages", "providers", "components", "ModelsCard.jsx").split("\n");
const list = read("pages", "media-providers", "[kind]", "page.jsx").split("\n");
const detail = read("pages", "media-providers", "[kind]", "[id]", "page.jsx");

let pass = 0;
const pending = [];
const t = (name, fn) => {
  pending.push((async () => {
    try {
      await fn();
      pass++;
      console.log(`  ok   ${name}`);
    } catch (e) {
      process.exitCode = 1;
      console.log(`  FAIL ${name}\n       ${e?.message || e}`);
    }
  })());
};

/** The statement that starts at `from`, spanning until the line that closes it. */
function stmt(lines, from, span = 10) {
  return lines.slice(from, from + span).join("\n");
}

// ── the components really are reachable from the STT page ───────────────────

t("the STT detail page mounts the components this suite covers", () => {
  assert.ok(detail.includes("ConnectionsCard"), "ConnectionsCard is no longer imported");
  assert.ok(detail.includes("ModelsCard"), "ModelsCard is no longer imported");
  const gate = detail.match(
    /\{kind !== "([^"]+)" && kind !== "([^"]+)" && kind !== "([^"]+)" && \(\s*<ModelsCard/);
  assert.ok(gate, "the ModelsCard gate no longer has the shape this assumes");
  for (const excluded of gate.slice(1)) {
    assert.notEqual(excluded, "stt", "stt must not be excluded from ModelsCard");
  }
  assert.ok(detail.includes("<ConnectionsCard providerId={id} isOAuth={false} />"),
    "ConnectionsCard is no longer rendered on the detail page");
});

// ── ConnectionsCard ──────────────────────────────────────────────────────────

t("ConnectionsCard: no write is followed by an unguarded if (res.ok)", () => {
  const offenders = [];
  conn.forEach((line, i) => {
    if (!/const\s+res\s*=\s*await\s+fetch\(/.test(line)) return;
    let j = i + 1;
    while (j < conn.length && !conn[j].trim()) j++;
    const next = (conn[j] || "").trim();
    if (/^if\s*\(res\.ok\)/.test(next)) offenders.push(`${i + 1}→${j + 1}: ${next.slice(0, 70)}`);
  });
  assert.equal(offenders.length, 0,
    `a write whose failure is invisible:\n       ${offenders.join("\n       ")}`);
});

t("ConnectionsCard: every mutation is chained through expectOk", () => {
  const bad = [];
  conn.forEach((line, i) => {
    if (!/method:\s*"(POST|PUT|PATCH|DELETE)"/.test(line)) return;
    // The key-probe POST is a read that reports through setValidationResult.
    if (/api\/providers\/validate/.test(stmt(conn, Math.max(0, i - 3), 4))) return;
    const chunk = stmt(conn, Math.max(0, i - 4), 12);
    if (!/fetch\(/.test(chunk)) return;
    if (!/\.then\(expectOk\)/.test(chunk)) bad.push(`${i + 1}: ${line.trim().slice(0, 64)}`);
  });
  assert.equal(bad.length, 0,
    `mutation without expectOk:\n       ${[...new Set(bad)].join("\n       ")}`);
});

t("ConnectionsCard: a failed settings read cannot wipe the strategy map", () => {
  // The bug: `res.ok ? await res.json() : {}` turned a failed read into an empty
  // map, and providerStrategies is then PATCHed wholesale -- so one 500 while
  // saving a fallback strategy erased every other provider's strategy.
  assert.ok(!/res\.ok\s*\?\s*await\s*res\.json\(\)\s*:\s*\{\}/.test(conn.join("\n")),
    "the empty-object fallback that caused the wipe is back");

  const wAt = conn.findIndex((l) => l.includes("providerStrategies: updated"));
  assert.ok(wAt > 0, "the strategy write disappeared");

  let readAt = -1;
  for (let k = wAt; k >= 0; k--) {
    if (!conn[k].includes('fetch("/api/settings"')) continue;
    if (conn[k].includes('"PATCH"')) continue;
    readAt = k;
    break;
  }
  assert.ok(readAt >= 0, "no settings read before the strategy write");

  const readStmt = stmt(conn, readAt, 3);
  assert.ok(/cache:\s*"no-store"/.test(readStmt),
    `the read before the write is not the strategy read: ${readStmt.slice(0, 76)}`);
  assert.ok(/expectOk/.test(readStmt),
    `the strategy read is not guarded: ${readStmt.slice(0, 92)}`);
  assert.ok(/expectOk/.test(stmt(conn, wAt, 3)), "the strategy PATCH is not guarded");
});

t("ConnectionsCard: a rejected write is shown, not logged", () => {
  const joined = conn.join("\n");
  assert.ok(/const \[actionError, setActionError\] = useState/.test(joined),
    "there is no error state");
  assert.ok(/\{\s*actionError\s*&&/.test(joined), "the error state is never rendered");
  const sets = (joined.match(/setActionError\(/g) || []).length;
  assert.ok(sets >= 10, `only ${sets} setActionError calls`);
  const logged = conn.filter((l) => /console\.log\("[a-z ]*error/.test(l));
  assert.equal(logged.length, 0,
    `an error is still only written to the console:\n       ${logged.join("\n       ")}`);
});

t("ConnectionsCard: reordering surfaces the failure it already rolls back", () => {
  const i = conn.findIndex((l) => l.includes("handleSwapPriority"));
  assert.ok(i > 0, "handleSwapPriority not found");
  const chunk = stmt(conn, i, 30);
  assert.ok(/\.then\(expectOk\)/.test(chunk), "the swap does not reject on an HTTP failure");
  assert.ok(/await fetch_\(\)/.test(chunk), "the rollback was removed");
  // The message itself, not just any setActionError: a neighbouring handler's
  // setActionError("") used to satisfy this assertion when the swap's own line
  // was deleted, which is why the mutation control stayed green once.
  assert.ok(/Reorder failed/.test(chunk),
    "the swap rolls back silently, so a refused reorder looks like nothing happened");
});

// ── ModelsCard ───────────────────────────────────────────────────────────────

t("ModelsCard: no write is followed by an unguarded if (res.ok)", () => {
  const offenders = [];
  models.forEach((line, i) => {
    if (!/^\s*const res = await fetch\(/.test(line)) return;
    const next = (models[i + 1] || "").trim();
    if (/^if\s*\(res\.ok\)/.test(next)) offenders.push(`${i + 1}: ${next.slice(0, 70)}`);
  });
  assert.equal(offenders.length, 0,
    `a write whose failure is invisible:\n       ${offenders.join("\n       ")}`);
});

t("ModelsCard: alias and custom-model writes reject and report", () => {
  const wanted = [
    { url: "/api/models/alias", method: "PUT" },
    { url: "/api/models/alias?alias=", method: "DELETE" },
    { url: "/api/models/custom", method: "POST" },
    { url: "/api/models/custom?", method: "DELETE" },
  ];
  for (const { url, method } of wanted) {
    let found = null;
    for (let k = 0; k < models.length; k++) {
      if (!models[k].includes(`method: "${method}"`)) continue;
      const from = Math.max(0, k - 3);
      const window = stmt(models, from, 12);
      if (!/fetch\(/.test(window) || !window.includes(url)) continue;
      found = window;
      break;
    }
    assert.ok(found, `no ${method} write for ${url}`);
    assert.ok(found.includes(".then(expectOk)"), `${url} ${method} does not reject on failure`);
    assert.ok(found.includes("setActionError"), `${url} ${method} never surfaces a failure`);
  }
});

t("ModelsCard: it imports expectOk rather than assuming it", () => {
  assert.ok(/import \{ expectOk \} from "@\/shared\/utils\/api"/.test(models.join("\n")),
    "expectOk is used but not imported");
});

t("ModelsCard: a non-JSON error body does not crash the model test", () => {
  const i = models.findIndex((l) => l.includes("/api/models/test"));
  assert.ok(i > 0, "the model test fetch not found");
  const chunk = stmt(models, i, 12);
  assert.ok(/res\.json\(\)\.catch\(/.test(chunk),
    "handleTestModel parses the body unguarded, so a 500 with a non-JSON body throws");
});

t("ModelsCard: the action error is rendered", () => {
  assert.ok(/\{\s*actionError\s*&&/.test(models.join("\n")),
    "ModelsCard collects errors into state but never shows them");
});

// ── the media-provider list, which the STT list page is ─────────────────────

t("the list reports a failed read instead of rendering an empty page", () => {
  const joined = list.join("\n");
  assert.ok(/const \[loadErrors, setLoadErrors\] = useState/.test(joined),
    "the list page has no load-error state");
  assert.ok(/\{\s*loadErrors\.length > 0 &&/.test(joined),
    "the load error is never rendered");
  for (const url of ["/api/providers", "/api/provider-nodes", "/api/combos"]) {
    assert.ok(joined.includes(`readJson("${url}"`), `no read for ${url}`);
  }
  assert.ok(/if \(!res\.ok\) \{/.test(joined),
    "the read never checks res.ok, so a 500 with a JSON body looks like data");
  const swallow = list
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /\.catch\(\(\) => \{\}\)/.test(l) && !/^\s*\/\//.test(l));
  assert.equal(swallow.length, 0,
    `the list still swallows a failure:\n       ${swallow.map(([n]) => n).join(", ")}`);
});

t("an empty list and a failed list are not the same thing", () => {
  const joined = list.join("\n");
  assert.ok(/Status unknown/.test(joined),
    "a card cannot distinguish 'no connections' from 'could not load'");
  assert.ok(/if \(connectionsLoaded === false\) return;/.test(joined),
    "the toggle still fires against a list that was never loaded");
  assert.ok(/connectionsLoaded=\{!loadErrors\.some\(/.test(joined),
    "the flag is never passed to the card");
});

Promise.all(pending).then(() =>
  console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`));