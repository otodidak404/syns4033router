// The CRUD routes behind /dashboard/system-prompt, executed.
//
// Every existing suite on this menu read the route files as text. None imported them,
// and none called GET_handler, POST_handler, PUT_handler or DELETE_handler -- so 179
// lines of validation, duplicate detection and 404 handling had never run. This drives
// them against a real database.
//
// It imports the compiled routes out of dist, because that is what buildAutoRouter
// loads at runtime -- importing the .ts sources would prove something different.
// It runs under bin/alias-loader.mjs because the routes import through "@/...".

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-crud-"));
process.env.DATA_DIR = dir;

const { GET, POST_handler } = await import(path.join(HERE, "dist/routes/system-prompts/route.js"));
const ONE = await import(path.join(HERE, "dist/routes/system-prompts/[id]/route.js"));
const { GET_handler: GET_ONE, PUT_handler, DELETE_handler } = ONE;

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });

// A response recorder, so the status and body come from the handler itself rather than
// from anything this file decides. The record is created on demand: handlers chain
// res.status(n).json(x), so there is no first call to hang the record off.
function recorder() {
  // Express defaults a bare res.json() to 200, so the recorder has to as well -- three
  // assertions read undefined and failed until this did.
  let rec = { status: 200 };
  const res = {
    status(code) { rec.status = code; return res; },
    json(body) { rec.body = body; return res; },
    end() { return res; },
    set() { return res; },
    header() { return res; },
  };
  return { res, take: () => rec || {} };
}
async function call(fn, req) {
  const { res, take } = recorder();
  await fn(req, res, req);
  return take();
}

t("POST stores an entry and answers 201 with it", async () => {
  const { status, body } = await call(POST_handler, {
    body: { label: "My persona", model: "oc/m1", prompt: "Be terse.", isActive: true, isLive: true },
  });
  assert.equal(status, 201, `expected 201, got ${status}`);
  assert.equal(body.label, "My persona");
  assert.equal(body.model, "oc/m1");
  assert.ok(body.id, "the stored entry has no id");
});

t("GET lists what POST stored", async () => {
  const { status, body } = await call(GET, {});
  assert.equal(status, 200);
  assert.ok(body.entries.some((e) => e.label === "My persona"), "the entry is not in the list");
  assert.equal(body.total, body.entries.length);
  assert.equal(body.live, 1, "the live count does not match the stored isActive/isLive");
});

t("POST refuses a second entry for the same model", async () => {
  const { status, body } = await call(POST_handler, {
    body: { label: "Duplicate", model: "oc/m1", prompt: "Again." },
  });
  assert.equal(status, 400);
  assert.match(body.error, /already exists/i);
});

t("POST rejects each missing or malformed field", async () => {
  const cases = [
    [{ model: "oc/x", prompt: "p" }, /label/i],
    [{ label: "l", prompt: "p" }, /model/i],
    [{ label: "l", model: "oc/x" }, /prompt/i],
    [{ label: "l", model: "oc/x", prompt: "   " }, /prompt/i],
    [{ label: "l", model: "", prompt: "p" }, /model/i],
    [{ label: "l", model: "oc/x", prompt: "p".repeat(200_001) }, /too large/i],
    [{ label: "l".repeat(201), model: "oc/x", prompt: "p" }, /too long/i],
  ];
  for (const [body, want] of cases) {
    const { status, body: got } = await call(POST_handler, { body });
    assert.equal(status, 400, `${JSON.stringify(body).slice(0, 40)} was accepted`);
    assert.match(got.error, want, `${JSON.stringify(body).slice(0, 40)} → "${got.error}"`);
  }
});

t("POST rejects a model carrying control characters", async () => {
  const { status } = await call(POST_handler, {
    body: { label: "l", model: "oc/x\u0000evil", prompt: "p" },
  });
  assert.equal(status, 400, "a NUL in the model id was accepted");
});

t("GET one returns the entry, and 404s for an unknown id", async () => {
  const list = await call(GET, {});
  const id = list.body.entries[0].id;
  const found = await call(GET_ONE, { params: Promise.resolve({ id }) });
  assert.equal(found.status, 200);
  assert.equal(found.body.id, id);
  const missing = await call(GET_ONE, { params: Promise.resolve({ id: "no-such-id" }) });
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /not found/i);
});

t("PUT applies each editable field", async () => {
  const list = await call(GET, {});
  const id = list.body.entries[0].id;
  const { status, body } = await call(PUT_handler, {
    params: Promise.resolve({ id }),
    body: { label: "Renamed", prompt: "Now verbose.", isActive: false, isLive: false },
  });
  assert.equal(status, 200);
  assert.equal(body.label, "Renamed");
  assert.equal(body.prompt, "Now verbose.");
  assert.equal(body.isActive, false);
  assert.equal(body.isLive, false);
});

t("PUT refuses a non-boolean toggle", async () => {
  const list = await call(GET, {});
  const id = list.body.entries[0].id;
  for (const bad of [{ isActive: "false" }, { isLive: 1 }, { isActive: null }]) {
    const { status } = await call(PUT_handler, { params: Promise.resolve({ id }), body: bad });
    assert.equal(status, 400, `${JSON.stringify(bad)} was accepted`);
  }
});

t("PUT moving an entry onto an occupied model is refused", async () => {
  await call(POST_handler, { body: { label: "Second", model: "oc/m2", prompt: "p" } });
  const list = await call(GET, {});
  const first = list.body.entries.find((e) => e.model === "oc/m1");
  const { status, body } = await call(PUT_handler, {
    params: Promise.resolve({ id: first.id }),
    body: { model: "oc/m2" },
  });
  assert.equal(status, 400);
  assert.match(body.error, /already exists/i);
});

t("PUT to its own model is allowed", async () => {
  const list = await call(GET, {});
  const first = list.body.entries.find((e) => e.model === "oc/m1");
  const { status } = await call(PUT_handler, {
    params: Promise.resolve({ id: first.id }), body: { model: "oc/m1" },
  });
  assert.equal(status, 200, "an entry cannot keep its own model");
});

t("PUT on an unknown id is a 404", async () => {
  const { status } = await call(PUT_handler, {
    params: Promise.resolve({ id: "nope" }), body: { label: "x" },
  });
  assert.equal(status, 404);
});

t("DELETE removes the entry and is 404 the second time", async () => {
  const list = await call(GET, {});
  const id = list.body.entries.find((e) => e.model === "oc/m2").id;
  const first = await call(DELETE_handler, { params: Promise.resolve({ id }) });
  assert.equal(first.status, 200);
  assert.equal(first.body.success, true);
  const again = await call(DELETE_handler, { params: Promise.resolve({ id }) });
  assert.equal(again.status, 404);
  const after = await call(GET, {});
  assert.ok(!after.body.entries.some((e) => e.id === id), "the row survived the delete");
});

async function drainAsync() {
  for (const { name, fn } of queue) {
    try { await fn(); pass++; console.log(`  ok   ${name}`); }
    catch (e) { process.exitCode = 1; console.log(`  FAIL ${name}\n       ${e?.message || e}`); }
  }
  console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
await drainAsync();