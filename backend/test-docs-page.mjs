// /dashboard/docs is an iframe around a 253 KB static HTML file, so there is no
// flow logic to audit — what can rot is the file itself.
//
// It had already rotted. It claimed:
//
//   POST /v1/images/generations
//   "Generate images or videos... This endpoint handles all image and video
//    generation requests."
//
// and the router has a separate /v1/video/generations routed to its own
// videoGeneration handler, while imageGeneration.js mentions video zero times.
// So the page told an operator to call the images endpoint for a video model —
// which lands in the image handler — and never mentioned the endpoint that does
// the work. Both were verified against the running deployment: each answers 400
// "No credentials for provider", i.e. both reach their handler.
import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(HERE, "..", "frontend");
const DOCS = path.join(FRONTEND, "public", "image-video-docs.html");
const PAGE = path.join(FRONTEND, "src", "pages", "docs", "page.jsx");
const ROUTES = path.join(HERE, "src", "routes");

let pass = 0;
const pending = [];
const t = (name, fn) => pending.push(
  Promise.resolve().then(fn)
    .then(() => { console.log(`  ok  ${name}`); pass++; })
    .catch((e) => { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }),
);

const html = fs.readFileSync(DOCS, "utf8");

// The catalog is ESM and imports sibling modules, so it is loaded in place
// rather than parsed or reimplemented here.
const CATALOG = pathToFileURL(path.join(HERE, "..", "backend", "open-sse", "config", "providerModels.js")).href;
const providerCatalog = async () => (await import(CATALOG)).PROVIDER_MODELS;

const norm = (x) => x.replace(/\{[^}]+\}|\[[^\]]+\]/g, "").replace(/\/+$/, "");

/**
 * Every route under `dir`, as the absolute path a client would call —
 * prefix + relative path. The card headers carry the full path, so the prefix
 * has to survive the walk or nothing matches.
 */
function routes(dir, prefix) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "route.ts") {
        out.push(prefix + "/" + norm(path.relative(dir, p).split(path.sep).join("/").replace(/route\.ts$/, "")));
      }
    }
  })(dir);
  return out;
}

/**
 * The endpoint cards, keyed by the path in their own header.
 *
 * Not a plain `split(...).find(c => c.includes(path))`: the path appears twice
 * in this file — once in the images endpoint's description pointing here, once on
 * the card — so matching anywhere in a card returns the images card and every
 * check below passes against the wrong markup. Key on the header instead.
 */
/** The model ids the docs ship, per provider, parsed out of the script. */
function embeddedModels() {
  const src = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  const open = src.indexOf("const EMBEDDED_MODELS");
  assert.ok(open > -1, "EMBEDDED_MODELS is gone from the docs");
  const brace = src.indexOf("{", src.indexOf("=", open));
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return JSON.parse(src.slice(brace, i + 1));
  }
  throw new Error("EMBEDDED_MODELS is not a closed object literal");
}

const cards = new Map();
for (const chunk of html.split('<div class="endpoint-card">').slice(1)) {
  const m = chunk.match(/endpoint-path">([^<]+)</);
  if (m) cards.set(m[1].trim(), chunk.trimStart());
}

t("every media route in the router is documented on a card", () => {
  const missing = routes(path.join(ROUTES, "v1"), "/v1").filter((r) => /\/(images|video)\//.test(r) && !cards.has(r));
  assert.equal(missing.length, 0,
    "undocumented routes this page claims to cover:\n       " + missing.join("\n       "));
});

t("the page does not claim the images endpoint serves video", () => {
  assert.ok(!/handles all image and video generation requests/i.test(html),
    "the false claim is still in the file");
  assert.ok(!/Generate images or videos/i.test(html),
    "the description still promises video from the images endpoint");
  assert.ok(cards.has("/v1/video/generations"), "the video endpoint is not on a card header");
});

t("the video card carries its method, parameters and closing markup", () => {
  const card = cards.get("/v1/video/generations");
  assert.ok(card, "no card declares the video path");
  assert.ok(card.startsWith('<div class="endpoint-header">'), "the card has no header");
  assert.ok(card.includes('<span class="method post">POST</span>'), "no POST badge");
  assert.ok(/<table class="param-table">/.test(card), "documents no parameters");
  assert.ok(card.includes("<code>model</code>") && card.includes("<code>prompt</code>"),
    "the required parameters are not documented");
  assert.ok(card.trimEnd().endsWith("</div>"), "the card is never closed");
});

t("every media provider in the router has a section and a populated list", async () => {
  // cx was serving three image models and the page never mentioned it: the
  // section, the PROVIDERS entry, the CONTAINER_MAP entry and the model data
  // were all missing. Scanning for endpoints could not see this -- the endpoint
  // was there, only the provider was undocumented.
  const catalog = await providerCatalog();
  const docs = embeddedModels();
  const missing = Object.entries(catalog)
    .filter(([, v]) => v.some((m) => m.type === "image" || m.type === "video"))
    .map(([k]) => k)
    .filter((k) => !(k in docs));
  assert.equal(missing.length, 0, "media provider missing from the docs:\n       " + missing.join("\n       "));

  // A provider needs a section, a model-list container, a PROVIDERS entry and a
  // CONTAINER_MAP entry, or the script renders nothing under its heading.
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  // Scope to CONTAINER_MAP: the same key appears earlier in PROVIDERS with a
  // label instead of container ids, and matching that reads the label as one.
  const containerMap = /const CONTAINER_MAP\s*=\s*\{([\s\S]*?)\n\};/.exec(script);
  assert.ok(containerMap, "CONTAINER_MAP is gone from the docs");
  for (const key of Object.keys(docs)) {
    assert.ok(html.includes(`class="section" id="${key}"`), `${key} has no section`);
    const forms = [`${key}: { label:`, `'${key}': { label:`];
    assert.ok(forms.some((f) => script.includes(f)), `${key} is not in PROVIDERS`);

    // leonardo and weavy split image and video across two containers, so the
    // container names are not derivable from the provider key — read them back
    // out of CONTAINER_MAP rather than guessing.
    const map = new RegExp(`(?:'|")?${key}(?:'|")?:\\s*\\{([\\s\\S]*?)\\}`).exec(containerMap[1]);
    assert.ok(map, `${key} is not in CONTAINER_MAP`);
    const targets = [...map[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(targets.length, `${key} maps to no container`);
    for (const id of targets) {
      assert.ok(html.includes(`id="${id}"`), `${key} maps to ${id}, which is not in the markup`);
    }
  }
});

t("every image and video model documented still exists in the router", async () => {
  const ids = new Set(Object.values(await providerCatalog()).flat().map((m) => m.id));
  const ghost = Object.entries(embeddedModels())
    .flatMap(([p, ms]) => ms.filter((m) => m.type === "image" || m.type === "video").map((m) => `${p}/${m.id}`))
    .filter((x) => !ids.has(x.split("/").slice(1).join("/")));
  assert.equal(ghost.length, 0, "documented but no longer served:\n       " + ghost.join("\n       "));
});

t("the dead MODEL_DATA placeholder stays gone", () => {
  // It sat next to the comment "will be populated by fetch" while the file
  // contained no fetch at all and the catalog came from EMBEDDED_MODELS.
  assert.ok(!html.includes("MODEL_DATA"), "the unused MODEL_DATA declaration is back");
  assert.ok(!/will be populated by fetch/.test(html), "the comment claiming a fetch is back");
});

t("the page points at the file that exists", () => {
  const page = fs.readFileSync(PAGE, "utf8");
  assert.ok(fs.existsSync(DOCS), "the docs file is missing");
  // The iframe and the "open in new tab" link must both resolve.
  // The iframe loads a same-origin document that runs scripts, so it needs an
  // explicit sandbox. Without allow-scripts the docs break; without
  // allow-same-origin the styles are blocked too.
  assert.ok(/<iframe[\s\S]{0,300}?sandbox="[^"]*allow-scripts/.test(page), "the iframe is not sandboxed");
  assert.ok(/sandbox="[^"]*allow-same-origin/.test(page), "the iframe sandbox would block the styles");
  const targets = [...page.matchAll(/(?:src|href)="(\/[^"]+\.html)"/g)].map((m) => m[1]);
  assert.ok(targets.length >= 2, "the page no longer offers both the iframe and the link");
  for (const tgt of targets) {
    assert.ok(fs.existsSync(path.join(path.dirname(DOCS), tgt)),
      `${tgt} is linked but not present in public/`);
  }
});

t("every documented endpoint resolves to a real route", () => {
  // The pattern captures after the leading slash; routes carry it.
  const documented = [...new Set(
    [...html.matchAll(/\/(v1\/[a-zA-Z0-9/_-]+)/g)].map((m) => "/" + m[1]),
  )].map(norm);
  assert.ok(documented.length >= 3, `only ${documented.length} endpoints found`);

  const all = routes(ROUTES, "");
  const bogus = documented.filter((d) => !all.some((r) => r === d || r.startsWith(d + "/") || d.startsWith(r)));
  assert.equal(bogus.length, 0, "documented but not a route:\n       " + bogus.join("\n       "));
});

t("the HTML structure is still balanced", () => {
  for (const tag of ["div", "table", "section", "tbody", "thead", "tr"]) {
    const open = (html.match(new RegExp(`<${tag}[\\s>]`, "g")) || []).length;
    const close = (html.match(new RegExp(`</${tag}>`, "g")) || []).length;
    assert.equal(open, close, `<${tag}> ${open} open vs ${close} close`);
  }
});

Promise.all(pending).then(() =>
  console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`));