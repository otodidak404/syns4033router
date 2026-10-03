# Changelog

Format: entries under **Fixed** must name **file:line** and be backed by a test
or a recorded run. Anything unproven belongs under **Known issues**, not there.
Sections are `## Fixed

### A failed read on the media-provider list looked like "you have no connections"

`/dashboard/media-providers/[kind]/page.jsx` — which is the list page for STT —
swallowed all three of its reads with `.catch(() => {})`. Every card derives its
badge from the `connections` array, so an outage rendered every provider as
"0 Added", and the operator's reading was that their STT connections had been
deleted. The reads now report, the page says it is incomplete, a card shows
"Status unknown" instead of "0 Added", and the enable/disable toggle refuses to
fire against a list that was never loaded — writing on the strength of an empty
list is how a burst toggle ends up disabling everything.

### Saving a fallback strategy could erase every other provider's strategy

`ConnectionsCard.saveStrategy` read `/api/settings` with
`const data = res.ok ? await res.json() : {}`. On a failed read that produced an
empty map, and `providerStrategies` is a whole-map PATCH — so one 500 while
saving a round-robin strategy for one provider wiped the strategies of every
other provider. The read is now guarded like the write. Same shape as the
`comboStrategies` wipe fixed earlier on the combo page.

### Eleven writes in two shared components reported success on failure

`ConnectionsCard` and `ModelsCard` are mounted by every media-provider detail
page, STT included. Both checked `res.ok` and then said nothing when it was
false: delete, toggle, proxy change, reorder, add connection, edit connection,
set alias, remove alias, add custom model, remove custom model. `fetch` rejects
only on a network error, so an HTTP 409 ran straight past the check. All of them
go through `expectOk` now and render the failure. Reordering already rolled back
on failure — the rollback was never the problem, the silence was.

`ModelsCard.handleTestModel` also read `res.json()` unguarded, so a 500 with a
non-JSON body threw out of the try and left the card spinning.

### A claim in this changelog was wrong

`d276325` recorded "PATCH provider list/detail/ConnectionsCard". The test written
for that work never mentioned ConnectionsCard — the string does not appear in
`test-providers-page.mjs` at all. ConnectionsCard is 634 lines and ModelsCard 304,
both reachable from the STT page, both unchecked until now.

- `backend/test-media-shared-cards.mjs` (13 assertions) covers all three files and
  first asserts that the STT page really does mount the two components, so it
  cannot quietly stop applying. Seven mutation controls: reverting the settings
  wipe, reverting the silent delete, deleting the reorder message, reverting the
  alias write, reverting the model-test body guard, removing the list's `res.ok`
  check, and removing the toggle block. Six of the seven failed to fire on the
  first attempt because the assertion was too loose — a neighbouring handler's
  `setActionError("")` satisfied a check that meant to see the reorder's own
  message.

xed

### Four STT models advertised a language setting that was thrown away

`/dashboard/media-providers/stt` shows a Language field whenever the selected
model's `params` array lists it, writes `-F "language=..."` into the curl snippet,
and sends the field. For four models the core never read it:

```
huggingface/openai/whisper-large-v3   huggingface-asr   language dropped
huggingface/openai/whisper-small      huggingface-asr   language dropped
assemblyai/universal-3-pro            assemblyai        language dropped
assemblyai/universal-2                assemblyai        language dropped
```

Set Thai, get an English transcript, no warning. AssemblyAI ignores an explicit
language while `language_detection: true` is set, so it now turns detection off
when one is given. HuggingFace cannot be made to honour it on this endpoint, so
the param is removed from those two models rather than left as a control that
does nothing. All 18 STT models now agree with what their provider format reads.

### A non-multipart body answered 500 instead of 400

`POST /v1/audio/transcriptions` with a JSON body returned
`500 {"error":"Response body object should not be disturbed or locked"}`.
`express.json()` and `express.urlencoded()` run globally in `server.ts` and drain
the request stream for their own content types, and the route then wrapped that
drained stream in a Web Request. The handler already had the right 400 branch;
the request never reached it. The route now checks the content type first.

### The Gemini STT key travelled in the query string

`transcribeGemini` built `…:generateContent?key=<token>`, putting a credential in
every access log and proxy trace between the router and Google. Sent as
`x-goog-api-key` now, which is the documented alternative.

### test-route-imports only checked the built output

A relative import with the wrong depth in `src/` builds, passes `tsc --noEmit`,
and passes the `dist/` sweep whenever `dist` is stale — it only fails when the
container starts, and the auto-router aborts the **entire server** on one bad
route file. The path added above was `../../../../` where the module lives five
levels up. `src/routes` is now swept as well: 249 specifiers across 144 source
files, and the resolver swaps a trailing `.js` for `.ts`, which the tree does
routinely. Three mutation controls: wrong depth, a file that does not exist, and
one level too deep.

- `backend/test-stt-flow.mjs` (11 assertions) executes `handleSttCore` against a
  stubbed fetch and inspects the outgoing request, so "the language reaches the
  wire" and "the key is not in the URL" are measured rather than assumed. The
  suite is serialised because several cases swap `globalThis.fetch`; run
  concurrently they overwrote each other and reported five calls where there was
  one. Four mutation controls, including a half-fix that sends the language but
  leaves detection on.

xed

### Eleven routes read a variable that was never declared

`backend/test-unbound-identifiers.mjs` parses every `.js`, `.ts` and `.tsx` under
`backend/src` and `backend/open-sse` with `@babel/parser` and reports any
identifier that is read with no binding in an enclosing scope. It found eleven
routes in the same shape as the four earlier ones — the parameter is named `req`
and the body reads `request`.

Confirmed dead on the deployed instance before the fix:

```
POST /v1/api/chat           500 {"error":"request is not defined"}
POST /v1/responses/compact  500 {"error":"request is not defined"}
```

`/v1/api/chat` is the Ollama-compatible chat endpoint and `/v1/responses` was
equally dead; both answer `200` now, with `oc/space-bunny-free` and no
regression on `/v1/chat/completions`, `/v1/messages` or
`/v1beta/models/:generateContent`.

The rest sit behind auth or on paths this instance does not serve, so they were
fixed on the strength of the class and are **not** claimed verified end to end:

- `auth/oidc/start`, `auth/oidc/callback`, `auth/oidc/test` — `getPublicOrigin(request)`
- `pricing` — `GET_DEFAULTS` returned `res.json` with no `res` in scope
- `shutdown` — Next.js `headers()` with no import
- `health` — `NextResponse` with no import, so every preflight threw
- `media-proxy` — `NextResponse`, a `CORS_HEADERS` that was never defined, and
  `HEAD` calling `GET`, which does not exist under that name
- `cli-tools/antigravity-mitm` — `execAsync` with no import, so the availability
  probe threw instead of reporting `agy` as missing

### The check itself has two blind spots, both found by testing it

It skips a name read only inside `typeof`, which is correct — `typeof x` on an
undeclared name does not throw. And it skips object and class *keys* while still
reading their *values*: skipping the whole `ObjectProperty` would have missed
`clientApiKeyRequired({ model: modelStr })`, which is the exact shape of the
`search.js` defect. It has a self-test that reproduces all four past bugs and one
that feeds it correctly-bound code, so a rewrite that goes quiet fails.

`@babel/parser` and `@babel/traverse` are declared as backend devDependencies —
they were already resolving transitively at 7.29.7 through the frontend, and
relying on that would leave the check one version bump away from silently
disappearing.

Four mutation controls, run against the real files: removing the TTS
`apiKey` declaration, restoring `modelStr`, removing the `hashApiKey` import, and
restoring `request.headers`. The last one did **not** fire while the check was
`.js`-only, which is why `.ts` is in scope now — three of the four original
defects lived in a `.ts` route file.

xed

### /v1beta could run any model without a key, and never worked at all

`POST /v1beta/models/<model>:generateContent` — the Gemini-compatible endpoint —
had no key check whatsoever. It also answered `500
{"error":"request is not defined"}` for every caller: the handler is declared
`(req, res, { params })` and there is no binding named `request`, so
`headers: request.headers` threw on the first attempt. Two dead ends in front of
a route that was wide open — and fixing the ReferenceError on its own would have
turned it into an unauthenticated path to every model, past `requireApiKey`. Both
halves landed together, and a test pins the gate ahead of the forwarding call.

Correcting that surfaced a third fault: `new Request(req.url)` throws
`Failed to parse URL from /v1beta/models/…` because `req.url` is relative and is
also rewritten by the `/v1beta` mount. Built from `protocol` + `host` +
`originalUrl`, as the Claude-format route does.

Verified over HTTP against a booted server: `401` without a key, `200` for
`oc/space-bunny-free` without a key (the noAuth exemption applies here because
this route does know the model), and with a valid key the request reaches the
provider layer — `404 No active credentials for provider: ollama` on a database
with no Ollama connection. Streaming is gated the same way.

### /v1beta/models listed the provider inventory to anyone

Same shape as `/v1/models`: `200` with no key, returning every provider prefix
and model id in Gemini format. Gated now, preflight included.

### One gate instead of five copies

`catalogueKeyGate(req, model)` in `backend/src/lib/auth/catalogueGate.js` backs
all five routes. A listing passes `model: null`, because it has no model and
`isNoAuthModel` cannot exempt it; a generation passes the real model, so
`oc/space-bunny-free` stays reachable. `backend/test-models-and-cors.mjs` also
checks that every route resolves its import to a file that exists — `tsc` does not
verify `.js` specifiers, and `../../../lib/auth/catalogueGate.js` in
`v1/models/info` was silently wrong, resolving under `src/routes/`.

- Six further mutation controls: removing either v1beta gate, restoring the bare
  `req.url`, restoring `request.headers`, breaking the `info` import path, and
  emptying the gate in `[kind]`.

xed

### /v1/models published the operator's configuration to anyone

`GET /v1/models`, `/v1/models/{kind}` and `/v1/models/info` answered `200` with no
key and returned combo names, custom prefixes, per-connection aliases and the
whole model inventory. The outer middleware lets all of `/v1` through
(`PUBLIC_PREFIXES`) and delegates the key check to each handler; every execution
handler does it, the listing endpoints never did. All three now reject a request
with no valid key, preflights included — an `OPTIONS` that answers `204` to every
origin is a way to learn the endpoint exists. `oc/space-bunny-free` still runs
without a key; a listing has no model in it, so it is not that case.

### /v1/models/{kind} and /v1/models/info were broken for everyone

`/v1/models/{kind}` was declared `GET(_request, { params })` while
`autoRouter.ts` calls `handler(req, res, { params })`, so the handler
destructured an Express `Response` and answered
`500 {"message":"Cannot destructure property 'kind'"}` on every request.
`/v1/models/image`, `/v1/models/tts`, `/v1/models/stt` and the rest have never
worked. Fixed the signature and dropped the `await` on a plain object.
Measured against the previous revision to confirm it was not a regression from
the gate above.

### CORS reflected any origin with credentials on

Measured on the deployed instance: `Origin: https://evil.example` came back as
`access-control-allow-origin: https://evil.example` with
`access-control-allow-credentials: true`, and so did `Origin: null`.
`SameSite=Lax` on the session cookie kept this from becoming a session read —
every protected endpoint still answered `401` to an unauthenticated cross-origin
request — but that is not a control the API should depend on, and a null origin
is a sandboxed iframe or a `file://` page.

The dashboard is served by this same app, so its requests are same-origin and
need no CORS header at all. The middleware now reflects only a same-origin
request or one listed in `CORS_ALLOWED_ORIGINS`, and adds the Vite dev ports only
when `NODE_ENV !== "production"`. Note that about 70 `/v1` route handlers still
set their own `Access-Control-Allow-Origin: *`; that is normal for a
token-authenticated public API and is deliberately left alone — the two surfaces
authenticate differently, cookies here and bearer headers there.

- `backend/test-models-and-cors.mjs` (7 assertions) calls the compiled route
  handlers from `dist/` and checks each refuses without a key, pins the
  `(req, res, { params })` signature against `autoRouter.ts`, and rejects the old
  CORS shape. Seven mutation controls: removing each gate, restoring the `[kind]`
  signature, allowing every origin, applying dev origins in production, and
  ignoring the allowlist.

xed

### Settings import died on every call: `hashApiKey` was only re-exported

`backend/src/lib/db/index.js` re-exports its repositories with
`export { ... } from "./repos/x.js"`, which publishes a name without creating a
local binding. `importDb` called `hashApiKey(k.key)` from its own body, so every
import threw `ReferenceError: hashApiKey is not defined` — the plaintext-key
hashing that was added to `importDb` had never run once. Found by running eslint
`no-undef` over `backend/src` and `backend/open-sse` (338 files); it is the only
real finding there, and the same shape as the `fd8fd30` `modelStr` bug in
`tts.js` and `search.js`.

```js
import { hashApiKey } from "./repos/apiKeysRepo.js";
```

- `backend/test-handler-entrypoints.mjs` gained two cases: one calls `importDb`
  and asserts it does not throw, the other statically rejects any name that is
  re-exported and then called from the barrel's own body. The static case models
  function-scoped dynamic imports, because `exportDb` binds `exportSettings` that
  way and that name is correct.
- Two of three mutation controls fire; the third (deleting the re-export line) is
  not a valid mutant, since the real import keeps the call bound.

xed
### The handler sweep, and a timeout it was missing itself

`sweep-handlers.mjs` imports every request handler under `src/sse/handlers` and
calls each exported single-argument function with a minimal `Request`. It is how
`search.js` was found. Scope, stated plainly: 8 files, 8 entrypoints — it does
not cover `open-sse/handlers/`, which holds provider adapters and cores rather
than request entrypoints.

```
files 8 · ok 8 · importFail 0 · importTimeout 0 · refErr 0 · other 0 · timeout 0
```

The sweep had a defect of its own: calls were capped at 2.5s but imports were
not, and a module that does work at import time left it running past 845s before
being killed. Both are capped now.


### `/v1/search` — the same commit broke a second endpoint

`search.js` line 50 read `clientApiKeyRequired({ model: modelStr, … })` in a
function whose model binding is `providerInput`. `fd8fd30` rewrote
`if (settings.requireApiKey)` and, as with the speech handler, the identifier it
referenced never existed here. Every `/v1/search` request that reached the gate
threw `ReferenceError: modelStr is not defined`.

Found by a sweep that imports every handler and calls it, not by reading it. The
sweep covers eight call sites of `clientApiKeyRequired`; all eight now resolve to
a binding in their own file, and the suite asserts that so the next rewrite of a
key gate cannot repeat it.

Live before and after, same request:

```
before   ReferenceError: modelStr is not defined
after    401 {"error":{"message":"Missing API key", …}}
```


### `/dashboard/media-providers/tts` — I had broken `/v1/audio/speech` myself, in commit fd8fd30

Probing the endpoint directly rather than through the page:

```
POST /api/v1/audio/speech  json   → 500  {"error": "apiKey is not defined"}
POST /api/v1/audio/speech  mp3    → 500  {"error": "apiKey is not defined"}
every model, both formats
```

`ReferenceError`, not a validation failure — the handler crashes. `handleTts`
imports `extractApiKey` and never calls it. The diff:

```
-  if (settings.requireApiKey) {
-    const apiKey = extractApiKey(request);
+  if (clientApiKeyRequired({ model: modelStr, settings }).required) {
```

Replacing the `if` took the declaration with it and left `if (!apiKey)` and
`isValidApiKey(apiKey)` behind. Every speech request that reached the key gate
threw. `stt.js` was never affected — it binds `sttApiKey`.

Nothing in the suite called a request handler, which is why it survived from
`fd8fd30` to now. `test-handler-entrypoints.mjs` (4) imports the real handlers
and calls them: the speech handler must return a Response rather than throw, a
malformed body must be a 400, and every handler reading `apiKey` must declare
it somewhere in the file. It runs under the same `@/` alias loader as `npm start`
— registered with `true`, after it failed silently under the runner.

Four mutations, all caught: the declaration removed, moved below its use, the
import dropped, and the loader flag flipped.


### `/dashboard/media-providers/tts` — the voice picker asked for the wrong provider

It sent `provider="edge-tts"` for everything except `local-device`:

```
ElevenLabs, Deepgram, Inworld, Minimax, Minimax-CN
  → opened a picker full of Microsoft Edge voices
  → picking one and sending it upstream fails
```

The voices route answers for four providers and the frontend only ever asked for
two of them:

```
VOICE_FETCHERS   edge-tts · local-device · elevenlabs · gemini
requested        edge-tts · local-device
```

Live against the deployment: `edge-tts` returns 75 languages, `gemini` 1,
`elevenlabs` 502 "ElevenLabs API key required" — the route works, nothing was
asking for it.

It now sends the provider's own id, and `LISTABLE_VOICE_PROVIDERS` is checked
against `VOICE_FETCHERS` by the test so the two cannot drift apart. Where a
provider has no listable voices the Browse button is hidden rather than opening
an empty modal — Deepgram is that case: no fetcher, no manual voice id, and no TTS
models in the catalog at all. Providers with a manual voice id keep the button and
get told what to type instead.

The fetch also had no status check; a 502 with an unexpected body left the modal
open and empty. `config.apiEndpoint` was dead too — no provider sets it — and is
gone.

Live, the voices route: `edge-tts` 200/75 languages · `local-device` 200/0 ·
`gemini` 200/1 · `elevenlabs` 502 · unknown provider 400.

Two assertions, five mutations. Writing them took four attempts at the same thing
as before — a generic `} else {` anchor landed on the wrong branch in a
2000-line file, and one assertion still referenced a constant that had been
renamed. Anchors here are the comment inside the branch, not its syntax.


### `/dashboard/media-providers/image` — a provider-supplied URL was fetched verbatim

`imageProviders/_base.js`:

```js
export async function urlToBase64(url) {
  const res = await fetch(url);          // no scheme, host or address check
```

Called from `imageGenerationCore.js` on `?response_format=binary`, and from
`cloudflareAi.js`. The url is not operator input — it comes out of an upstream
response body, which is the same thing by another route: a custom
openai-compatible or custom-embedding node points at a host the operator chose,
and that host decides what url to hand back. The router would then retrieve
`169.254.169.254`, a private range, or its own neighbours and return the bytes as
the generated image. It now goes through `fetchWithRedirectChecks`, which covers
the redirect chain as well.

Two hypotheses of mine were wrong before this one landed, both caught by checking
rather than asserting:

- `providerId === "codex"` looked like a dead branch because the media catalog is
  keyed `cx`. The provider is `codex: { id: "codex", alias: "cx" }` — the id is
  `codex` and the streaming path is reachable.
- `allDisabled = total > 0 && …` with `checked={!allDisabled}` looked like a
  toggle rendering "on" for providers with no connections. The toggle is not
  rendered at all in that case: `{total > 0 && (…)}`.

The image result block gated on `data[0]` *existing* rather than on an image
being present, so a 200 carrying `{ data: { data: [{ revised_prompt }] } }` gave a
Download link with `href=""` — which reloads the page — and an `<img src={undefined}>`
that re-requested the page as an image. The source is resolved once into
`imageSrc`, the block is gated on that, and an image-less success now says so.

The first version of that check pattern-matched the component source, which proves
nothing about behaviour — the expression was never run. It now evaluates the same
`binary || (b64_json ? data: : url || "")` against the shapes that matter,
including the one that used to render a broken image, and separately asserts the
component still computes it that way.

Browser, `/image/gemini`: the page renders (1743 chars, no page errors), Output
Format is present, and Ref Image / Mask are both absent — which is correct, and
the reason is worth recording:

```
models with capabilities in the catalog : 4  (3x "edit", 1x ["edit"])
models declaring "mask"                : 0
connections available at runtime       : gemini, ollama, openrouter
```

Every edit-capable image model belongs to codex, cloudflare-ai or fal-ai, none of
which has a connection here, so `supportsEdit` is false for everything reachable
and the ~25 lines of Mask UI behind `supportsMask` can never render — no model
declares that capability at all. That is untested surface, not a bug.

Six mutations across the two assertions.


### `/dashboard/media-providers/embedding` — three nodes could share one prefix, and two of them were unreachable

Probing the custom-embedding flow live rather than reading it found what reading
missed. `sse/services/model.js` resolves a model id with
`nodes.find(n => n.prefix === alias)` — first match wins — and nothing enforced
uniqueness:

```
POST /api/provider-nodes  prefix="dupe"  → 201   (three times, three different baseUrls)
POST /v1/embeddings  model=shadow/first  → 400  No credentials for provider: custom-embedding-…9dce956b832f
POST /v1/embeddings  model=shadow/second → 400  No credentials for provider: custom-embedding-…9dce956b832f
```

Both ids resolved to the same node. The second was permanently unreachable, and
the error named an opaque node id with no hint that a duplicate existed. Create
and edit now reject a taken prefix with 409 and name the node holding it.

The same probe found the SSRF guard sitting one hop short of where the URL is
used. `/provider-nodes/validate` applied `checkFetchableUrl` to the identical
input that `POST /provider-nodes` stored unchecked:

```
POST /provider-nodes          baseUrl=http://127.0.0.1:3001  → 201 stored
POST /provider-nodes/validate baseUrl=http://127.0.0.1:3001  → 403 not a public address
```

The modal lets an operator press Create without ever pressing Check, so the
guard was advisory. Create and edit now apply the same check, and edit only
re-checks when the URL actually changed.

What I did **not** prove: whether a loopback node can be driven end to end to
steal a response. Execution stops earlier — `No credentials for provider` — and
the runtime base URL comes from `creds.providerSpecificData.baseUrl`, set through
the connection flow, which I did not trace to completion. The fix closes the
asymmetry on the input; it is not a claim that a full SSRF chain was demonstrated.

The modal was silent on top of that: `if (res.ok)` with no else, and the catch
went to `console.log`. A 409 or 403 came back and the form simply stopped
submitting with nothing on screen. It now renders the server's message, and
`handleValidate` checks the response status instead of rendering a 500 body as a
verdict.

Five more assertions in `test-media-providers-page.mjs`, fifteen mutations caught
in total across the file.


### `/dashboard/media-providers` — two kinds pointed at endpoints the router never had

Asked a second time whether the page was done. The first pass audited handlers;
it never checked the contract those handlers depend on. Doing that surfaced a
kind that could only fail:

```
imageToText → POST /api/v1/images/understanding   404   no route, no handler
music       → POST /api/v1/audio/music             404   no route, no handler
```

Both were declared in the initial commit and never implemented. `imageToText` is
claimed by eleven providers in `serviceKinds` (ollama, xai, anthropic, mistral,
azure, huggingface, minimax, cursor, alicode, gitlab, deepgram), the sidebar
already hid both kinds, and the catalog has no models of either type — so the
detail pages were reachable by URL and offered a form whose Run button could
only produce a 404. `MEDIA_PROVIDER_KINDS` now marks both `served: false` and
the detail page says which path is missing instead of rendering a dead form.

Twelve errors of my own while establishing this, recorded because the pattern
kept recurring:

- Enumerated the page's endpoints against route directories and reported all
  seventeen missing. `/api` is a mount prefix in `server.ts`, not a directory.
- Reported the model lists as rendering empty from `MODEL_DATA = null`. A real
  browser shows all twenty populated.
- Reported three functions as dead; they are called from `onclick` attributes.
- **Fixed the sidebar, which did not need fixing.** `VISIBLE_MEDIA_KINDS` had
  already been curated to `["embedding","image","tts","stt","video"]` with the
  old list commented out. My edit would have re-added `webSearch`/`webFetch` as
  duplicate links next to the combined `/web` entry. Reverted — `git checkout`
  on that file. Only readable because I checked what HEAD already had before
  assuming a defect.

`test-media-providers-page.mjs` gained two assertions: every kind the sidebar
offers must have a real route, and a kind flagged `served: false` must not have
one and must not have catalog models — so the flag cannot go stale. Six
mutations, all caught.


### `/dashboard/media-providers` — one failed GET erased every combo's round-robin strategy

`combo/[id]` handleToggleRoundRobin read `/api/settings` and fell back to `{}` when
the read failed:

```js
const s = settingsRes.ok ? await settingsRes.json() : {};
const updated = { ...(s.comboStrategies || {}) };
await fetch("/api/settings", { method: "PATCH", body: JSON.stringify({ comboStrategies: updated }) });
```

Backend `updateSettings` merges shallowly — `{ ...current, ...updates }` — so
`comboStrategies: {}` replaces the whole map rather than merging into it. One
failed read wiped the strategy of every other combo, while the toggle still
rendered as on. The read is now checked and bailed on, the PATCH response is
checked before the toggle moves, and nothing is written when the read fails.

Three more in the same file and page:

- `handleAddModel`, `handleDeselectModel`, `handleRemoveProvider` and `handleMove`
  all moved the chip before saving and ignored the result, so a rejected save left
  the card showing a membership the server never accepted. All four roll back.
  The first one was fixed in the previous pass; the other three were found by
  asking which handlers set state and save in the same breath, which the earlier
  scan had not been shaped to notice.
- The SSE reader's `catch {}` around `JSON.parse` discarded an unparseable frame.
  A dropped `done` or `error` event left both `finalData` and `streamErr` null, so
  the Test button simply stopped with no message. Terminal frames now set the
  error, and a stream that ends with neither a result nor an error says so.
- Both delete handlers failed silently — one called `console.log`, the other gave
  up. Both report the failure now, and `handleDeleteCustom` renders it.

`test-media-providers-page.mjs` (7) pins all of it, including an assertion that
`updateSettings` is still a shallow merge — if that ever deepens, the frontend
guard stops being the only thing between a failed GET and lost configuration.
Nine mutations, all caught.


### `/dashboard/docs`, second pass: the page was missing a provider, not just an endpoint

Asked whether the docs were done after the endpoint fix. They were not. The first
pass audited endpoints; it never compared the provider list to the catalog. Doing
that surfaced four more things:

```
MODEL MEDIA di docs, tak ada di router : 0      -- nothing documented that stopped existing
router ada, docs tak ada                : 88    -- LLM/TTS providers, out of scope, fine
MODEL MEDIA di router, hilang dari docs : 3     -- cx/gpt-5.5-image, cx/gpt-5.4-image, cx/gpt-5.3-image
```

`cx` (Codex) serves three image models through `/v1/images/generations` and the
page never mentioned it -- no section, no PROVIDERS entry, no CONTAINER_MAP entry,
no model data. So an operator using a Codex image model would not find it in the
reference at all. Added all four pieces plus a section.

Also removed `const MODEL_DATA = null; // will be populated by fetch`: it appeared
exactly once, was never read or written, and the file contains no `fetch` at all.
The catalog comes from `EMBEDDED_MODELS`. The comment was describing a mechanism
that does not exist.

And the iframe had no `sandbox`. The document is same-origin and runs scripts, so
it now carries `sandbox="allow-scripts allow-same-origin allow-popups allow-forms"`
-- the first two are both required, without `allow-same-origin` the styles are
blocked too.

Two corrections to my own audit, both from reading source and trusting it:

- `MODEL_DATA = null` looked like the model lists rendered empty. In a real
  browser all 19 `.model-list` containers are populated and there are no console
  errors; the data was in `EMBEDDED_MODELS` the whole time.
- Three functions looked dead. They are called from `onclick` attributes in the
  markup, not from within the script.

Writing the provider assertion took three tries for the usual reason: `cx` and
`leonardo` do not use the same container shape (`all` versus `img`/`vid`), so
the container ids have to be read out of `CONTAINER_MAP` instead of derived from
the provider key. Eleven mutations, all caught, including restoring the pre-fix state of cx and removing the iframe sandbox.


### Verification config: the readiness poll targeted a port this app never opens

`hermes verify` failed readiness with `connection refused` on
`http://127.0.0.1:8000/`, while every command phase had exited 0. Auto-detection
sets `port: null` and falls back to 8000, but `backend/src/server.ts` is
`Number(process.env.PORT) || 3001`, and vite and nginx both proxy to 3001.

The port was left alone — changing it to satisfy the harness would ripple through
vite.config.ts and nginx.conf for no product gain. Instead `.hermes/environment.json`
records port 3001 and readiness `/api/health`; `/` and `/health` both fall through
to the SPA index, so they would report ready for anything.

`.hermes/` stays gitignored: it is per-machine tooling state, not template
content. A fresh clone runs `hermes verify --save --port 3001` once, documented in
the README.

`backend/.env.example` also said `PORT=20128`, matching nothing in the repo — the
code, vite and nginx all say 3001. Corrected.


### `/dashboard/docs` — the page told operators to call the wrong endpoint for video

The page is an iframe around a 253 KB static HTML file, so there is no flow logic
to audit; what rots is the file. It claimed:

```
POST /v1/images/generations
"Generate images or videos... This endpoint handles all image and video
 generation requests."
```

`imageGeneration.js` mentions video zero times and routes to the image handler,
while `/v1/video/generations` is a real endpoint with its own `videoGeneration`
handler — verified live, both answer 400 "No credentials for provider", i.e. both
reach their handler. So a video model sent to the documented endpoint lands in the
image path, and the endpoint that would have worked was never mentioned.

The images description now points at the video endpoint, and a full card
documents it with its method, description and required parameters.

`test-docs-page.mjs` (6) locks this in: every media route under `/v1` must
appear on a card header, the false claim must stay gone, every documented path
must resolve to a real route, and the HTML must stay balanced.

Writing it took three attempts at the same trap, which this project has now hit
repeatedly: the path appears twice — once in the images description pointing here,
once on the card — so `html.includes` passes with the card deleted, and
`cards.find(c => c.includes(path))` returns the *images* card. Both had to match
on the card's own `endpoint-path` header instead. Earlier in this session the same
shape produced a green assertion for the OpenCode rollback and for the empty-state
title; the rule is that anything present in more than one place has to be counted,
not matched.


### `/dashboard/cli-tools` — two more silent failures, found by asking the wrong question first

The suite asked "does this write check the response?" and all thirty-eight passed.
That was not the question. Checking `res.ok` and doing nothing when it is false is
still a silent failure, so a second assertion asks whether the *failure path*
exists at all:

- `OpenCodeToolCard` — clearing the active model and removing a model each did
  `if (res.ok) { ...update... }` with no else. The state here is not lying, since
  it only advances when the write succeeded, but clicking the ✗ on a model chip
  did nothing and said nothing. Both now report the status and the body.

Getting that assertion right took three tries, each time because it flagged
something that was already covered. It looked for an `else` after `if (res.ok)`
without recognising that `if (!res.ok) { ...; return; }` is covered by
construction — the block *is* the failure path. And `MitmServerCard` builds `res`
across a three-way branch and tests it twenty-five lines later, so the lookup has
to start from the enclosing handler, not the statement. The first version of this
also reported twenty-eight "silent" writes that were all fine.

Counting the writes on this page directly, rather than trusting the window scan
that produced three false positives and three false negatives earlier, is what
made the two real ones visible.

Covered by `backend/test-cli-tools-page.mjs` (10). Four mutations on top of the
six already there, including removing each of the two new else branches, one from
a card that was already correct, and replacing a status check with `if (true)`.


### What the suite can and cannot catch, recorded after it failed to

Adding `saveError` to `MitmToolCard` and `error` to `translator` was done with
a regex over `useState(`, which stopped before the default value, so the
declaration landed mid-expression:

```
const [loading, setLoading] = useState(
const [saveError, setSaveError] = useState(null);false);
```

`npm run test` passed — 312 assertions, all suites — with both files broken.
Every suite here reads source text rather than compiling it, so a syntactically
invalid file satisfies "the declaration exists" as easily as a valid one. Only
`tsc` caught it.

That is not a defect in the tests, it is their scope, and it is why verification
runs `npm run test` *and* `npm run typecheck` *and* `npm run build` rather than
treating the suite as sufficient. Recorded so nobody reads a green suite as a
green build.


### `/dashboard/cli-tools` — three writes that could fail in silence

fetch() rejects only on a network error; a 400 or 500 is an ordinary response
that resolves. Three writers on this page discarded it:

- `MitmToolCard.saveMappings` had `catch { /* ignore */ }`. A model mapping is
  what redirects an intercepted IDE request to a provider, so a save that failed
  left the card showing a redirect that was not in force while traffic kept going
  to the old target — and nothing was logged either.
- `OpenCodeToolCard.saveModels` — the modal closes and the list is already in
  local state before the POST is sent.
- `CopilotToolCard.saveModels` — the same, near-identical to the OpenCode one.

All three now read the status, restore what was there before, and say what
happened. `ClaudeToolCard`'s naming toggle was the same shape one component over
(`setCcFilterNaming(value)` then `await fetch(...).catch(() => {})`) and is fixed
too.

### `/dashboard/translator` — a save that wrote the file and threw the result away

Found by the repo-wide scan in `test-cli-tools-page.mjs` rather than by reading
the page, which is the point of the scan:

```js
const save = (file, content) => fetch("/api/translator/save", {...}).catch(() => {});
```

A rejected save was indistinguishable from a successful one and the content was
lost. `detectMeta` on the same page was quieter still: it read `data.success` and
did nothing when it was false, wrapped in `catch { /* ignore */ }`. Both now
report the failure and the page has an error banner — the state did not exist, so
one was added, and the first version of the fix set an error that was never
rendered, which is the same silence in a new shape.

Covered by `backend/test-cli-tools-page.mjs` (9), which scans every writer under
`frontend/src/pages/cli-tools` rather than the ones in view. Six mutations turn it
red, and each caught a real gap in the test rather than in the code: the OpenCode
rollback exists on two paths and the first assertion passed with one removed;
ClaudeToolCard and the translator had no assertion at all; and the window used to
find the status check had `indexOf` returning -1, where `-1 + 4` is truthy so the
fallback never fired and the window collapsed, flagging writes that do check three
lines later.


### `/dashboard/mitm` — intercepted credentials were being written to disk in the clear

The MITM dump files are a debugging aid. `dumpRequest` wrote

```
headers: req.headers
```

verbatim. An intercepted IDE request carries that tool's own session cookie and
the provider API key the router substituted, and `LOG_BLACKLIST_URL_PARTS` filters
by URL, so it never saw a header. The dumps landed in `DATA_DIR/logs/mitm` at the
default 0644 — world-readable — and the request body alongside them is the user's
prompt. Response dumps had the same problem with upstream `set-cookie`.

`redactHeaders` now runs over both, replacing `authorization`,
`proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `api-key`,
`x-goog-api-key`, `x-auth-token`, `openai-api-key` and `anthropic-api-key` with
`[redacted]`. The header name is kept so the dump still reads as a request, and
the match is on `toLowerCase()` because Node lower-cases incoming names. Dumps are
written 0o600.

### `/dashboard/mitm` — the CA private key was world-readable

`rootCA.js` wrote `rootCA.key` with no mode, so 0644. Anyone holding a MITM CA's
private key can impersonate any site that CA has been trusted for, which is the
entire attack. Now 0o600; the certificate stays 0644 because it is public by
nature. `.gitignore` also gained `*.key`, `*.pem`, `*.pfx`, `*.p12`, `*.crt` and
`/data` — these live in `DATA_DIR` and never in the tree, but a misconfigured
`DATA_DIR` should not be able to commit a CA key, and `git rm` does not remove it
from history.

Checked and correct with no change needed: the page itself is a five-line wrapper
whose four fetches all check `res.ok`; `mitm/logger.js` contains no unguarded
`spawn`, so the crash class that took the server down on `/dashboard/endpoint` is
absent here; and the status endpoint exposes no key material.

Covered by `backend/test-mitm-page.mjs` (11), which executes `redactHeaders`
against a real header set rather than only matching its source. Eight mutations
turn it red: removing the redaction, dropping `cookie` from the list, making the
match case-sensitive, deleting the header name instead of redacting its value,
returning the CA key to 0644, skipping the response redaction, removing `*.key`
from `.gitignore`, and returning the dumps to 0644. Two assertions in the first
draft failed for the wrong reason — they read `out.cookie` and `out["x-custom"]`
after passing mixed-case keys, so they were checking the absence of a key rather
than its value.


### `/dashboard/quota` — audited, no defect found

`quota/page.jsx` is an eleven-line wrapper rendering the same `ProviderLimits`
component as `/dashboard/usage`, so the bulk-toggle fix above reaches both routes.
Checked and correct, with no change needed:

- the empty list is the eligibility filter, not a fault — `providers/client`
  admits only oauth, cookie, or a `USAGE_APIKEY_PROVIDERS` provider, and an
  ordinary API-key connection (gemini, ollama, openrouter) has no upstream quota
  endpoint. A deployment holding only API-key connections legitimately sees an
  empty list, and the page says so rather than showing a bare empty table.
- `ProviderLimits` takes no props, so the two routes cannot diverge; `page` is
  internal state.
- quota fetch errors are handled per connection: 404 skipped, 401 handled, and
  the rest rendered against the row.

Recorded because "audited, nothing found" is a result worth having written down,
and because the two facts that made it look broken — an empty list, and a
component shared with another route — are both easy to re-investigate.

Covered by `backend/test-quota-page.mjs` (6). Five mutations turn it red: giving
the wrapper its own fetch, halving the empty-state title, removing the eligibility
filter, removing the bulk guard, and making `ProviderLimits` accept props. The
empty-state check counts occurrences rather than matching one, because the title
appears in both the config and the rendered heading and the first version of that
assertion passed with only one of them.


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
| `npm run test` | 344 assertions, 33 suites, all passed |
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