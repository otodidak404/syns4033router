// Live dashboard audit. Drives a real browser against a deployed instance.
//
//   node scripts/audit/menu-audit.mjs   <baseUrl> <password> [outfile]
//
// Opens every dashboard menu and reports what actually rendered: page title,
// body size, error banners, JS errors, failed network calls, redirects.
// Exit code is non-zero if any menu fails to render.
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.argv[2];
const PW = process.argv[3];
const OUT = process.argv[4] || "/tmp/menu-audit.json";

if (!BASE || !PW) {
  console.error("usage: node menu-audit.mjs <baseUrl> <password> [outfile]");
  process.exit(2);
}

const ROUTES = [
  ["", "Dashboard"],
  ["endpoint", "Endpoint & Key"],
  ["providers", "Providers"],
  ["providers/new", "Add Provider"],
  ["combos", "Combos"],
  ["usage", "Usage"],
  ["quota", "Quota Tracker"],
  ["mitm", "MITM"],
  ["cli-tools", "CLI Tools"],
  ["docs", "Docs"],
  ["media-providers/web", "Media Providers"],
  ["proxy-pools", "Proxy Pools"],
  ["automation", "Automation"],
  ["system-prompt", "System Prompt"],
  ["skills", "Skills"],
  ["console-log", "Console Log"],
  ["translator", "Translator"],
  ["basic-chat", "Basic Chat"],
  ["profile", "Settings"],
];

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  ignoreHTTPSErrors: true,
});
const page = await ctx.newPage();

const login = await ctx.request.post(`${BASE}/api/auth/login`, { data: { password: PW } });
console.log("login:", login.status());
await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => localStorage.setItem("9r_authed", "1"));

const results = [];
for (const [path, label] of ROUTES) {
  const errors = [];
  const failedReqs = [];
  const onConsole = (m) => { if (m.type() === "error") errors.push(String(m.text()).slice(0, 200)); };
  const onPageErr = (e) => errors.push(`pageerror: ${String(e.message).slice(0, 200)}`);
  const onResp = (r) => { if (r.status() >= 400) failedReqs.push(`${r.status()} ${r.url().replace(BASE, "")}`); };
  const onFail = (r) => failedReqs.push(`NETFAIL ${r.url().replace(BASE, "")}`);

  page.on("console", onConsole);
  page.on("pageerror", onPageErr);
  page.on("response", onResp);
  page.on("requestfailed", onFail);

  const rec = { path: path || "/", label, errors: [], failedReqs: [], ok: false };
  try {
    await page.goto(`${BASE}/dashboard${path ? "/" + path : ""}`, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(2500);

    rec.finalUrl = page.url().replace(BASE, "");
    rec.headerTitle = await page.evaluate(() => {
      const inHeader = document.querySelector("main h1") ||
        [...document.querySelectorAll("h1")].find((e) => !e.closest("aside, nav"));
      return inHeader ? inHeader.innerText.trim().slice(0, 60) : "";
    });
    rec.bodyLen = await page.evaluate(() => document.body.innerText.trim().length);
    rec.buttons = await page.locator("button").count();
    rec.switches = await page.locator('[role="switch"]').count();

    const text = await page.evaluate(() => document.body.innerText);
    rec.errorBanner = /Something went wrong|Internal Server Error|Failed to load|Unauthorized|404 Not Found/i.test(text)
      ? text.match(/(Something went wrong|Internal Server Error|Failed to load|Unauthorized|404 Not Found)[^\n]{0,60}/i)?.[0]
      : null;
    rec.redirected = !rec.finalUrl.includes(path === "" ? "/dashboard" : path.split("/")[0]);
    rec.ok = rec.bodyLen > 200 && !rec.errorBanner && errors.length === 0 && !rec.redirected;
  } catch (e) {
    rec.errors.push(`NAV: ${String(e.message).slice(0, 160)}`);
  }

  page.off("console", onConsole);
  page.off("pageerror", onPageErr);
  page.off("response", onResp);
  page.off("requestfailed", onFail);
  rec.errors = [...new Set(rec.errors)];
  rec.failedReqs = [...new Set(rec.failedReqs)].slice(0, 6);
  results.push(rec);

  console.log(`  ${rec.ok ? "ok  " : "FAIL"} ${label.padEnd(20)} ${String(rec.bodyLen || 0).padStart(5)}ch  btn=${rec.buttons || 0}`);
  if (rec.errorBanner) console.log(`       banner: ${rec.errorBanner}`);
  if (rec.redirected) console.log(`       redirected to: ${rec.finalUrl}`);
  for (const e of rec.errors.slice(0, 3)) console.log(`       js: ${e}`);
  for (const f of rec.failedReqs.slice(0, 3)) console.log(`       net: ${f}`);
}

fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} menus OK`);
if (bad.length) console.log("failing: " + bad.map((b) => b.label).join(", "));
console.log("details: " + OUT);
await browser.close();
process.exit(bad.length ? 1 : 0);