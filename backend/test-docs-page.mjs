// /dashboard/docs is an iframe around a 253 KB static HTML file, so there is no
// flow logic to audit — the thing that can rot is the file itself.
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
const DOCS = path.join(HERE, "..", "frontend", "public", "image-video-docs.html");
const ROUTES = path.join(HERE, "..", "backend", "src", "routes");
const PAGE = path.join(HERE, "..", "frontend", "src", "pages", "docs", "page.jsx");

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const html = fs.readFileSync(DOCS, "utf8");

// Every media route the router actually serves.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "route.ts") out.push(p);
  }
  return out;
}
const norm = (x) => x.replace(/\{[^}]+\}|\[[^\]]+\]/g, "").replace(/\/+$/, "");
const mediaRoutes = walk(path.join(ROUTES, "v1"))
  .map((p) => "/v1/" + norm(path.relative(path.join(ROUTES, "v1"), p).replace(/route\.ts$/, "").split(path.sep).join("/")))
  .filter((r) => /\/(images|video)\//.test(r));

t("every media route in the router is documented", () => {
  const cards = html.split('<div class="endpoint-card">').slice(1).join("\n");
  const missing = mediaRoutes.filter((r) => !cards.includes(r));
  assert.equal(missing.length, 0,
    "undocumented routes the page claims to cover:\n       " + missing.join("\n       "));
});

t("the page does not claim the images endpoint serves video", () => {
  assert.ok(!/handles all image and video generation requests/i.test(html),
    "the false claim is still in the file");
  assert.ok(!/Generate images or videos/i.test(html),
    "the description still promises video from the images endpoint");
  assert.ok(/\/v1\/video\/generations/.test(html),
    "the video endpoint is not mentioned anywhere");
});

t("the video card is a real card, not a mention in prose", () => {
  // The path appears twice: once in the images endpoint's description pointing
  // here, once on the card itself. Checking "html.includes" therefore passes with
  // the card deleted, and slicing from lastIndexOf picks the wrong card. Split on
  // the card boundary and inspect the card that owns the path.
  const cards = html.split('<div class="endpoint-card">').slice(1);
  // Match on the card's own path header, not on the path appearing anywhere in
  // it — the images card names this endpoint in its description, so a plain
  // `find` returns that card instead and every check below passes on the wrong
  // markup.
  const owning = cards
    .find((c) => /endpoint-path">\/v1\/video\/generations</.test(c))
    ?.trimStart();
  assert.ok(owning, "no endpoint card declares the video path in its header");
  assert.ok(owning.startsWith('<div class="endpoint-header">'), "the card has no header");
  assert.ok(owning.includes('<span class="method post">POST</span>'),
    "the video card has no POST badge");
  assert.ok(/<table class="param-table">/.test(owning), "the video card documents no parameters");
  assert.ok(owning.includes("model") && owning.includes("prompt"),
    "the video card documents no required parameters");
  assert.ok(/<\/div>\s*$/.test(owning.trimEnd()) || owning.trimEnd().endsWith("</div>"),
    "the card is never closed");
});

t("every documented path sits in a card, not only in prose", () => {
  const cards = html.split('<div class="endpoint-card">').slice(1);
  const inCards = new Set();
  for (const c of cards) {
    for (const m of c.matchAll(/endpoint-path">([^<]+)</g)) inCards.add(m[1].trim());
  }
  assert.ok(inCards.has("/v1/video/generations"),
    `the video path is not on a card header; cards carry: ${[...inCards].join(", ")}`);
});

t("the page still points at the file that exists", () => {
  const page = fs.readFileSync(PAGE, "utf8");
  assert.ok(/src="\/image-video-docs\.html"/.test(page), "the iframe no longer points at the docs");
  assert.ok(fs.existsSync(DOCS), "the docs file is missing");
  // Both the iframe and the "open in new tab" link must resolve to the same file.
  const targets = [...page.matchAll(/(?:src|href)="(\/[^"]+\.html)"/g)].map((m) => m[1]);
  assert.ok(targets.length >= 2, "the page no longer offers both the iframe and the link");
  for (const tgt of targets) {
    assert.ok(fs.existsSync(path.join(path.dirname(DOCS), tgt.replace(/^\//, ""))),
      `${tgt} is linked but not present in public/`);
  }
});

t("the documented endpoints really exist", () => {
  // The regex captures without the leading slash; routes carry it. Compare
  // normalized, or every endpoint reads as bogus.
  const documented = [...new Set(
    [...html.matchAll(/\/(v1\/[a-zA-Z0-9/_-]+)/g)].map((m) => m[1].replace(/^/, "/")),
  )];
  assert.ok(documented.length >= 3, `only ${documented.length} endpoints found`);
  const all = walk(ROUTES).map((p) => "/" + path.relative(ROUTES, p).split(path.sep).join("/").replace(/route\.ts$/, ""));
  const allNorm = all.map((x) => norm(x));
  const bogus = documented.filter((d) => {
    const dn = norm(d);
    return !allNorm.some((r) => r === dn || r.startsWith(dn + "/") || dn.startsWith(r));
  });
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