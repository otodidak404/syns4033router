# Changelog

Format: entries under **Fixed** must name **file:line** and be backed by a test
or a recorded run. Anything unproven belongs under **Known issues**, not there.
Sections are `## Fixed
### Test suites share one scanner instead of three copies

`walk` and the bracket-matching `batchedWrites` scan existed in two suites after
this defect was found on four pages. They now live in
`backend/testlib/frontend-scan.mjs` and both import them, so a fix to the scan
lands in one place. The repo-wide batch assertion moved entirely to
`test-usage-page.mjs`; `test-providers-page.mjs` keeps only what is specific to
its page.


### `/dashboard/usage` — the bulk connection toggle could fail silently

`bulkSetActive` on the Provider Limits panel awaited `Promise.all` over
`PUT /api/providers/:id` and then reconciled the list. fetch() rejects only on a
network error; an HTTP 404 or 500 resolves. So the aggregate resolved, the
reconcile re-read the unchanged server state, and the operator was told the bulk
enable or disable had worked when none of it had.

Each write is now chained through `expectOk` and the settled results are read
before the reconcile runs.

### `/dashboard/media-providers` — same defect, found by the guard rather than by reading

The `test-usage-page.mjs` scan walks the whole frontend rather than one page, and
it turned this up on a menu that has not been audited. The provider toggle on the
media-provider page had the identical unguarded `Promise.allSettled` write. Fixed
the same way.

That is the fourth page carrying this bug — `/dashboard/providers`,
`/dashboard/combos`, `/dashboard/usage` and `/dashboard/media-providers` — each
found separately, each in a different shape. A test scoped to the page it was
written for would have let the next one through, so the suite is repo-wide: any
batched write anywhere in `frontend/src` without `expectOk` turns it red.

Covered by `backend/test-usage-page.mjs` (5). Five mutations turn it red:
removing either guard, deleting the settled-results check, removing an import,
and making `expectOk` return instead of throw. Two of those tests had to be
repaired first — the batch regex required a literal "settle" and matched nothing,
and the throw assertion tested the whole `api.js` file rather than the
`expectOk` body, where `handleResponse` throws too.


### `/dashboard/combos` — a combo posted with a string instead of a list called one character at a time

`getRotatedModels` reads `models.length` and spreads the list into a new array. A
string satisfies both: `"oc/space-bunny-free".length` is 20 and `[...str]` yields
its characters. `POST /api/combos` validated the name and never looked at
`models`, so it answered 201 and stored the string. Calling that combo:

```
models: "oc/space-bunny-free"   →  tries "o", "c", "/"  →  "o" resolves to openai
HTTP 404  {"error":{"message":"No active credentials for provider: openai"}}
```

The error names a provider the operator never configured, which is the part that
costs time. `[123, null, {x:1}]` was stored just as readily.

`validateModels` now refuses a non-array and any entry that is not a non-empty
string, on both the create and the update route. An absent `models` field is
still fine — that is the empty combo — and the name rules are untouched.

### `/dashboard/combos` — the round-robin switch moved before the save

`handleToggleRoundRobin` awaited a `PATCH /api/settings` and never looked at the
response, then set state. A 4xx or 5xx resolves rather than rejects, so a
rejected save left the toggle showing a round-robin the server never stored. It
now throws on a non-ok response, which the existing catch already handles.

Also checked and left alone: fallback across the 16-model `JB` combo works —
consecutive calls land on different models — and a request that exhausts the
list can exceed 60s, which is the fallback walking it, not a hang.

Covered by `backend/test-combos-page.mjs` (7), which executes `validateModels`
rather than only matching it. Six mutations turn it red, including removing the
`Array.isArray` check, un-calling the validator from either route, dropping the
string test, and restoring the optimistic toggle.


### `/dashboard/system-prompt` — every failed run reported the same unusable message

A model that does not exist, a model that exists but has no key, and a provider
that answered with an error body all arrive at the same branch: the upstream body
is read, `extractText` finds no assistant text, and the reason is discarded. Live,
all three returned exactly `"The model returned no text for this run."` — which
names neither the model, the provider, nor the cause, and is the one result an
operator cannot act on.

`failureReason(raw)` in `routes/system-prompts/try/route.ts` now reads `error`,
`message` or `detail` from the body it already has, handles a nested
`{ message }`, caps the text at 240 characters so a verbose upstream error cannot
flood the panel, and keeps the generic wording for a body that is genuinely empty
or not JSON.

CRUD, validation and the playground itself were re-checked on the live
deployment and needed no change: create/read/update/toggle/delete all round-trip,
`GLOBAL-JB` (`*`) is refused with an explanation rather than silently running
nothing, the 200k limit matches the one the library enforces, and the five stored
entries were left untouched by the audit.

Covered by `backend/test-system-prompt-page.mjs` (6), which executes the helper
rather than only matching its source. Five mutations turn it red: restoring the
fixed string, dropping `message` from the fields read, removing the call,
removing one of the two fallbacks, and making the store limit disagree with the
playground. The first version of that last check counted `return` statements,
which stayed at three when a fallback was deleted and so missed it.


### `/dashboard/providers` — a rejected write left the UI showing a state the server never took

`fetch()` rejects only on a network error. An HTTP 404 or 500 is an ordinary
response, so it resolves. Verified against the live deployment rather than
assumed:

```
PUT /api/providers/tidak-ada-xyz   → 404
Promise.all      → catch jalan? false
Promise.allSettled→ fulfilled, .ok = false
```

Every one of these call sites set local state before the request went out, so a
write the server rejected left the card showing an order, an enabled flag or a
deleted row that never happened. The batch delete was the worst: it filtered the
rows out of the list on the next line regardless of outcome, so a connection that
was never deleted looked deleted.

`frontend/src/shared/utils/api.js` gained `patch` — it had `get`, `post`, `put`
and `del`, which is why these sites hand-rolled `fetch` in the first place — and
`expectOk`, which turns a failed response into a rejection. Fixed at:

- `providers/page.jsx` batch enable/disable (`Promise.allSettled`, now inspected)
- `providers/components/ConnectionsCard.jsx` strategy save, priority swap, reset-all
- `providers/[id]/page.jsx` strategy save, priority swap, batch delete

### `/dashboard/providers` — a 1722-line abandoned rewrite shipped beside the live one

`frontend/src/pages/providers/[id]/page.new.jsx` had zero importers, no glob-based
route picks it up, and only 7 of its 1762 lines matched the live `page.jsx`. It
is an abandoned rewrite sitting under a name that reads as current, next to the
file that actually renders. Deleted; the build is unchanged.

Covered by `backend/test-providers-page.mjs` (6). Five mutations each turn it
red: making `expectOk` return instead of throw, and removing the chain from the
priority swap, the batch delete and the group toggle, plus restoring the dead
file.


### `/dashboard/endpoint` — Tailscale install crashed on an empty request body

`express.json()` has already consumed and parsed the stream by the time a handler
runs, so `req.body` is a plain object. `POST /api/tunnel/tailscale-install` called
`req.body.catch(...)` as if it were still a promise, which threw a `TypeError`
before the handler did any work:

```
500  POST /api/tunnel/tailscale-install  {"error":"req.body.catch is not a function"}
```

`routes/auth/oidc/test/route.ts` had the same line. Both now read
`req.body || {}`. This is the same class of defect that broke
`/api/system-prompts/try` earlier, so `backend/test-req-body-parsed.mjs` now walks
every file under `backend/src` and fails if `req.body` is treated as a promise
anywhere, rather than waiting for the next one to be clicked.

Found while verifying the tunnel fix: the spawn crash was gone, and the request
that used to kill the process then returned a real error — which exposed this.



### `/dashboard/endpoint` — clicking Tailscale took the whole server down

`spawn()` reports a missing executable by emitting `error` on the ChildProcess,
not by throwing, so a route's `try/catch` never sees it — nothing was thrown
inside the promise. With no listener Node treats that as an unhandled `error`
event and exits the process.

Thirteen `spawn` calls in `src/lib/tunnel/` had no listener. On Railway there is
no `tailscaled`, `cloudflared`, `sudo` or `brew`, so every one of them was a live
crash button on this page. Observed live:

```
POST /api/tunnel/tailscale-enable    → 502
Error: spawn tailscaled ENOENT
  throw er; // Unhandled 'error' event
npm error code 1
```

The Railway process exited and came back on its own, which is why it looked like
a transient edge error rather than an outage. `src/lib/tunnel/tailscale/tailscale.js`
and `src/lib/tunnel/cloudflare/cloudflared.js` now route every spawn through a
`spawnSafe` helper that attaches the listener and logs the failure.

### `/dashboard/endpoint` — a toggle could show a value the server never stored

`patchSetting` awaited `fetch` and ignored the response, so a failed save
resolved as success. Three handlers set their switch first and saved second:
`handleCavemanEnabled`, `handleCavemanLevel`, `handleTunnelDashboardAccess`. On a
failed write the switch kept the new position while the server kept the old one.

`patchSetting` now throws on a non-ok response and logs the status and body, and
the handlers move their state only after the save resolves — the pattern
`handleRequireApiKey` and `handleRtkEnabled` already used. The `.catch` on the
two caveman handlers is what keeps that rethrow from surfacing as an unhandled
rejection.

Covered by `backend/test-endpoint-page.mjs` (6) and
`backend/test-tunnel-spawn-guard.mjs` (4). Four mutations were applied and each
turns the suite red: removing the spawn guards, making `patchSetting` accept any
status, restoring the optimistic toggle, and dropping its catch.

`, `## Verification`, `## Known issues` — one top-level
heading each, in that order, with no horizontal rule splitting a section in two.

---

## Fixed

### `52bd983` — Pick a default free model that actually answers

The playground's auto-chosen default was the first `oc/*` id in the catalogue,
which was `oc/deepseek-v4-flash-free` — a model upstream refuses. Measured
against this deployment, over `/v1/chat/completions` with a router key:

| Model | Result |
|---|---|
| `oc/space-bunny-free` | `0.8s` → 200 `'OK'` |
| `oc/deepseek-v4-flash-free` | 400 |
| `oc/fledge-alpha-free` | 403 |
| `oc/jev-1.13-free` | 500 |
| `oc/mimo-v2.5-free` | 403 |
| `oc/nemotron-3-ultra-free` | 403 |

So the provider's own catalogue lists ids that do not serve, and picking from it
blindly lands on a model that cannot run. The default now comes from a short list
of models observed to respond, still gated on the catalogue so an empty one falls
through, and still overridable in the UI.

### `29beec9` — Restore the catalogue state the stray block took with it

Deleting the module-scope JSX also removed the `useState` pair declared in the
same region, so the playground threw `ReferenceError: catalog is not defined` on
render. The suite now pairs each state setter with a declaration **inside the
component that calls it** — the first version compared against every declaration
in the file, which is too weak, because `setCatalog` also exists in a sibling
component and so deleting the playground's copy still looked declared.

### `a209bf1` — Remove the stray JSX that blanked the playground

A copy of the model-chooser block had been left at module scope, above the
imports. JSX there is a valid expression statement, so `tsc --noEmit` and
`vite build` both accepted it — build exit 0, typecheck exit 0, 228 assertions
green — and the page died at runtime with
`ReferenceError: entryNamesAModel is not defined`. Found by driving the deployed
page in Chromium and reading the console, which is the only layer that can see
this class.

The suite now asserts no JSX above the first import, that the module opens with an
import, and that the chooser block appears exactly once.

### `8a284e3` — Choose the playground's test model instead of asking for one

A global entry carries the wildcard `*`, which selects every model at injection
time and names none of them, so a concrete model has to be chosen to run it on.
The previous fix left that as the operator's job — a text field plus a catalogue
button, Run disabled until one was filled. The playground now fetches
`/api/models` and chooses one itself, shows it, and offers **Ganti**. The
free-text field is gone.

### `e8767d4` — Add the free models to the backend catalogue too, and pin the two copies

`09ce298` fixed the frontend catalogue and the picker still had nothing to show.
The backend keeps its own copy under `open-sse/config`, and `/api/models` and
`/v1/models` read that one — so a deploy with only the frontend fixed still
reported `0` `oc/*` models, which the live check caught.

Both copies now carry the same twelve free ids. The suite compares the two and
fails on drift, and also fails if the `oc` block is emptied or parked again, if a
non-free id appears under a provider declared `noAuth`, or if duplicates appear.

### `09ce298` — Let the playground pick a model, and put the free models back

The `oc` entry in the catalogue had all five of its models commented out, and
every one of those ids is gone from OpenCode upstream — which is presumably why
they were commented out. A provider with no catalogue entries appears in no
picker and in no `/v1/models` listing, so `oc` was invisible everywhere while
still working when called directly.

Separately, model discovery went out with no `User-Agent`, which upstream
Cloudflare answers with `403` (error code `1010`) — any User-Agent, even an empty
one, returns `200`. Note that `fetchSuggestedModels` has no callers, so discovery
does not feed `/api/models` or `/v1/models`; the catalogue fix is what makes the
picker work.

### `86b9eac` — Override dompurify past monaco-editor's exact pin

`monaco-editor` 0.57 declares `dompurify` `"3.4.15"` exactly, and that release
carries `GHSA-p98j-92pf-mc4p` — DOM XSS via a detached subtree left armed after
an `IN_PLACE` `afterSanitize` hook. The patched release is 3.4.16, which npm will
not install for an exact-pinned transitive dependency. An override forces it. No
direct dependency is added, since the root package does not import dompurify.

Audit goes from `3 low, 0 moderate, 1 high` to `0 low, 0 moderate, 1 high`. The
remaining high is `node-forge` `GHSA-86w9-cpqp-85rv`, no fix available, and not
reachable here: `backend/src/mitm/cert/rootCA.js` uses node-forge only for
`rsa.generateKeyPair`, `createCertificate`, `certificateFromPem` and
`md.sha256`, and never verifies a signature.

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

### `1868194` — Accept the auth scheme in any case

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

### `408e82a` — Fix the internal API key, which had never worked

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

### `fd8fd30` — Give the playground a real backend, and align the key gate

**The playground was not connected to anything.** Its run handler built the
"output" by concatenating strings locally:

```
Would inject into <model>:

<prompt>

--- user turn ---
<input>
```


| check | result |
|---|---|
| `npm run test` | 286 assertions, 27 suites, all passed |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `/api/tunnel/tailscale-*` before | 502, process exited |
| `/api/tunnel/tailscale-*` after | 200 / 500 with a real message, process alive on 4/4 checks |
| live toggle round-trip | `cavemanEnabled`, `cavemanLevel`, `requireApiKey`, `rtkEnabled`, `tunnelDashboardAccess` all persist |

`PATCH /api/settings` accepts an unknown key and an out-of-range `cavemanLevel`
without complaint, returning 200 either way. Not exploitable — the values are
inert and only ever written by this dashboard — but they are stored, so a bad
value can sit in the config until something reads it.


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

### `b62bc4b` — Rescue API keys that died when hashing landed

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

### `6112c03` — Close the SSRF on both outbound-fetch routes

A URL that arrives in a request is attacker-controlled input, and fetching it
verbatim turns the server into a proxy for whatever the server itself can reach —
the cloud metadata service on `169.254.169.254`, a private range, the
container's neighbours. Two routes did this:

| Route | Before |
|---|---|
| `providers/suggested-models` | `fetch(url)` straight from the query string — no host check, no scheme check |
| `media-proxy` | hostname allowlist only, no scheme check, and `fetch` following redirects by default |

The second one is the subtler: an allowlisted CDN can answer `302` and the
request follows it, so a URL that passed the allowlist could still land on
`169.254.169.254`. Checking the input URL is not enough while redirects are
followed.

`lib/net/ssrf.js` is now the single decision for both. It checks the scheme
(http/https only), the host against an exact-or-subdomain allowlist — never a
substring match, so `evil-replicate.com` cannot pass as `replicate.com` — and
then resolves the hostname and requires **every** address it returns to be
public, which is what closes DNS rebinding. Redirects are walked by
`fetchWithRedirectChecks()` with `redirect: "manual"`, so each hop is rechecked
against a 3-hop limit.

`suggested-models` now refuses any host outside the catalogue allowlist and
returns 403. A filter type with no entry in `FETCHER_HOSTS` is refused rather
than fetched unchecked, and an assertion fails the suite if a filter is added
without a host — so the list cannot quietly fall behind the catalogue.

23 assertions, including the two that would make the guard useless if they broke:
an allowlisted host must still pass, and a subdomain of one must pass too. The
rest cover the metadata address, loopback, the three private ranges, carrier NAT,
IPv4-mapped IPv6, `file:`/`gopher:`/`data:`, lookalike hosts, and credentials in
the authority.

Suite total is 199 across 15 suites.

**One open discrepancy, unresolved.** Three hosts that are in the allowlist —
`weavy.ai`, `runwayml.com`, `minimaxi.com` — are refused by the running server
with `Domain not allowed`, 5/5 identical attempts, while `replicate.com`,
`v3b.fal.media`, `storage.googleapis.com` and `hailuoai.com` from the same list
return 200. The cause is not identified. What was ruled out: the allowlist is
byte-identical between the initial commit and HEAD (20 entries, none added or
removed); the deployed source matches the repo; the server is running this
commit, since the new `suggested-models` message appears; `dist/` is untracked so
the image cannot carry a stale build; and all four hosts resolve to public
addresses via `dns.lookup` with the same options the guard uses. Calling
`checkFetchableUrl` locally against that exact source returns `ok: true` for all
three.

The direction of the failure is fail-closed, so this is a functional bug rather
than a hole: media for those three providers will not proxy. Left visible rather
than papered over, because guessing at a cause here would be worse than the
known state.

### Earlier

- `11b580f` — first-boot bootstrap generates and persists the dashboard password
  and the three secrets, so a fresh deploy needs no variables set
- API keys stored hashed rather than plaintext
- 13 dependency advisories patched (`npm audit fix`), leaving one `low` with no
  upstream fix

---

## Verification

Recorded against `52bd983`, tree clean, `HEAD` equal to `origin/master`.

```
npm run typecheck    exit 0
npm run build        exit 0
npm run test         exit 0   233 assertions, 18 suites, all passed
npm audit            0 low, 0 moderate, 1 high  (node-forge, unreachable)

deploy               SUCCESS · boot errors 0
/api/models          871 models, 12 of them oc/*
```

Live, in Chromium against the deployed page — not inferred from a passing build:

```
playground   label "Testing against"    ok
             button "Ganti"             ok
             input demanding a model   none
             runtime errors            none
             "(empty reply)"           0

             JB        820ms   "Hi. What do you need?"
             BASELINE  889ms   "Hai. What need?"
```

**What the passing checks did not catch.** Two fixes in this range shipped broken:
`8a284e3` and `29beec9` each blanked the page with a `ReferenceError` while
`tsc`, `vite` and 231 assertions were all green. The cause was JSX left at module
scope, which parses as a valid expression statement, so no compiler sees it. Only
running the page in a browser surfaced it. The suite now checks module shape and
per-component setter declarations instead of relying on the compiler.


`npm run test` — **233 assertions, 18 suites, all passed**; `npm run typecheck`
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
| `test-route-imports.mjs` | 4 |
| `test-ssrf-guard.mjs` | 23 |
| `test-playground-extract.mjs` | 13 |
| `test-playground-target-model.mjs` | 15 |
| `test-model-catalogue.mjs` | 6 |
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

Most of OpenCode's free catalogue does not currently serve. Measured against
this deployment over `/v1/chat/completions` with a router key:

| Model | Result |
|---|---|
| `oc/space-bunny-free` | `0.8s` → 200 `'OK'` |
| `oc/deepseek-v4-flash-free` | 400 |
| `oc/fledge-alpha-free` | 403 |
| `oc/jev-1.13-free` | 500 |
| `oc/mimo-v2.5-free` | 403 |
| `oc/nemotron-3-ultra-free` | 403 |

The twelve ids are listed because OpenCode lists them, not because they answer.
The playground's default is therefore drawn from a short list of models observed
to respond, which means it will need updating if upstream starts serving more —
there is no live probe behind it, by choice, since a probe on every page load
would be a request the operator did not ask for.

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