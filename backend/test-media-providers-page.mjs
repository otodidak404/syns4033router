// /dashboard/media-providers — five writers, each with a way to fail silently.
//
// The one that mattered: handleToggleRoundRobin read /api/settings, and on a
// failed read fell back to `{}`, then PATCHed `comboStrategies: {}`. Backend
// updateSettings merges shallowly (`{ ...current, ...updates }`), so that write
// replaces the whole map. One failed GET erased every combo's round-robin
// strategy while the toggle still showed as on.
//
// Also: adding or deselecting a combo model moved the chip before the save and
// never rolled it back; the SSE reader dropped an unparseable terminal frame,
// so a failed Test looked like a button that does nothing; and both delete
// handlers navigated or gave up silently.
import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, "..", "frontend", "src", "pages", "media-providers");
const DETAIL = path.join(PAGE, "[kind]", "[id]", "page.jsx");
const COMBO = path.join(PAGE, "combo", "[id]", "page.jsx");
const LIST = path.join(PAGE, "[kind]", "page.jsx");
const SETTINGS_REPO = path.join(HERE, "src", "lib", "db", "repos", "settingsRepo.js");
const PROVIDER_CONSTANTS = path.join(HERE, "..", "frontend", "src", "shared", "constants", "providers.js");
const CATALOG = path.join(HERE, "..", "backend", "open-sse", "config", "providerModels.js");
const NODE_ROUTE = path.join(HERE, "src", "routes", "provider-nodes", "route.ts");
const NODE_ID_ROUTE = path.join(HERE, "src", "routes", "provider-nodes", "[id]", "route.ts");
const MODEL_SERVICE = path.join(HERE, "src", "sse", "services", "model.js");
const MODAL = path.join(HERE, "..", "frontend", "src", "shared", "components", "AddCustomEmbeddingModal.jsx");

let pass = 0;
const pending = [];
const t = (name, fn) => pending.push(
  Promise.resolve().then(fn)
    .then(() => { console.log(`  ok  ${name}`); pass++; })
    .catch((e) => { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }),
);

const detail = fs.readFileSync(DETAIL, "utf8");
const combo = fs.readFileSync(COMBO, "utf8");
const list = fs.readFileSync(LIST, "utf8");
const settingsRepo = fs.readFileSync(SETTINGS_REPO, "utf8");
const constants = fs.readFileSync(PROVIDER_CONSTANTS, "utf8");

/** The body of one named function, brace-matched. */
function fn(src, name) {
  const i = src.indexOf(`const ${name} = async`);
  assert.ok(i > -1, `${name} is gone`);
  const from = src.indexOf("{", src.indexOf("=>", i));
  let depth = 0;
  for (let k = from; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}" && --depth === 0) return src.slice(from, k + 1);
  }
  throw new Error(`${name} is not brace-matched`);
}

t("a failed settings read cannot rewrite the whole strategy map", () => {
  const body = fn(combo, "handleToggleRoundRobin");
  assert.ok(/if\s*\(\s*!settingsRes\.ok\s*\)/.test(body),
    "the read is not checked before the write");
  // The destructive fallback itself: `? json() : {}` turns a failed read into an
  // empty map, and the next line PATCHes it.
  assert.ok(!/settingsRes\.ok\s*\?\s*await\s+settingsRes\.json\(\)\s*:\s*\{\}/.test(body),
    "a failed read still collapses to {} and gets written back");
  assert.ok(/const s = await settingsRes\.json\(\)/.test(body),
    "the settings body is read without checking the status");
});

t("the shallow merge that makes that destructive is still shallow", () => {
  // If this ever becomes a deep merge the frontend guard above stops being the
  // only thing standing between a failed GET and lost config.
  assert.ok(/next\s*=\s*\{\s*\.\.\.current,\s*\.\.\.updates\s*\}/.test(settingsRepo),
    "updateSettings no longer merges shallowly — re-check the frontend guard");
});

t("round-robin only flips once the server has accepted it", () => {
  const body = fn(combo, "handleToggleRoundRobin");
  const writeAt = body.indexOf('method: "PATCH"');
  const flipAt = body.indexOf("setRoundRobin(");
  assert.ok(writeAt > -1 && flipAt > -1, "the toggle lost its write or its setter");
  assert.ok(flipAt > writeAt, "the toggle moves before the write is even issued");
  assert.ok(/if\s*\(\s*!\s*res\.ok\s*\)/.test(body), "the PATCH response is never checked");
});

t("combo membership rolls back when the save fails", () => {
  // All four optimistic writers: add, deselect, remove, reorder.
  for (const name of ["handleAddModel", "handleDeselectModel", "handleRemoveProvider", "handleMove"]) {
    const body = fn(combo, name);
    assert.ok(/setProviders\(next\)/.test(body), `${name} no longer sets the optimistic state`);
    assert.ok(body.includes("setProviders(providers)"), `${name} does not roll back on a failed save`);
    assert.ok(new RegExp(`if\\s*\\(\\s*!\\s*\\(await saveCombo`).test(body),
      `${name} ignores the saveCombo result`);
  }
});

t("the SSE reader does not discard an unreadable terminal frame", () => {
  assert.ok(/else if \(evt === "done"\)/.test(detail), "the done event is gone");
  const catchBlock = /catch \{\s*([\s\S]*?)\n\s*\}/.exec(detail.slice(detail.indexOf("const payload = dataStr")));
  assert.ok(catchBlock, "the SSE parse catch is gone");
  assert.ok(!/^\s*\}\s*catch \{\s*\}\s*$/m.test(detail),
    "an empty catch is back around the SSE frame parser");
  assert.ok(/evt === "done" \|\| evt === "error"/.test(catchBlock[1]),
    "a dropped done/error frame still ends the stream with nothing reported");
  // And a stream that ends with neither a result nor an error must say so.
  assert.ok(/Stream ended without a result/.test(detail),
    "a stream that produced nothing reports nothing");
});

t("both delete handlers report a failure instead of giving up silently", () => {
  for (const [src, name, how] of [
    [combo, "handleDelete", /alert\(/],
    [detail, "handleDeleteCustom", /setDeleteError\(/],
  ]) {
    const body = fn(src, name);
    assert.ok(/if\s*\(\s*res\.ok\s*\)/.test(body), `${name} no longer navigates on success`);
    assert.ok(how.test(body), `${name} has no failure path`);
  }
  assert.ok(!/console\.log\("Error deleting custom embedding node/.test(detail),
    "the delete error is back in the console instead of the page");
  assert.ok(/const \[deleteError, setDeleteError\] = useState/.test(detail),
    "deleteError state is missing");
  assert.ok(/\{deleteError &&/.test(detail), "deleteError is never rendered");
});

t("every writer on the page still checks its response", () => {
  // ExpectOk is the shared helper the earlier usage-page fix introduced.
  const writes = [...list.matchAll(/method:\s*"(?:PUT|POST|PATCH|DELETE)"/g)].length;
  assert.ok(writes > 0, "the listing page has no writers left to check");
  assert.ok(list.includes("expectOk"), "the bulk provider toggle lost expectOk");
  // Only writes: a GET that 404s has nothing to roll back.
  for (const src of [list, combo, detail]) {
    for (const m of src.matchAll(/await fetch\(([\s\S]{0,400}?)\);/g)) {
      if (!/method:\s*"(?:PUT|POST|PATCH|DELETE)"/.test(m[1])) continue;
      const tail = src.slice(m.index, m.index + 900);
      assert.ok(/!\s*res\.ok|res\.ok|expectOk|res\.status/.test(tail),
        `a write in media-providers has no response check: ${m[1].slice(0, 70).replace(/\s+/g, " ")}`);
    }
  }
});

t("every kind the sidebar offers has a route the router serves", async () => {
  // imageToText and music declare /v1/images/understanding and /v1/audio/music.
  // Neither has a route or a handler -- both answer 404 -- and the catalog has
  // no models of either type, so their detail pages offered a form that could
  // only fail. They are flagged served: false and the page says so.
  const routes = new Set();
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "route.ts") {
        const rel = path.relative(path.join(HERE, "src", "routes"), p).split(path.sep).join("/");
        routes.add(("/api/" + rel.replace(/route\.ts$/, "")).replace(/\/+$/, ""));
      }
    }
  })(path.join(HERE, "src", "routes"));

  const { PROVIDER_MODELS } = await import(pathToFileURL(CATALOG).href);
  const declaredTypes = new Set(Object.values(PROVIDER_MODELS).flat().map((m) => m.type));

  // One entry per line in MEDIA_PROVIDER_KINDS; `[^}]*` cannot span the
  // nested endpoint object, so parse line by line rather than across entries.
  const kinds = constants.split("\n")
    .filter((l) => /endpoint: \{ method:/.test(l))
    .map((l) => ({
      id: /id: "(\w+)"/.exec(l)?.[1],
      path: /path: "([^"]+)"/.exec(l)?.[1],
      served: !/served: false/.test(l),
    }));

  assert.ok(kinds.length >= 9, `only ${kinds.length} kinds parsed from the constants`);

  for (const k of kinds) {
    const served = routes.has("/api" + k.path);
    const hasModels = declaredTypes.has(k.id) || !["image", "video", "music", "imageToText"].includes(k.id);
    if (k.served) {
      assert.ok(served, `${k.id} is offered but /api${k.path} has no route`);
    } else {
      assert.ok(!served, `${k.id} is marked unserved but /api${k.path} exists -- drop the flag`);
      assert.ok(!declaredTypes.has(k.id), `${k.id} is marked unserved but the catalog has models of that type`);
    }
  }
});

t("an unserved kind explains itself instead of showing a dead form", () => {
  const guard = detail.match(/kindConfig\.served === false[\s\S]{0,400}?\);/);
  assert.ok(guard, "the detail page has no guard for an unserved kind");
  assert.ok(/no route/.test(guard[0]), "the guard does not say what is missing");
  // And nothing may be flagged unserved while the sidebar still links to it.
  const sidebar = fs.readFileSync(path.join(HERE, "..", "frontend", "src", "shared", "components", "Sidebar.jsx"), "utf8");
  const list = /const VISIBLE_MEDIA_KINDS = \[([^\]]*)\]/.exec(sidebar);
  assert.ok(list, "VISIBLE_MEDIA_KINDS is gone from the sidebar");
  const unserved = [...constants.matchAll(/id: "(\w+)"[^}]*served: false/g)].map((m) => m[1]);
  for (const k of unserved) {
    assert.ok(!list[1].includes(`"${k}"`), `the sidebar still links to the unserved kind ${k}`);
  }
});

t("a provider-node prefix is unique on create and on edit", () => {
  // Resolution is `nodes.find(n => n.prefix === alias)` -- first match wins -- so
  // a duplicate left the second node permanently unreachable while the error
  // named an opaque node id. Three nodes sharing one prefix were accepted live.
  const create = fs.readFileSync(NODE_ROUTE, "utf8");
  const edit = fs.readFileSync(NODE_ID_ROUTE, "utf8");
  for (const [label, src] of [["create", create], ["edit", edit]]) {
    assert.ok(/already used by/.test(src), `${label} does not report a prefix collision`);
    assert.ok(/409/.test(src), `${label} does not answer 409 on a prefix collision`);
  }
  // Both branches of create must be covered, not just the one that happened to be used.
  assert.equal((create.match(/await assertNodeIsUsable\(/g) || []).length, 3,
    "create leaves a node type without the prefix/URL guard");
  assert.ok(/trimmedPrefix !== node\.prefix/.test(edit),
    "edit re-checks the prefix even when it was not changed");
  assert.ok(fs.readFileSync(MODEL_SERVICE, "utf8").includes("node.prefix === parsed.providerAlias"),
    "resolution no longer matches on prefix; re-check the uniqueness requirement");
});

t("the base URL guard covers the path that stores it, not only the one that tests it", () => {
  // /provider-nodes/validate applied checkFetchableUrl to the identical input
  // that POST /provider-nodes stored unchecked: a loopback baseUrl was accepted
  // with 201 while validate answered 403 for the same string.
  const create = fs.readFileSync(NODE_ROUTE, "utf8");
  const edit = fs.readFileSync(NODE_ID_ROUTE, "utf8");
  assert.ok(create.includes("checkFetchableUrl"), "create does not guard the base URL");
  assert.ok(edit.includes("checkFetchableUrl"), "edit does not guard the base URL");
  assert.ok(/checkFetchableUrl\(baseUrl\)/.test(create), "create checks something other than the stored baseUrl");
  assert.ok(/sanitizedBaseUrl !== node\.baseUrl/.test(edit),
    "edit guards unconditionally, re-fetching the URL on every unrelated edit");
});

t("the custom embedding modal reports a rejected save", () => {
  const modal = fs.readFileSync(MODAL, "utf8");
  const submit = modal.slice(modal.indexOf("const handleSubmit"), modal.indexOf("const handleValidate"));
  assert.ok(/if \(res\.ok\)/.test(submit), "submit lost its ok branch");
  // The ok branch returns early, so the code that reports a rejection is what
  // follows it. Scope to that slice: setSaveError also appears in the state
  // declaration, the reset and the catch block, so matching the name anywhere in
  // submit passes even when the rejected-response path is empty.
  const okAt = submit.indexOf("if (res.ok)");
  const failPath = submit.slice(submit.indexOf("}", submit.indexOf("return;", okAt)) + 1,
                                submit.indexOf("} catch (error)"));
  assert.ok(failPath.length > 0, "no code follows the early return");
  assert.ok(/setSaveError\(/.test(failPath),
    "the rejected-response path does not report the failure");
  // Without the early return the success path falls through and reports a
  // failure for a node that was created fine.
  const okBranch = submit.slice(okAt, submit.indexOf("}", submit.indexOf("return;", okAt)));
  assert.ok(/return;/.test(okBranch), "the ok branch no longer returns early");
  assert.ok(/const \[saveError, setSaveError\] = useState/.test(modal),
    "saveError is referenced but never declared");
  assert.ok(!/console\.log\("Error saving custom embedding node/.test(modal),
    "the save error is back in the console instead of the modal");
  assert.ok(/\{saveError &&/.test(modal), "saveError is never rendered");
  const validate = modal.slice(modal.indexOf("const handleValidate"), modal.indexOf("const renderValidationResult"));
  assert.ok(/if \(!res\.ok\)/.test(validate), "validate still renders a 500 body as a verdict");
});

Promise.all(pending).then(() =>
  console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`));