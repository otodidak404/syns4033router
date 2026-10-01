// Action audit — exercises each page's core behaviour against a deployed
// instance, not just that it renders. Every check performs a real mutation and
// verifies the persisted result, then cleans up after itself.
//
//   node scripts/audit/action-audit.mjs   <baseUrl> <password>
//
// Requires Playwright on the machine: npm install --no-save playwright
import { chromium } from "playwright";

const BASE = process.argv[2];
const PW = process.argv[3];

if (!BASE || !PW) {
  console.error("usage: node action-audit.mjs <baseUrl> <password>");
  process.exit(2);
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  ignoreHTTPSErrors: true,
});
const page = await ctx.newPage();

// Playwright's APIResponse exposes status()/json() as methods.
const api = async (path, opts) => ctx.request.fetch(`${BASE}${path}`, opts);
const getJson = async (path) => (await api(path)).json();

await api("/api/auth/login", { method: "POST", data: { password: PW } });
await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => localStorage.setItem("9r_authed", "1"));

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${name}\n         ${String(e.message).split("\n")[0].slice(0, 150)}`);
    fail++;
  }
};
const go = async (p) => {
  await page.goto(`${BASE}/dashboard/${p}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
};
const confirmClick = async () => {
  await page.getByRole("button", { name: /Delete|Confirm|Yes/i }).last().click();
  await page.waitForTimeout(1400);
};

// ── System Prompt ──────────────────────────────────────────────────────────
console.log("System Prompt");
let spId = null;

// Clear leftovers from a previous run so this is safe to run repeatedly.
await api("/api/system-prompts").then(async (r) => {
  const { entries = [] } = await r.json().catch(() => ({}));
  for (const e of entries.filter((x) => x.model === "audit/model-a")) {
    await api(`/api/system-prompts/${e.id}`, { method: "DELETE" });
  }
});

await check("create a system prompt", async () => {
  const r = await api("/api/system-prompts", {
    method: "POST",
    data: {
      label: "audit-jb", model: "audit/model-a",
      prompt: "<project_instructions>\naudit persona\n</project_instructions>",
      isActive: true, isLive: true,
    },
  });
  if (r.status() !== 201) throw new Error(`status ${r.status()} body=${await r.text()}`);
  spId = (await r.json()).id;
});

await check("it renders with a LIVE badge", async () => {
  await go("system-prompt");
  const t = await page.evaluate(() => document.body.innerText);
  if (!t.includes("audit-jb")) throw new Error("label not rendered");
  if (!t.includes("LIVE")) throw new Error("no LIVE badge");
});

await check("Aktif toggle persists", async () => {
  await go("system-prompt");
  const row = page.locator("div").filter({ hasText: /^audit-jb/ }).first();
  await row.locator('[role="switch"]').first().click();
  await page.waitForTimeout(1200);
  const { entries } = await getJson("/api/system-prompts");
  if (entries.find((e) => e.id === spId)?.isActive !== false) throw new Error("isActive did not flip");
});

await check("live toggle persists", async () => {
  await go("system-prompt");
  const row = page.locator("div").filter({ hasText: /^audit-jb/ }).first();
  await row.locator('[role="switch"]').nth(1).click();
  await page.waitForTimeout(1200);
  const { entries } = await getJson("/api/system-prompts");
  if (entries.find((e) => e.id === spId)?.isLive !== false) throw new Error("isLive did not flip");
});

await check("Playground tab renders", async () => {
  await go("system-prompt");
  await page.getByRole("button", { name: /Playground/i }).first().click();
  await page.waitForTimeout(900);
  const t = await page.evaluate(() => document.body.innerText);
  if (!/Playground|Run preview|Test input/i.test(t)) throw new Error("playground did not render");
});

await check("edit saves through the panel", async () => {
  await go("system-prompt");
  await page.getByRole("button", { name: /Edit/i }).first().click();
  await page.waitForTimeout(800);
  await page.locator("textarea").first().fill("<project_instructions>\nedited by audit\n</project_instructions>");
  await page.getByRole("button", { name: /^Save$/i }).first().click();
  await page.waitForTimeout(1500);
  const { entries } = await getJson("/api/system-prompts");
  if (!entries.find((e) => e.id === spId)?.prompt.includes("edited by audit")) throw new Error("edit not saved");
});

await check("delete removes it", async () => {
  await go("system-prompt");
  await page.getByRole("button", { name: /Hapus/i }).first().click();
  await page.waitForTimeout(700);
  await confirmClick();
  const { entries } = await getJson("/api/system-prompts");
  if (entries.find((e) => e.id === spId)) throw new Error("still present");
});

// ── Skills ─────────────────────────────────────────────────────────────────
console.log("Skills");
let msId = null;

await api("/api/model-skills").then(async (r) => {
  const { assignments = [] } = await r.json().catch(() => ({}));
  for (const a of assignments.filter((x) => x.model === "audit/model-a")) {
    await api(`/api/model-skills/${a.id}`, { method: "DELETE" });
  }
});

await check("assign a skill to a model", async () => {
  const r = await api("/api/model-skills", {
    method: "POST",
    data: { model: "audit/model-a", skillId: "9router-chat" },
  });
  if (r.status() !== 201) throw new Error(`status ${r.status()} body=${await r.text()}`);
  msId = (await r.json()).id;
});

await check("assignment shows as a model chip", async () => {
  await go("skills");
  const t = await page.evaluate(() => document.body.innerText);
  if (!t.includes("audit/model-a")) throw new Error("model chip missing");
  if (!/Live on 1/i.test(t)) throw new Error("no live badge");
});

await check("chip toggle persists", async () => {
  await go("skills");
  await page.locator('[role="switch"]').first().click();
  await page.waitForTimeout(1200);
  const { assignments } = await getJson("/api/model-skills");
  if (assignments.find((a) => a.id === msId)?.isActive !== false) throw new Error("toggle did not persist");
});

await check("unassign removes it", async () => {
  await go("skills");
  await page.locator('button[title="Remove assignment"]').first().click();
  await page.waitForTimeout(700);
  await confirmClick();
  const { assignments } = await getJson("/api/model-skills");
  if (assignments.find((a) => a.id === msId)) throw new Error("still assigned");
});

// ── Endpoint settings ──────────────────────────────────────────────────────
console.log("Endpoint settings");

for (const [label, key, index] of [["RTK toggle", "rtkEnabled", 0], ["Caveman toggle", "cavemanEnabled", 1]]) {
  await check(`${label} persists`, async () => {
    await go("endpoint");
    const before = (await getJson("/api/settings"))[key];
    await page.locator('[role="switch"]').nth(index).click();
    await page.waitForTimeout(1300);
    const after = (await getJson("/api/settings"))[key];
    await api("/api/settings", { method: "PATCH", data: { [key]: before } });
    if (before === after) throw new Error(`${key} did not change`);
  });
}

// ── Combos ─────────────────────────────────────────────────────────────────
console.log("Combos");

await check("create a combo, then delete it", async () => {
  await go("combos");
  await page.getByRole("button", { name: /Create Combo/i }).first().click();
  await page.waitForTimeout(800);
  await page.locator('input[placeholder="my-combo"]').first().fill("audit-combo");
  await page.getByRole("button", { name: /^Create$/i }).last().click();
  await page.waitForTimeout(1500);
  const { combos } = await getJson("/api/combos");
  const created = combos.find((c) => c.name === "audit-combo");
  if (!created) throw new Error("combo not created");
  await api(`/api/combos/${created.id}`, { method: "DELETE" });
});

// ── Header titles ──────────────────────────────────────────────────────────
console.log("Header");

for (const [path, expect] of [
  ["system-prompt", "System Prompt"],
  ["automation", "Automation"],
  ["docs", "Docs"],
  ["basic-chat", "Basic Chat"],
  ["skills", "Skills"],
]) {
  await check(`title on /${path}`, async () => {
    await go(path);
    const h = await page.evaluate(() => {
      // The sidebar brand is the first h1; the page title sits in the header.
      const inHeader = document.querySelector("main h1") ||
        [...document.querySelectorAll("h1")].find((e) => !e.closest("aside, nav"));
      return inHeader ? inHeader.innerText.trim() : "";
    });
    if (!h.includes(expect)) throw new Error(`got "${h}"`);
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);