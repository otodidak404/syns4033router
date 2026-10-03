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

// Serialised on purpose. The adapter cases below swap globalThis.fetch, and run
// concurrently they overwrote each other: the "no generation id" stub answered
// the submit of the test beside it, so both saw the other's response.
let pass = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });

async function drain() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      pass++;
      console.log(`  ok   ${name}`);
    } catch (e) {
      process.exitCode = 1;
      console.log(`  FAIL ${name}\n       ${e?.message || e}`);
    }
  }
  console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);
}

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

// ── the adapters, executed ───────────────────────────────────────────────────
// 709 lines of leonardo.js and weavy.js that nothing in the suite had ever called.
// A missing mock is not evidence, so both are driven here.

const fsMod = await import("node:fs");
const pathMod = path;
const leonardo = (await import(path.join(HERE, "open-sse", "handlers", "videoProviders", "leonardo.js"))).default;
const weavy = (await import(path.join(HERE, "open-sse", "handlers", "videoProviders", "weavy.js"))).default;

/** Swap global fetch and run fn, recording every call. */
async function withFetch(handler, fn, capMs = 12000) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, method: init?.method || "GET" });
    return handler(String(url), init, calls.length);
  };
  // waitForVideo sleeps between polls, so without a cap this hangs the suite
  // rather than failing it.
  let timer;
  try {
    const capped = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("adapter did not settle within the cap")), capMs);
    });
    return { result: await Promise.race([Promise.resolve().then(fn), capped]), calls };
  } finally {
    clearTimeout(timer);
    globalThis.fetch = real;
  }
}

t("the weavy adapter refuses clearly instead of failing to spawn Python", async () => {
  // The deployed image is node:22-alpine: no interpreter, no .venv, and
  // weavy_generate.py is not in the repository. Before the preflight, every one of
  // the 75 weavy models answered with a bare ENOENT from execFile.
  const here = pathMod.resolve(process.cwd());
  const venv = pathMod.resolve(here, ".venv/bin/python");
  const script = pathMod.resolve(here, "src/automation/weavy_generate.py");
  assert.ok(!fsMod.existsSync(script),
    "weavy_generate.py exists now -- this deployment still cannot run it, so the " +
    "preflight message and this assertion need revisiting together");
  assert.ok(!fsMod.existsSync(venv), "a .venv appeared; alpine still has no Python");

  let threw = null;
  try {
    await weavy.generate(
      { email: "a@b.c", accessToken: "tok", connectionId: "c1" },
      "a cat",
      { model: "weavy-wan", prompt: "a cat" },
      { debug: () => {} },
    );
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, "the adapter reported success without Python");
  assert.equal(threw.status, 501, `expected 501, got ${threw.status}: ${threw.message}`);
  assert.ok(/weavy_generate\.py/.test(threw.message),
    `the message should name the missing script: ${threw.message}`);
  assert.ok(/Weavy is image-only/.test(threw.message),
    `the message should say what still works: ${threw.message}`);
});

t("the weavy adapter does not leak the token through its failure", async () => {
  let msg = "";
  try {
    await weavy.generate(
      { email: "a@b.c", accessToken: "SUPER-SECRET-JWT-VALUE", connectionId: "c1" },
      "a cat", { model: "weavy-wan" }, { debug: () => {} },
    );
  } catch (e) {
    msg = `${e.message} ${e.stack || ""}`;
  }
  assert.ok(msg.length > 0, "expected the adapter to throw");
  assert.ok(!msg.includes("SUPER-SECRET-JWT-VALUE"),
    "the credential appears in the failure");
});

t("the leonardo adapter submits over HTTP, polls, and returns urls", async () => {
  // Never executed before this. Driven against a stubbed fetch: submit -> poll
  // until COMPLETE -> return the urls.
  const { result, calls } = await withFetch(
    (url, init) => {
      const q = String(init?.body || "");
      let body;
      if (q.includes("generationId")) {
        body = { data: { generate: { generationId: "gen-1" } } };
      } else if (q.includes("GetAIGenerationFeedStatuses")) {
        // Hasura: pollStatus reads data.generations[0].status
        body = { data: { generations: [{ id: "gen-1", status: "COMPLETE" }] } };
      } else {
        // Hasura: fetchVideoUrls reads generated_images[].motionMP4URL
        body = { data: { generations: [{ generated_images: [
          { url: "https://cdn/img.png", motionMP4URL: "https://cdn/x.mp4" }] }] } };
      }
      void url;
      return new Response(JSON.stringify(body),
        { status: 200, headers: { "Content-Type": "application/json" } });
    },
    () => leonardo.generate(
      { apiKey: "leonardo-key", connectionId: "c1", email: "a@b.c" },
      "a cat", { model: "leo-kling-2.5-turbo", prompt: "a cat" },
      { debug: () => {} },
    ),
  );

  assert.ok(result && !(result instanceof Error && /did not settle/.test(result.message)),
    `the adapter never returned: ${result?.message}`);
  assert.ok(calls.length >= 2, `expected a submit and a poll, saw ${calls.length}`);
  for (const c of calls) {
    assert.ok(/^https:\/\//.test(c.url), `not an absolute URL: ${c.url}`);
    assert.ok(!/leonardo-key/.test(c.url),
      `the credential is in the query string: ${c.url.slice(0, 80)}`);
  }
  assert.ok(result && Array.isArray(result.urls) && result.urls.length === 1,
    `the adapter did not return urls: ${JSON.stringify(result)?.slice(0, 120)}`);
  assert.equal(result.genId, "gen-1", "the generation id was not carried through");

  // It talks HTTP, so unlike weavy it can actually run in this image.
  const src = fsMod.readFileSync(
    pathMod.join(HERE, "open-sse", "handlers", "videoProviders", "leonardo.js"), "utf8");
  assert.ok(!/execFile|child_process|\.py["']/.test(src),
    "leonardo must not shell out, or it inherits weavy's problem");
});

t("a leonardo response without a generation id is a visible error", async () => {
  const { result } = await withFetch(
    () => new Response(JSON.stringify({ data: {} }),
      { status: 200, headers: { "Content-Type": "application/json" } }),
    async () => {
      try {
        await leonardo.generate(
          { apiKey: "leonardo-key", connectionId: "c1" },
          "a cat", { model: "leo-kling-2.5-turbo", prompt: "a cat" },
          { debug: () => {} },
        );
        return null;
      } catch (e) {
        return e;
      }
    },
  );
  assert.ok(result, "an empty response was reported as success");
  assert.ok(/generationId/.test(result.message),
    `the error should say what was missing: ${result.message}`);
});

await drain();