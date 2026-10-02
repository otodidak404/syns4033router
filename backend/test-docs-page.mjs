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
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(HERE, "..", "frontend");
const DOCS = path.join(FRONTEND, "public", "image-video-docs.html");
const PAGE = path.join(FRONTEND, "src", "pages", "docs", "page.jsx");
const ROUTES = path.join(HERE, "src", "routes");

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const html = fs.readFileSync(DOCS, "utf8");

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

t("the page points at the file that exists", () => {
  const page = fs.readFileSync(PAGE, "utf8");
  assert.ok(fs.existsSync(DOCS), "the docs file is missing");
  // The iframe and the "open in new tab" link must both resolve.
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

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);