# Changelog

Format: `## Fixed` entries must name **file:line** and be backed by a test or a
recorded run. Anything unproven belongs under `## Known issues`, not here.

---

## Fixed

### `8bd6d95` — Let a system prompt reach every model, with an env fallback

**Wildcard global.** A prompt bound to one model vanished the moment a request
used another — no error, no log, just silence. `pickEntry()` now resolves in
four layers, wildcard **last**, so a per-model entry always wins:
`backend/open-sse/rtk/livePrompt.js:26` (`GLOBAL_TARGET = "*"`),
`:57-61` (branch).

An ambiguous bare name — two entries sharing a bare model name — now falls
through to the wildcard instead of returning nothing. Previously
`byBare.length === 1 ? byBare[0] : null` dropped the prompt entirely.

`isValidModel()` already accepted `*`, so the API needed no change, and the
existing one-entry-per-model guard keeps the wildcard to a single row.

**Env fallback.** `resolvePromptForRequest()` no longer returns `null` when the
lookup throws. A database error silently stripped the operator's prompt from
every request; it now warns and falls through to `GODMODE_JB`
(`backend/open-sse/rtk/livePrompt.js:78-81`). The library still wins whenever it
has a matching entry.

**Observability.** Three failure modes are now distinguishable instead of
silent: no matching entry (`:94`), lookup failure (`:73`), and a body shape that
refuses the injection (`:105`).

**Idempotent injection.** `readSystemText()` only reads — it was never a dedup
mechanism — so injecting twice appended the block twice and doubled its token
cost. A body already carrying the exact block is now left alone (`:102`).

### `b046e8f` — Route the server's auth gate through requiresAuth

**Case-sensitive auth bypass.** The outer gate compared `req.path` against
`"/api"` and `"/v1"` exactly, while Express mounts `/api` case-insensitively —
so `/API/keys`, `/API/settings/database` and `/API/system-prompts` returned 200
without authentication, and `PATCH /API/settings {"requireLogin": false}` could
disable auth in one request. `backend/src/server.ts:78` now calls the shared
`requiresAuth()`, which lowercases first (`backend/src/middleware/auth.ts:41`),
and the inner gate normalizes its path too (`auth.ts:86`).

**`/v1` open by default.** `requireApiKey` was absent from `DEFAULT_SETTINGS`, so
a fresh install exposed `/v1/*` with no key — an open LLM relay for anyone who
found the URL. It now defaults to `true`
(`backend/src/lib/db/repos/settingsRepo.js`).

### Earlier

- `11b580f` — first-boot bootstrap generates and persists the dashboard password
  and the three secrets, so a fresh deploy needs no variables set
- API keys stored hashed rather than plaintext
- 13 dependency advisories patched (`npm audit fix`), leaving one `low` with no
  upstream fix

---

## Unreleased

### Presets in the system-prompt panel

The panel asked for a model and a prompt, both typed from scratch — including
the wildcard target, which meant typing `*` and hoping. `presets.js` adds four
starting points (Unfiltered, Terse, Step by step, Builder) plus an **All
models** button that fills the wildcard target.

A preset is only a textarea default; the operator edits it freely, and nothing
applies until the entry is saved and switched live
(`frontend/src/pages/system-prompt/presets.js`).

The prompt row is hidden once the textarea has content, so typing can never be
overwritten by a stray click, and the **All models** button stays available —
applying the wildcard only changes the target field, never the prompt.

---

## Verification

`npm run test` — **128 assertions, 9 suites, all passed**; `npm run typecheck`
and `npm run build` exit 0; `hermes verify` OVERALL ok.

| Suite | Assertions |
|---|---|
| `test-caveman.mjs` | 13 |
| `test-skill-loader.mjs` | 7 |
| `test-skill-wiring.mjs` | 6 |
| `test-model-skill.mjs` | 17 |
| `test-live-prompt.mjs` | 34 |
| `test-sysprompt-db-error.mjs` | 2 |
| `test-sysprompt-presets.mjs` | 10 |
| `test-skills-route.mjs` | 13 |
| `test-auth-gate.mjs` | 26 |
| `test-sysprompt-presets.mjs` | 10 |

The new behaviour is guarded by mutation, not just by passing tests: removing the
wildcard branch fails 3 assertions, removing the env fallthrough fails 2, and
removing the idempotency guard fails 1.

`test-sysprompt-db-error.mjs` boots a real database in a temp directory, then
**corrupts it while the process is running** and calls the resolver — the error
path cannot be mocked through the re-export chain.

Live, against the deployed router (`8bd6d95`):

| Check | Result |
|---|---|
| Wildcard reaches a model with no entry of its own | `WILDCARD-LIVE-9`, 180 prompt tokens |
| Same entry with `isLive: false` | prompt absent, 165 tokens |
| Entry exact beats wildcard | `EXACT-HIT-1` returned |
| Per-model prompt reaches the model | `BANANA-7391` returned |
| Auth bypass closed | every casing of `/API/*` and `/V1/*` → 401 |
| `/v1` without a key | 401 `Missing API key` |
| Preset panel renders in the deployed build | 4 preset buttons + All models, no page errors |
| Clicking a preset fills the textarea | 632 chars, prompt row then hidden |
| All models sets the wildcard and keeps the prompt | model field `*`, prompt intact |

---

## Known issues

- **The idempotency guard compares the whole block**, including the label
  (`livePrompt.js:98`). Two entries carrying the same prompt under different
  labels would both be injected. Not reachable today — a body is resolved once
  per request — but it is the boundary to change if a body is ever re-injected
  with a different entry.
- **Two `low` dependency advisories remain**, via `dompurify` under
  `monaco-editor`. No upstream fix; both are client-side editor code, not on a
  server request path. Replacing the editor is not worth the blast radius.
- **External media operations are unproven end to end.** Embedding, image, TTS,
  STT, video, web fetch and search all return correct errors without
  credentials; a successful call needs a real provider key.
- **`console.debug` output is not visible in production logs** — the structured
  `log.debug()` used by `chatCore.js` is filtered at that level. `console.warn`
  still surfaces.