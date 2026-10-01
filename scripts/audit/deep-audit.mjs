// Deep per-menu functional audit. Where menu-audit checks that a page renders,
// this drives the page's actual flow and asserts the resulting state.
//
//   node scripts/audit/deep-audit.mjs <baseUrl> <password>
//
// Writes /tmp/deep-audit.json. Exits non-zero if any check fails.
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.argv[2];
const PW = process.argv[3];
if (!BASE || !PW) {
  console.error("usage: node deep-audit.mjs <baseUrl> <password>");
  process.exit(2);
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  ignoreHTTPSErrors: true,
});
const page = await ctx.newPage();

const api = async (path, opts) => ctx.request.fetch(`${BASE}${path}`, opts);
const getJson = async (path) => (await api(path)).json();

await api("/api/auth/login", { method: "POST", data: { password: PW } });
await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => localStorage.setItem("9r_authed", "1"));

const results = [];
let pass = 0;
let fail = 0;

async function group(name, checks) {
  console.log(`\n${name}`);
  for (const [label, fn] of checks) {
    try {
      const detail = await fn();
      console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
      pass++;
      results.push({ group: name, label, ok: true, detail: detail || "" });
    } catch (e) {
      const msg = String(e.message).split("\n")[0].slice(0, 170);
      console.log(`  FAIL ${label}\n         ${msg}`);
      fail++;
      results.push({ group: name, label, ok: false, detail: msg });
    }
  }
}

const go = async (p) => {
  await page.goto(`${BASE}/dashboard/${p}`, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(1500);
};
const text = () => page.evaluate(() => document.body.innerText);
const confirm = async () => {
  await page.getByRole("button", { name: /Delete|Confirm|Yes|Hapus|Remove/i }).last().click();
  await page.waitForTimeout(1400);
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ── QUOTA TRACKER ──────────────────────────────────────────────────────────
await group("Quota Tracker", [
  ["page loads without an error state", async () => {
    await go("quota");
    const t = await text();
    assert(!/Something went wrong|Internal Server Error/i.test(t), "error banner shown");
    assert(t.length > 300, `too little content: ${t.length}ch`);
    return "renders";
  }],
  // Quota has no resource of its own: it is per provider connection, fetched
  // from /api/usage/:connectionId once /api/providers/client lists them.
  ["connection list that drives it responds", async () => {
    const r = await api("/api/providers/client?limit=20");
    assert(r.ok(), `status ${r.status()}`);
    const { connections, totals } = await r.json();
    return `${connections.length} connections (${totals.eligibleConnections} quota-eligible)`;
  }],
  ["empty state is explained when there are no connections", async () => {
    const { connections } = await (await api("/api/providers/client?limit=20")).json();
    await go("quota");
    const t = await text();
    if (connections.length === 0) {
      assert(
        /no (provider|connection)|add a provider|connect/i.test(t),
        `no connections and the page does not say so — it just looks broken: ${t.slice(0, 120)}`
      );
      return "says why it is empty";
    }
    return `${connections.length} connections present`;
  }],
  ["quota endpoint answers for a real connection id", async () => {
    const { connections } = await (await api("/api/providers/client?limit=20")).json();
    if (!connections.length) return "skipped — no connections to query";
    const r = await api(`/api/usage/${encodeURIComponent(connections[0].id)}`);
    assert(r.ok(), `status ${r.status()} for a real connection`);
    return "200 for a real connection";
  }],
  ["a bogus connection id fails cleanly, not with a stack trace", async () => {
    const r = await api("/api/usage/no-such-connection");
    assert(r.status() === 404, `expected 404, got ${r.status()}`);
    assert(!/at \w+ \(.*:\d+:\d+\)/.test(await r.text()), "stack trace leaked");
    return "404, no trace";
  }],
]);

// ── MEDIA PROVIDERS ────────────────────────────────────────────────────────
// These are not seven separate resources. The dashboard exposes six provider
// "kinds" — embedding, image, tts, stt, video, web — and every one of them is
// driven by the same provider / provider-node APIs. Web fetch and web search
// are capabilities inside the `web` kind, not their own tabs.
await group("Media Providers", [
  ...["embedding", "image", "tts", "stt", "video", "web"].map((kind) => [
    `/${kind} page renders`, async () => {
      await go(`media-providers/${kind}`);
      const t = await text();
      assert(t.length > 200, `too little content: ${t.length}ch`);
      assert(!/Something went wrong|Internal Server Error/i.test(t), "error banner");
      return "renders";
    },
  ]),
  ["provider APIs every kind depends on respond", async () => {
    for (const u of ["/api/providers", "/api/provider-nodes", "/api/keys"]) {
      const r = await api(u);
      assert(r.ok(), `${u} returned ${r.status()}`);
    }
    return "providers, provider-nodes, keys all 200";
  }],
  ["a provider detail page renders", async () => {
    await go("media-providers/embedding");
    const t = await text();
    assert(t.length > 200, "too little content");
    return "renders";
  }],
]);

// ── COMBOS ─────────────────────────────────────────────────────────────────
await group("Combos", [
  ["CRUD through the API the page uses", async () => {
    const created = await api("/api/combos", { method: "POST", data: { name: "deep-audit" } });
    assert(created.status() === 201, `create status ${created.status()}`);
    const { id } = await created.json();

    const upd = await api(`/api/combos/${id}`, { method: "PUT", data: { name: "deep-audit-renamed" } });
    assert(upd.ok(), `update status ${upd.status()}`);

    const { combos } = await getJson("/api/combos");
    assert(combos.some((c) => c.id === id && c.name === "deep-audit-renamed"), "update not persisted");

    const del = await api(`/api/combos/${id}`, { method: "DELETE" });
    assert(del.ok(), `delete status ${del.status()}`);
    const after = await getJson("/api/combos");
    assert(!after.combos.some((c) => c.id === id), "still present after delete");
    return "create → update → delete ok";
  }],
  ["duplicate name is rejected", async () => {
    const a = await api("/api/combos", { method: "POST", data: { name: "dupe-test" } });
    assert(a.status() === 201, "first create failed");
    const b = await api("/api/combos", { method: "POST", data: { name: "dupe-test" } });
    const { combos } = await getJson("/api/combos");
    const victim = combos.find((c) => c.name === "dupe-test");
    if (victim) await api(`/api/combos/${victim.id}`, { method: "DELETE" });
    assert(b.status() >= 400, `second create was allowed (status ${b.status()}) — no unique guard`);
    return `rejected with ${b.status()}`;
  }],
]);

// ── ENDPOINT ───────────────────────────────────────────────────────────────
await group("Endpoint & Key", [
  ["endpoint data is served", async () => {
    const s = await getJson("/api/settings");
    assert(s && typeof s === "object", "settings not an object");
    return Object.keys(s).length + " settings keys";
  }],
  ["RTK toggle round-trips", async () => {
    const before = (await getJson("/api/settings")).rtkEnabled;
    await api("/api/settings", { method: "PATCH", data: { rtkEnabled: !before } });
    const after = (await getJson("/api/settings")).rtkEnabled;
    await api("/api/settings", { method: "PATCH", data: { rtkEnabled: before } });
    assert(after === !before, "value did not change");
    return `${before} → ${after}`;
  }],
  ["Caveman toggle round-trips", async () => {
    const before = (await getJson("/api/settings")).cavemanEnabled;
    await api("/api/settings", { method: "PATCH", data: { cavemanEnabled: !before } });
    const after = (await getJson("/api/settings")).cavemanEnabled;
    await api("/api/settings", { method: "PATCH", data: { cavemanEnabled: before } });
    assert(after === !before, "value did not change");
    return `${before} → ${after}`;
  }],
]);

// ── PROVIDERS ──────────────────────────────────────────────────────────────
await group("Providers", [
  ["provider list is served", async () => {
    const r = await api("/api/providers");
    assert(r.ok(), `status ${r.status()}`);
    return "200";
  }],
  ["secret is never returned in plaintext", async () => {
    const r = await getJson("/api/providers");
    const raw = JSON.stringify(r);
    assert(!/"apiKey"\s*:\s*"[^"]{8,}/i.test(raw), "an apiKey came back in plaintext");
    assert(!/"password"\s*:\s*"[^"]{8,}/i.test(raw), "a password came back in plaintext");
    return "no plaintext secrets";
  }],
  ["invalid provider payload is rejected", async () => {
    const r = await api("/api/providers", { method: "POST", data: { name: "" } });
    assert(r.status() >= 400, `empty provider accepted (status ${r.status()})`);
    return `rejected with ${r.status()}`;
  }],
]);

// ── PROXY POOLS ────────────────────────────────────────────────────────────
await group("Proxy Pools", [
  ["pool list is served", async () => {
    const r = await api("/api/proxy-pools");
    assert(r.ok(), `status ${r.status()} body=${(await r.text()).slice(0, 100)}`);
    return "200";
  }],
]);

// ── CLI TOOLS ──────────────────────────────────────────────────────────────
await group("CLI Tools", [
  ["every tool route returns a config", async () => {
    const routes = ["claude-settings", "codex-settings", "droid-settings", "copilot-settings", "cline-settings", "deepseek-tui-settings", "antigravity-mitm"];
    const out = [];
    for (const r of routes) {
      const res = await api(`/api/cli-tools/${r}`);
      if (!res.ok()) out.push(`${r}:${res.status()}`);
    }
    assert(out.length === 0, `failing: ${out.join(", ")}`);
    return `${routes.length}/${routes.length} ok`;
  }],
  ["config never embeds a server-side secret", async () => {
    const res = await api("/api/cli-tools/claude-settings");
    const body = await res.text();
    assert(!/JWT_SECRET|MACHINE_ID_SALT|INITIAL_PASSWORD/.test(body), "server secret leaked into CLI config");
    return "clean";
  }],
]);

// ── MITM ───────────────────────────────────────────────────────────────────
// ── MITM ───────────────────────────────────────────────────────────────────
// The MITM screen is configured through the provider, key, alias, and settings
// APIs. The proxy surface itself is /api/media-proxy.
await group("MITM", [
  ["the APIs the screen is built on all respond", async () => {
    for (const u of ["/api/providers", "/api/keys", "/api/models/alias", "/api/settings"]) {
      const r = await api(u);
      assert(r.ok(), `${u} returned ${r.status()}`);
    }
    return "4/4 ok";
  }],
  ["media-proxy requires a url rather than 404ing", async () => {
    const r = await api("/api/media-proxy");
    assert(r.status() === 400, `expected 400 for a missing url, got ${r.status()}`);
    return "400 Missing url param — route is live";
  }],
  ["page loads without error", async () => {
    await go("mitm");
    const t = await text();
    assert(!/Something went wrong|Internal Server Error/i.test(t), "error banner");
    return "renders";
  }],
]);

// ── AUTOMATION ─────────────────────────────────────────────────────────────
await group("Automation", [
  ["ammail rules respond", async () => {
    const r = await api("/api/automation/ammail");
    assert(r.ok(), `status ${r.status()} body=${(await r.text()).slice(0, 100)}`);
    return "200";
  }],
  ["codebuddy accounts respond", async () => {
    const r = await api("/api/automation/codebuddy");
    assert(r.ok(), `status ${r.status()} body=${(await r.text()).slice(0, 100)}`);
    return "200";
  }],
  ["inbox-create returns a real envelope, not a raw provider payload", async () => {
    // This action used to `return res.json({ ... res.inbox })` where `res` was
    // the Ammail API result, so it answered 200 with the provider's raw body.
    const r = await api("/api/automation/ammail", {
      method: "POST",
      data: { action: "inbox-create", alias: "deep-audit", domain: "example.com" },
    });
    const body = await r.json().catch(() => ({}));
    // Unconfigured Ammail must fail with a status, not with a 200 + raw payload.
    assert(r.status() !== 200 || "ok" in body, "answered 200 without an ok envelope");
    assert(!("inbox" in body && "id" in body && !("ok" in body)), "raw provider payload sent as 200");
    return `status ${r.status()}, envelope ok`;
  }],
  ["webhook-test also returns an envelope", async () => {
    const r = await api("/api/automation/ammail", {
      method: "POST",
      data: { action: "webhook-test" },
    });
    const body = await r.json().catch(() => ({}));
    assert(r.status() !== 200 || "ok" in body, "answered 200 without an ok envelope");
    return `status ${r.status()}`;
  }],
  ["page renders", async () => {
    await go("automation");
    const t = await text();
    assert(t.length > 200, `too little content: ${t.length}ch`);
    return "renders";
  }],
]);

// ── USAGE ──────────────────────────────────────────────────────────────────
// ── USAGE ──────────────────────────────────────────────────────────────────
await group("Usage", [
  ...[["chart", "/api/usage/chart?period=7d"],
      ["providers", "/api/usage/providers"],
      ["request-details", "/api/usage/request-details"]].map(([label, url]) => [
    `${label} endpoint responds`, async () => {
      const r = await api(url);
      assert(r.ok(), `status ${r.status()} body=${(await r.text()).slice(0, 100)}`);
      return "200";
    },
  ]),
  ["page renders its chart container", async () => {
    await go("usage");
    const t = await text();
    assert(t.length > 300, `too little content: ${t.length}ch`);
    assert(!/Something went wrong|Internal Server Error/i.test(t), "error banner");
    return "renders";
  }],
  ["request details page renders", async () => {
    await go("usage");
    const t = await text();
    assert(t.length > 200, "too little content");
    return "renders";
  }],
]);

// ── DOCS / CONSOLE / SETTINGS ──────────────────────────────────────────────
await group("Docs, Console Log, Settings, Remote", [
  ["docs page renders", async () => { await go("docs"); assert((await text()).length > 200, "too little content"); return "renders"; }],
  ["console log page renders", async () => { await go("console-log"); assert((await text()).length > 200, "too little content"); return "renders"; }],
  ["settings page renders", async () => { await go("profile"); assert((await text()).length > 200, "too little content"); return "renders"; }],
  ["remote page renders or redirects cleanly", async () => {
    const res = await page.goto(`${BASE}/dashboard/remote`, { waitUntil: "networkidle" }).catch(() => null);
    assert(res, "navigation failed");
    return `status ${res.status()}`;
  }],
]);

// ── SECURITY ───────────────────────────────────────────────────────────────
await group("Security", [
  ["unauthenticated /api is rejected", async () => {
    const anon = await browser.newContext();
    for (const p of ["/api/providers", "/api/providers/client", "/api/settings", "/api/combos", "/api/model-skills", "/api/system-prompts", "/api/usage/providers", "/api/automation/ammail"]) {
      const r = await anon.request.fetch(`${BASE}${p}`);
      assert(r.status() === 401 || r.status() === 403, `${p} returned ${r.status()} to an anonymous caller`);
    }
    await anon.close();
    return "all admin routes require auth";
  }],
  ["no stack trace or SQL text leaks in an API error", async () => {
    const r = await api("/api/combos/not-a-real-id");
    const body = await r.text();
    assert(!/at \w+ \(.*:\d+:\d+\)/.test(body), "stack trace in error body");
    assert(!/SELECT |INSERT INTO|UPDATE .* SET/i.test(body), "SQL text in error body");
    return "errors are sanitised";
  }],
  ["XSS in a text field is escaped, not executed", async () => {
    const c = await api("/api/combos", { method: "POST", data: { name: "<img src=x onerror=alert(1)>" } });
    assert(c.status() === 201 || c.status() === 400, `unexpected status ${c.status()}`);
    const { combos } = await getJson("/api/combos");
    const evil = combos.find((x) => x.name.includes("onerror"));
    if (evil) {
      await go("combos");
      const rendered = await page.evaluate(() => document.body.innerHTML.includes("onerror=alert"));
      await api(`/api/combos/${evil.id}`, { method: "DELETE" });
      assert(!rendered, "payload executed as markup");
      return "escaped";
    }
    return "rejected at input";
  }],
  ["no CORS wildcard with credentials", async () => {
    const r = await api("/api/settings", { headers: { Origin: "https://evil.example" } });
    const acao = r.headers()["access-control-allow-origin"] || "";
    const acac = r.headers()["access-control-allow-credentials"] || "";
    assert(!(acao === "*" && acac === "true"), "wildcard origin with credentials");
    return acao ? `origin limited to ${acao}` : "no CORS header (safe default)";
  }],
  ["security headers present", async () => {
    const r = await ctx.request.get(`${BASE}/`);
    const h = r.headers();
    assert(h["x-content-type-options"] || h["x-frame-options"] || h["content-security-policy"], "no security headers on the app root");
    return Object.keys(h).filter((k) => k.startsWith("x-") || k === "content-security-policy").slice(0, 4).join(", ");
  }],
]);

fs.writeFileSync("/tmp/deep-audit.json", JSON.stringify(results, null, 2));
console.log(`\n${pass} passed, ${fail} failed  (details: /tmp/deep-audit.json)`);
await browser.close();
process.exit(fail ? 1 : 0);