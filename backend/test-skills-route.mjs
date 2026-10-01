// Exercises the built dist routes for skills and per-model assignments through an
// Express harness, against a real temp DB. Skill bodies come from the repo's own
// skills/ directory, so this covers disk reads, route validation, and assignment.
import assert from "assert";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

process.env.DATA_DIR = process.env.DATA_DIR || "/tmp/9r-skills-route-harness";

const skillsRoute = await import(path.join(HERE, "dist/routes/skills/route.js"));
const modelSkillsRoute = await import(path.join(HERE, "dist/routes/model-skills/route.js"));
const modelSkillIdRoute = await import(path.join(HERE, "dist/routes/model-skills/[id]/route.js"));

const app = express();
app.use(express.json());
app.get("/api/skills", skillsRoute.GET);
app.get("/api/model-skills", modelSkillsRoute.GET);
app.post("/api/model-skills", modelSkillsRoute.POST_handler);
// Mirror the auto-router: /api/model-skills/:id is its own route file.
app.put("/api/model-skills/:id", (req, res) => modelSkillIdRoute.PUT_handler(req, res, { params: Promise.resolve(req.params) }));
app.delete("/api/model-skills/:id", (req, res) => modelSkillIdRoute.DELETE_handler(req, res, { params: Promise.resolve(req.params) }));

const server = app.listen(0);
await new Promise(r => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const post = (body) => fetch(`${base}/api/model-skills`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

console.log("skills + model-skills routes (dist build)");

await t("GET /api/skills lists the shipped catalogue", async () => {
  const res = await fetch(`${base}/api/skills`);
  assert.strictEqual(res.status, 200);
  const { skills } = await res.json();
  assert.ok(Array.isArray(skills));
  assert.ok(skills.includes("9router") && skills.includes("9router-chat"));
  assert.strictEqual(res.headers.get("cache-control"), "no-store");
});

await t("GET /api/model-skills returns assignments and a catalogue", async () => {
  const { assignments, skills } = await (await fetch(`${base}/api/model-skills`)).json();
  assert.ok(Array.isArray(assignments));
  assert.ok(Array.isArray(skills) && skills.length > 0);
  assert.ok(typeof skills[0].chars === "number", "catalogue reports size");
});

await t("POST assigns a skill to a model", async () => {
  const res = await post({ model: "oc/probe-model", skillId: "9router" });
  assert.strictEqual(res.status, 201);
  const entry = await res.json();
  assert.strictEqual(entry.model, "oc/probe-model");
  assert.strictEqual(entry.skillId, "9router");
  assert.strictEqual(entry.isActive, true);
});

await t("duplicate assignment is rejected", async () => {
  const res = await post({ model: "oc/probe-model", skillId: "9router" });
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /Already assigned/);
});

await t("unknown skill is rejected", async () => {
  const res = await post({ model: "oc/probe-model", skillId: "not-a-real-skill" });
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /not found on disk/);
});

await t("missing model is rejected", async () => {
  assert.strictEqual((await post({ skillId: "9router" })).status, 400);
  assert.strictEqual((await post({ model: "  ", skillId: "9router" })).status, 400);
});

await t("catalogue reflects which models use a skill", async () => {
  const { skills } = await (await fetch(`${base}/api/model-skills`)).json();
  const entry = skills.find(s => s.id === "9router");
  assert.ok(entry.models.includes("oc/probe-model"), "assignment listed");
  assert.ok(entry.activeModels.includes("oc/probe-model"), "and marked active");
});

await t("GET ?skillId= answers which models use one skill", async () => {
  const { models } = await (await fetch(`${base}/api/model-skills?skillId=9router`)).json();
  assert.ok(models.includes("oc/probe-model"));
});

await t("PUT toggles an assignment off and back on", async () => {
  const { assignments } = await (await fetch(`${base}/api/model-skills`)).json();
  const id = assignments.find(a => a.skillId === "9router").id;

  const off = await fetch(`${base}/api/model-skills/${id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isActive: false }),
  });
  assert.strictEqual(off.status, 200);
  assert.strictEqual((await off.json()).isActive, false, "toggle actually persisted");

  const on = await fetch(`${base}/api/model-skills/${id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isActive: true }),
  });
  assert.strictEqual((await on.json()).isActive, true);
});

await t("PUT rejects a non-boolean toggle", async () => {
  const { assignments } = await (await fetch(`${base}/api/model-skills`)).json();
  const id = assignments.find(a => a.skillId === "9router").id;
  const res = await fetch(`${base}/api/model-skills/${id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isActive: "yes" }),
  });
  assert.strictEqual(res.status, 400);
});

await t("PUT on a missing id is 404", async () => {
  const res = await fetch(`${base}/api/model-skills/nope`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isActive: true }),
  });
  assert.strictEqual(res.status, 404);
});

await t("an inactive assignment stops applying", async () => {
  const { assignments } = await (await fetch(`${base}/api/model-skills`)).json();
  const id = assignments.find(a => a.skillId === "9router").id;
  await fetch(`${base}/api/model-skills/${id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isActive: false }),
  });
  const { skills } = await (await fetch(`${base}/api/model-skills`)).json();
  const entry = skills.find(s => s.id === "9router");
  assert.ok(!entry.activeModels.includes("oc/probe-model"), "no longer active");
  await fetch(`${base}/api/model-skills/${id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isActive: true }),
  });
});

await t("DELETE removes it, and twice is 404", async () => {
  const { assignments } = await (await fetch(`${base}/api/model-skills`)).json();
  const id = assignments.find(a => a.skillId === "9router").id;
  assert.strictEqual((await fetch(`${base}/api/model-skills/${id}`, { method: "DELETE" })).status, 200);
  assert.strictEqual((await fetch(`${base}/api/model-skills/${id}`, { method: "DELETE" })).status, 404);
});

server.close();
console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);