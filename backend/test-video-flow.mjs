// Flow logic for /dashboard/media-providers/video.
//
// Four defects, all found by reading the path end to end:
//
//  1. runwayml listed two video models and had no video adapter at all.
//     getVideoAdapter() returns null for anything outside ADAPTERS, and the core
//     answers 400 "Provider 'runwayml' does not support video generation", so
//     those two cards could only ever fail.
//  2. A malformed JSON body answered 500 on every JSON route, not 400.
//     express.json() throws a SyntaxError that already carries status 400 and a
//     message; the server's error handler flattened it to "Internal server
//     error". Measured across eight endpoints.
//  3. The provider-info card fell through to searchConfig, which would render a
//     chat-completions panel titled "Video Config".
//  4. The static docs still documented the two removed models, and described
//     RunwayML as a video provider.
//
// The contract check is executed against the real modules. A table of what each
// adapter "should" honour is not evidence; getVideoAdapter() returning a value
// is.

import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FE = path.join(HERE, "..", "frontend", "src");
const read = (...p) => fs.readFileSync(path.join(FE, ...p), "utf8");

const providersMod = await import(path.join(HERE, "src", "shared", "constants", "providers.js"));
const modelsMod = await import(path.join(HERE, "open-sse", "config", "providerModels.js"));
const videoMod = await import(path.join(HERE, "open-sse", "handlers", "videoProviders", "index.js"));

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

const docHtml = fs.readFileSync(
  path.join(HERE, "..", "frontend", "public", "image-video-docs.html"), "utf8");
const detailPage = read("pages", "media-providers", "[kind]", "[id]", "page.jsx");
const serverTs = fs.readFileSync(path.join(HERE, "src", "server.ts"), "utf8");
const videoHandler = fs.readFileSync(
  path.join(HERE, "src", "sse", "handlers", "videoGeneration.js"), "utf8");

// ── every listed video model can reach an adapter ────────────────────────────

t("every video model the catalogue offers reaches a real adapter", () => {
  const offenders = [];
  for (const [alias, models] of Object.entries(modelsMod.PROVIDER_MODELS)) {
    for (const m of models) {
      if (m.type !== "video") continue;
      if (!videoMod.getVideoAdapter(alias)) offenders.push(`${alias}/${m.id}`);
    }
  }
  assert.equal(offenders.length, 0,
    `listed but unreachable -- the core answers 400 for these:\n       ${offenders.join("\n       ")}`);
});

t("every provider shown on the video page can actually generate video", () => {
  const shown = providersMod.getProvidersByKind("video");
  assert.ok(shown.length > 0, "the video page would list no providers at all");
  const bad = shown.filter((p) => !videoMod.getVideoAdapter(p.id)).map((p) => p.id);
  assert.equal(bad.length, 0,
    `shown on /dashboard/media-providers/video with no adapter: ${bad.join(", ")}`);
});

t("the frontend and backend provider tables agree", () => {
  // Both files were edited by hand for the runwayml fix. They are read by
  // different halves of the app, so a divergence shows up as a page that lists a
  // provider the server cannot route, and nothing else would notice.
  const fe = read("shared", "constants", "providers.js");
  const be = fs.readFileSync(path.join(HERE, "src", "shared", "constants", "providers.js"), "utf8");
  for (const id of Object.keys(providersMod.AI_PROVIDERS)) {
    const grab = (src) => {
      const m = src.match(new RegExp(`["\\s\\S]{0,2}${id}["\\s\\S]{0,600}?serviceKinds:\\s*\\[([^\\]]*)\\]`));
      return m ? m[1].replace(/\s+/g, " ").trim() : null;
    };
    assert.equal(grab(fe), grab(be),
      `${id} has different serviceKinds in the frontend and backend tables`);
    const hk = (src) => {
      const m = src.match(new RegExp(`["\\s\\S]{0,2}${id}["\\s\\S]{0,700}?hiddenKinds:\\s*\\[([^\\]]*)\\]`));
      return m ? m[1].replace(/\s+/g, " ").trim() : null;
    };
    assert.equal(hk(fe), hk(be), `${id} has different hiddenKinds in the two tables`);
  }
});

t("a provider kept for another kind is not dropped from that kind", () => {
  // runwayml is image-only now; hiding it from video must not hide it from image.
  const image = providersMod.getProvidersByKind("image").map((p) => p.id);
  assert.ok(image.includes("runwayml"),
    "runwayml disappeared from the image page as well");
  assert.ok(modelsMod.PROVIDER_MODELS.runwayml.some((m) => m.type === "image"),
    "runwayml lost its image models too");
});

t("the adapter map and the provider list cannot drift apart", () => {
  for (const [id, provider] of Object.entries(providersMod.AI_PROVIDERS)) {
    if (!provider.serviceKinds?.includes("video")) continue;
    // hiddenKinds is the deliberate way to say "claims it, does not serve it" --
    // runwayml is the only provider in that state, and hiding it from the page is
    // the fix rather than the fault.
    if (provider.hiddenKinds?.includes("video")) continue;
    assert.ok(videoMod.getVideoAdapter(id),
      `${id} claims serviceKinds video, is not hidden, and has no adapter`);
  }
});

// ── a malformed body is a 400, not a 500 ─────────────────────────────────────

t("a body-parser failure is not flattened into a 500", () => {
  // Match the branch itself, not the prose: the comment above it names
  // entity.parse.failed, so a substring check passed even with the branch
  // disabled. That mutation control stayed green once for exactly this reason.
  const code = serverTs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(/if \(tagged\.type === "entity\.parse\.failed"\)/.test(code),
    "the server has no branch for a malformed JSON body");
  assert.ok(/if \(tagged\.type === "entity\.too\.large"\)/.test(code),
    "an oversized body is not reported as 413 either");
  assert.ok(/res\.status\(400\)/.test(code), "the 400 branch does not answer 400");
  // The 500 branch has to survive for everything else.
  assert.ok(/res\.status\(500\)\.json\(\{ error: "Internal server error" \}\)/.test(serverTs),
    "the generic 500 branch was removed entirely");
  // And it must come after the tagged branches, not before.
  const parse = serverTs.indexOf("entity.parse.failed");
  const generic = serverTs.indexOf('res.status(500).json');
  assert.ok(parse > 0 && generic > parse,
    "the generic 500 branch runs before the tagged ones, so it would win");
});

t("the video handler still has its own guard for an empty body", () => {
  // express.json() handles malformed input; the handler handles a valid JSON
  // document that is missing fields. Both are needed.
  assert.ok(/Invalid JSON body/.test(videoHandler), "the JSON branch was removed");
  assert.ok(/Missing model/.test(videoHandler), "the missing-model branch was removed");
  assert.ok(/Missing required field: prompt/.test(videoHandler),
    "the missing-prompt branch was removed");
});

// ── the info card cannot show the wrong kind ─────────────────────────────────

t("the provider-info card cannot fall through to a search panel", () => {
  const i = detailPage.indexOf("config={");
  assert.ok(i > 0, "the config chain not found");
  const chain = detailPage.slice(i, i + 900);
  assert.ok(/kind === "webSearch" \? provider\.searchConfig/.test(chain),
    "searchConfig is reachable for a kind that is not webSearch");
  assert.ok(!/: provider\.searchConfig \|\| \{ mode: "chat-completions"/.test(chain),
    "the chat-completions fallback is back as the last resort");
  assert.ok(/provider\.videoConfig \|\| null/.test(chain),
    "video has no branch of its own");
});

t("the info card is gated on a config that exists", () => {
  const g = detailPage.indexOf("!isCustom && (provider.searchConfig");
  assert.ok(g > 0, "the gate not found");
  const gate = detailPage.slice(g, g + 220);
  assert.ok(/videoConfig/.test(gate), "videoConfig is not part of the gate");
});

// ── the docs cannot advertise what is not served ─────────────────────────────

t("the static docs do not document a video model the router dropped", () => {
  // docs is a subset of the catalogue, not the other way round: iterate what the
  // docs claim and require the catalogue to back it up. Walking the catalogue and
  // demanding every entry appear in the docs asserts the opposite, and fails on
  // every model that is correctly present in both.
  const claimed = [];
  for (const m of docHtml.matchAll(/"id":"([^"]+)"[^}]*"type":"video"/g)) {
    claimed.push(m[1]);
  }
  const served = new Set();
  for (const models of Object.values(modelsMod.PROVIDER_MODELS)) {
    for (const m of models) if (m.type === "video") served.add(m.id);
  }
  const orphans = [...new Set(claimed)].filter((id) => !served.has(id));
  assert.equal(orphans.length, 0,
    `the docs list video models no longer served:\n       ${orphans.join("\n       ")}`);
  assert.ok(claimed.length > 20, `only ${claimed.length} video models found in the docs`);
});

t("the docs do not call RunwayML a video provider", () => {
  const j = docHtml.indexOf('<section class="section" id="runwayml">');
  assert.ok(j > 0, "the runwayml section is gone");
  const k = docHtml.indexOf("<section", j + 10);
  const section = docHtml.slice(j, k);
  assert.ok(!/Gen-4 Turbo/.test(section), "the section still advertises Gen-4 Turbo");
  assert.ok(!/Gen-3 Alpha/.test(section), "the section still advertises Gen-3 Alpha");
  assert.ok(/not implemented/.test(section),
    "the section should say plainly that video is not implemented for it");
});

// ── the dashboard config for video is well-formed ───────────────────────────

t("the video example card sends the fields the handler requires", () => {
  const i = detailPage.indexOf("video: {");
  assert.ok(i > 0, "video has no entry in KIND_EXAMPLE_CONFIG");
  const k = detailPage.indexOf("music: {", i);
  const cfg = detailPage.slice(i, k > 0 ? k : i + 900);
  assert.ok(/bodyKey:\s*"prompt"/.test(cfg), "the card does not send a prompt");
  assert.ok(/inputLabel:\s*"Prompt"/.test(cfg), "the prompt field is not labelled");
  // handleVideoGenerationCore reads these straight off the body.
  for (const key of ["duration", "resolution", "aspect_ratio", "image_url"]) {
    assert.ok(new RegExp(`key:\\s*"${key}"`).test(cfg),
      `the card offers no ${key} field, but the handler forwards it`);
  }
  // And the handler's credential resolver reads exactly those.
  for (const alias of ["image_url", "video_url", "start_frame", "end_frame"]) {
    assert.ok(videoHandler.includes(`body.${alias}`) || videoHandler.includes(alias),
      `the handler looks for ${alias}`);
  }
});

Promise.all(pending).then(() =>
  console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`));