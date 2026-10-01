# Changelog

Format: entries under **Fixed** must name **file:line** and be backed by a test
or a recorded run. Anything unproven belongs under **Known issues**, not there.
Sections are `## Fixed`, `## Verification`, `## Known issues` — one top-level
heading each, in that order, with no horizontal rule splitting a section in two.

---

## Fixed

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
silent: no matching entry (`:94`), lookup failure (`:74`), and a body shape that
refuses the injection (`:105`).

**Idempotent injection.** `readSystemText()` only reads — it was never a dedup
mechanism — so injecting twice appended the block twice and doubled its token
cost. A body already carrying the exact block is now left alone (`:102`).

### `c34a87c` — This file

An audit of `8bd6d95` accepted the fix but flagged the one thing that made it
unauditable: nothing in the repository recorded what had changed, so "done" rested
on assertions in a conversation rather than on a file anyone could check.

### `81a39a7` — Presets in the system-prompt panel

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

### `ebc3055` — Live check for the preset panel

The preset commit shipped the code and its unit tests, but only the reducer was
recorded as covered. Driving the deployed panel adds what unit tests cannot: the
buttons render, clicking one fills the textarea and hides the preset row, and
**All models** writes the wildcard target without touching the prompt.

### `HEAD` — Accept the auth scheme in any case

`extractApiKey()` matched the scheme with `startsWith("Bearer ")`, so a client
sending `bearer` or `BEARER` got a 401 for a perfectly valid key. RFC 7235 makes
the scheme case-insensitive, and the failure looks identical to a wrong key, so
there was nothing for the client to act on. Measured on the live router before
the fix:

| Header sent | Before | After |
|---|---|---|
| `Authorization: Bearer <key>` | 200 | 200 |
| `Authorization: bearer <key>` | **401** | 200 |
| `Authorization: BEARER <key>` | **401** | 200 |
| `Authorization: Bearer    <key>` (extra spaces) | **401** | 200 |
| `x-api-key: <key>` | 200 | 200 |

13 assertions cover the cases, including that a bare token with no scheme and a
`Basic` header are still rejected. Verified by mutation: restoring the
case-sensitive comparison fails 7 of them.

### `HEAD` — Fix the internal API key, which had never worked

The provider page's model test reported `HTTP 401: Missing API key` for every
model, including providers with a working key. That message blamed the operator
for a failure that was ours.

`getOrCreateInternalApiKey()` backs every router-to-router self-call. Its
dynamic import of the machine-id helper resolved `../../shared/utils/machineId.js`
from `src/lib/db/repos/`, which is `src/lib/shared/…` — a directory that does not
exist. It threw `ERR_MODULE_NOT_FOUND` every time. The catch in
`getInternalHeaders()` was empty, so the `Authorization` header was simply
omitted, the self-call to `/v1` came back 401, and that 401 was what the
operator saw. Two defects, one symptom:

| | |
|---|---|
| Import path | one level short — needs `../../../shared/utils/machineId.js` |
| Cached rejection | the rejected promise was stored in `internalKeyPromise` and returned by every later call, so no restart and no retry could recover |

The silent catch is gone: if the key cannot be minted, the error says so rather
than degrading into a misleading 401.

5 assertions, verified by mutation — restoring the two-level path fails 2, and
removing the `.catch` that resets the cache fails 1.

### `HEAD` — Give the playground a real backend, and align the key gate

**The playground was not connected to anything.** Its run handler built the
"output" by concatenating strings locally:

```
Would inject into <model>:

<prompt>

--- user turn ---
<input>
```

Nothing was sent, there was no baseline, and the result looked enough like a
reply that a working prompt and a broken one were indistinguishable — without
shipping the prompt to live traffic to find out. `POST /api/system-prompts/try`
now exists and both legs go through `handleChat()`, the same entry point customer
traffic uses, so what the operator sees is what a customer would get. The panel
runs the prompt and, optionally, the same question with no prompt as a baseline.

**Eight handlers enforced requireApiKey, written separately, and had drifted.**
Only `chat` knew a provider with `noAuth: true` has no key for the operator to
present; the other seven still rejected `oc/*`, so the same model was reachable
through one endpoint and not another. `lib/auth/apiKeyGate.js` is now the single
verdict and all eight call it — an assertion in the test suite fails if any
handler goes back to reading `settings.requireApiKey` directly.

The exemption stays narrow: an unknown prefix, a bare model name and an empty
model all still require a key, and `requireApiKey` continues to gate every
provider that has credentials.

**The internal-call exemption is not expressible by header.** The playground
needs to reach `handleChat()` without a client key, and the first attempt read
`x-9r-auth-checked: 1` — which anyone who found `/v1` could have sent to walk
straight through the gate. It is now a Symbol-keyed property on the Request
object (`lib/auth/internalCall.js`), which an external caller has no way to set.
Covered by an assertion that a forged header does not read as internal.

14 assertions. Suite total is 160 across 12 suites.

### `HEAD` — Rescue API keys that died when hashing landed

Keys were stored in the clear before bca7ab6 and hashed after it.
`validateApiKey()` has only ever looked a key up by `sha256(salt:key)`, so a row
still holding plaintext stopped matching at the moment hashing landed. Every key
the operator already had began answering 401, while the dashboard kept working —
which is what makes the symptom confusing, because the dashboard authenticates
on a session cookie rather than an API key.

Reproduced before fixing:

| Stored as | Found by validateApiKey | Result |
|---|---|---|
| plaintext `sk-legacy-…` | `sha256(salt:sk-legacy-…)` | **401** |
| `sha256(salt:sk-…)` | `sha256(salt:sk-…)` | 200 |

Migration `003-rehash-plaintext-api-keys` converts the plaintext rows at startup.
It imports `hashApiKey` rather than copying the salt — a second copy would
produce different digests and turn the migration into a no-op that looks like it
ran. A stored value that is already 64 hex characters is a digest and is left
alone, so running it twice changes nothing.

The legacy JSON import path had the same flaw: it inserted `k.key` as issued, so
a re-import would reintroduce plaintext and undo the migration. It now hashes on
the way in and passes already-hashed values through.

12 assertions, driven through a real database: the key is rejected before the
migration, accepted after, still accepted after a second run, and a key that was
never issued is still refused. Suite total is 172 across 13 suites.

### Earlier

- `11b580f` — first-boot bootstrap generates and persists the dashboard password
  and the three secrets, so a fresh deploy needs no variables set
- API keys stored hashed rather than plaintext
- 13 dependency advisories patched (`npm audit fix`), leaving one `low` with no
  upstream fix

---

## Verification

`npm run test` — **172 assertions, 13 suites, all passed**; `npm run typecheck`
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
| `test-extract-api-key.mjs` | 13 |
| `test-api-key-gate.mjs` | 14 |
| `test-api-key-rehash.mjs` | 12 |
| `test-internal-api-key.mjs` | 5 |
| `test-skills-route.mjs` | 13 |
| `test-auth-gate.mjs` | 26 |

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

### Plug and play — verified from an empty clone

The point of the template is that someone else can deploy it. That was checked
end to end from a fresh `git clone`, with **no environment variables set** —
`env -i`, only `PATH`, `HOME`, `DATA_DIR` and `PORT`:

| Step | Result |
|---|---|
| `git clone` | 17 commits, 882 files, no `.env`, no workflows |
| Secret scan, working tree | 0 credentials across 882 files |
| Secret scan, full history | 0 credentials across 1329 objects |
| `npm install` / `build` / `typecheck` / `test` | exit 0, 128 assertions |
| First boot | database created, dashboard password generated, three secrets generated and stored |
| Login with the generated password | succeeds; `passwordIsGenerated: true` |
| Wildcard prompt → `/v1/chat/completions` | `PLUGPLAY-OK` returned, 179 prompt tokens |
| Server log | `[SYSPROMPT] pnp-wildcard → * | openai` |

So the operator's real path is: clone, deploy, read the password from the deploy
log, log in, add a prompt, and it reaches the model. No variable to set, no key
to create, nothing to configure first.

The generated password is printed once and never again, and no credential from
any of this is committed — the values above were read from the process log at
run time and are not reproduced here.

### Repository and deployment state

Checked against GitHub and the live router, not from memory:

| | |
|---|---|
| Repository | `otodidak404/syns4033router`, public, `fork: false`, parent: null |
| Default branch | `master`, working tree clean, HEAD matches origin |
| GitHub Actions | 0 workflows in the tree, 0 runs, 0 secrets |
| Health | `{"status": "ok", "version": "3.0.0"}` |
| Auth guard | `/API/keys` → 401, `/v1` without a key → 401 |
| Active deployment | `21:21:17Z SUCCESS` |
| Volume | mounted at `/data`, Ready, survives a redeploy |
| Served bundle | `index.rEM-m8JB.js` — matches the local build |

Two files mention `railway.app` and neither is a leaked deployment:
`README.md:184` is the deploy-button badge and
`backend/src/routes/cli-tools/claude-settings/route.ts:73` is a base-URL
allowlist suffix. The operator's own domains appear in neither the tree nor the
history.

No commit hash is recorded here on purpose: it would be stale by the next
commit. Read it with `git log -1`, and check the two facts that actually matter
— `git status --porcelain` empty, and `HEAD` equal to `git ls-remote origin
master`.

Deploys are driven by `railway up` from a local clone; the service is not linked
to GitHub, so a push does not deploy on its own.

---

## Known issues

- **The idempotency guard compares the whole block**, including the label
  (`livePrompt.js:102`). Two entries carrying the same prompt under different
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