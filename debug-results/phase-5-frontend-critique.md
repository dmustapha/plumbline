# Phase 5: front-end function critique (judge-facing range)

Scope: `apps/range-api/public/*.html`, `app.js`, plus how `src/routes.ts`, `routes-session.ts`, `sse.ts`, `run.ts`, `deps.ts`, `creds.ts`, `main.ts` serve them. Function only; the CSS/aesthetics are being replaced.
Method: full read of every file, plus GET-only curl against https://108-61-70-169.sslip.io (headers, `/api/policy/production`, `/api/status`, `/api/canned`). No POSTs, no source edits.
Verdict: REQUEST CHANGES (3 MUST-FIX, 14 SHOULD-FIX, 9 NOTE).

Intent in one sentence: a no-build static front end (one `app.js` switched on `data-page`) that lets a judge attack the agent, watch verdicts over SSE, and cross-check the live Vultr account.

## What is good (keep it)
- XSS discipline is real. Every dynamic value in `app.js` and the inline scripts goes through `textContent` or `createTextNode` (`h()` at app.js:8-15 only calls `setAttribute` with static keys). I found no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval` or dynamic `href`/`src` anywhere. Operator code, `reason`, `quoted_call`, instance labels, and `rule_id` are all rendered as text. The only attacker-influenced attribute value is `class: 'badge ' + v.decision` (app.js:105, 301), where `decision` is an engine enum. No exploitable injection found.
- Session key is HttpOnly + SameSite=Strict (creds.ts:22) and never read by `app.js`; the SSE replay honours `Last-Event-ID` (routes.ts:158, sse.ts:26), so ordinary reconnects do not duplicate events.
- Every nav link (`/`, `/range`, `/range/policy`, `/range/rewind`, `/range/bond`, `/verify`, `/proof`, `/replay`, `/status`, `/about`) and the in-page links (`/range?attack=vault`, `/about`, `/replay`) map to a PAGES entry (routes.ts:15-19). No dead links. Live: `/`, `/range`, `/range/rewind`, `/about`, `/app.js` all 200 with `no-store`.

---------------------------------------------------------------------------------------------------

## MUST-FIX (breaks or misleads during the demo)

### M1. "Try to write the production policy" always returns HTTP 413 instead of the signature refusal
- Files: app.js:255, routes.ts:89-92, main.ts:12.
- Fastify is built with `bodyLimit: 2048`. Only `PUT /api/policy/:sid` raises it to 70 KB (routes.ts:81). The `/api/policy/production` route (routes.ts:89-92) has no `bodyLimit`.
- The tamper button posts the whole textarea as `{policy: <yaml>}`. The default policy is 3373 bytes (curl `/api/policy/production`: `size_download=3373`), so the body is more than 2048 bytes before it reaches the broker.
- Failure scenario: a judge clicks the headline tamper button. Fastify answers 413 `FST_ERR_CTP_BODY_TOO_LARGE`. The page prints `HTTP 413: undefined`. The broker's signature check, the thing being demonstrated, never runs, and it reads as a broken control.
- Fix: add `bodyLimit: 70 * 1024` to the route options at routes.ts:89. In app.js:255 show `r.json.status || r.json.message`.

### M2. SSE failure is silent and leaves "Fire" disabled forever
- Files: app.js:197-210 (no `onerror`, no `open` handling), app.js:230 and :207 (the only re-enable path is a `result` event), routes.ts:152-155.
- `EventSource` only auto-reconnects on network drops. On a non-200 response (404 `SESSION_UNKNOWN`, 401/403, 429 `TOO_MANY_STREAMS`) it closes permanently with no retry.
- Triggers:
  - Per-IP cap of 3 streams (`PLUMBLINE_MAX_STREAMS_PER_IP`, config.ts:73) plus a shared NAT or venue Wi-Fi. A 4th `/range` tab or a judge sharing the IP gets 429.
  - A server restart. `SessionBook` is in-memory (sessionBook.ts:23), so the cookie's session becomes unknown.
  - Session lifetime of 60 min (sessionBook.ts:29).
- Failure scenario: the stream is dead, the judge clicks Fire, `/api/attack` returns 202, `#fire` is disabled (app.js:230), and no `stage`, `verdict` or `result` ever arrives. The page sits dead with no message. The same happens if the tab is backgrounded and the `result` frame is lost on a stream that then dies.
- Fix, in `wireStream`:
```js
es.onerror = () => { if (es.readyState === EventSource.CLOSED) { showBanner('Live stream closed. Reload to reconnect.'); $('#fire').disabled = false; } };
```
  Also add a watchdog. After a 202, if no `result` arrives within about 90 s, re-enable Fire and show "no result received; check /replay". Optionally pre-flight the stream with a `fetch` to read the 429/404 body and show `TOO_MANY_STREAMS`.

### M3. Event handlers have no error handling: null-JSON crash and permanently disabled buttons
- Files: app.js:189-195, 229-233, 236-238, 250-255, 280, 180.
- `api()` returns `json: null` when the body is not JSON (a Caddy HTML 502/503 page, or a proxy timeout). `attackFailure` then does `r.json.detail` (lines 192, 193) and throws a TypeError on any 429 or 503 with a non-JSON body.
- `fire()` sets `#fire.disabled = true` and only re-enables after `attackFailure` returns. When it throws, or when `fetch` itself rejects (network drop, offline, Caddy restart), the button stays disabled forever. There is no try/catch in `fire` and the rejection is unhandled.
- `#vrun` (line 280) has the same bug: `disabled=true`, `await api(...)`, then `disabled=false` is skipped on a throw. `draw()` can also throw, for example if `v.counts` is odd.
- The envproof, acl, tier, save, tamper and approval `act` handlers have the same shape: a reject gives no feedback.
- Fix: make `api()` never throw. Catch fetch errors and return `{ ok: false, status: 0, json: { status: 'NETWORK_ERROR', detail: String(e.message) } }`. Treat `json` as `{}` when parsing fails. Wrap button handlers in `try/finally { btn.disabled = false }`. In `attackFailure` use `(r.json || {}).detail`.

---------------------------------------------------------------------------------------------------

## SHOULD-FIX

### S1. Duplicate verdict cards (no client dedupe)
- run.ts:32 and routes-session.ts:133 / :160.
- `execute()` calls `publishRecent(started-1000)`, and the approval and rewind routes call `publishRecent(now-20_000)`. That re-publishes every row from the last 20 s, including the original ESCALATE verdict. The client prepends every `verdict` event with no dedupe (app.js:199).
- Failure scenario: attack, ESCALATE, Approve 8 s later gives two identical cards for the same `decision_id`.
- Fix: keep `const seen = new Set()` keyed by `v.decision_id` and skip repeats. Also publish only rows newer than the last published ts server-side.

### S2. Replay storm on load, plus unthrottled verifier proxy
- app.js:204-209, routes.ts:144-145.
- A fresh `EventSource` with no `Last-Event-ID` replays the whole 200-event buffer (sse.ts:19). Each replayed `result` calls `refreshProdRead()`, so a session with 15 past attacks fires 15 simultaneous `/api/verify` requests, each proxied to the second host with a 15 s timeout (routes.ts:138).
- `/api/verify` and `POST /api/verify/run` have no rate limit, unlike `live-list` (30 per minute). Any judge or script can hammer the second-host verifier and the Vultr API behind it.
- Fix: only refresh on a live result, e.g. ignore events before the first `open` plus 500 ms, or debounce `refreshProdRead` to one call per 3 s. Add a `SlidingWindow` plus a Coalescer on `/api/verify`, and a per-session `actLimit` on `/run`.

### S3. Home page is blocked by the slowest of three calls
- app.js:214.
- `Promise.all([proof, live-list, verify])`. If the verifier host is down or slow, `/api/verify` takes up to 15 s (routes.ts:138). The counter and the live account panel (the first thing a judge sees) stay on "loading..." for that whole time. A network reject sends everything to the "page error" banner.
- Fix: three independent `api().then(...)` calls, each with its own failure text. Also, when `live.ok` is false (app.js:217) the panel remains "fetching from Vultr..." forever. Write "live list unavailable (HTTP n)" like `refreshLive` does (app.js:134).

### S4. Rewind page: first-visit race, misleading message, blocked-storage dead end
- rewind.html:67-80 and :118, app.js:259-263.
- The inline script calls `refresh()` during parse, before `DOMContentLoaded`, so before `ensureSession()` has set the cookie. A direct-link first visitor always gets 401/403, and the page says "Rewind is not enabled right now (object storage unreachable or the rung has not passed its gate)". That is false; it is a missing session. It then reloads once.
- If `sessionStorage` throws (some private modes), `getItem` hits the catch and returns without reloading, so the page stays on the false "not enabled" message until a manual reload.
- If `/api/session` is refused (429/503), the page still claims "not enabled", with only the generic banner.
- `act()` and `approve()` have no `.catch` and the buttons are not disabled in flight (double-click gives two deletes). The pending Approve button is lost on reload; the nonce lives only in the closure.
- Fix: have the inline script wait for the session (expose a `window.plbReady` promise from app.js), and render the status word on non-2xx (`j.status`/`j.http`) instead of the fixed sentence. Disable the buttons while a request is in flight, and add `.catch`.

### S5. Bond page cannot recover from an expired cookie, and its ledger view can lie
- app.js:264-267, bond.html:32-41.
- The cookie lives 3 h (creds.ts:5) but the session lives 60 min (sessionBook.ts:29). After 60 min, `/api/bond` returns 403 `SESSION_UNKNOWN`. The banner says "Reload the page to start a new one", but `bond()` never calls `ensureSession()`, so the reload hits the same stale cookie for up to 2 more hours. Only visiting /range fixes it.
- bond.html:33 treats any non-array (a broker 502 object) as `[]`, so it prints "no approved irreversible delete in the recent ledger" when the ledger is actually unreachable.
- The page reads the last 100 global rows (`/v1/decisions?limit=100`, routes.ts:64). On a busy demo day the judge's own burn scrolls out of the window and the page says "none".
- Fix: call `ensureSession()` first in `bond()`. Distinguish `!res.ok` from empty in bond.html. Filter server-side, e.g. a bond-rows endpoint or a `session_id`/`rule_id` filter.

### S6. Accessibility blockers
- range.html:8, :9; policy.html:7; app.js:54, :58, :197; policy.html:8; index.html:6.
- `#attack` and `#yaml` textareas have no `<label>` or `aria-label` (screen-reader users cannot identify the primary input). Add `<label for>` or `aria-label`.
- Event feed and operator trace (`#stages`, `#feed`) have no `aria-live`, so a screen-reader user never learns a verdict arrived. Use `role="log"` / `aria-live="polite"` on `#stages`/`#feed` and `role="alert"` on `#banner`.
- Buttons nested in anchors (`<a><button>`, index.html:6 and policy.html:8) are invalid HTML and give two tab stops. Style the `<a>` as the button instead.
- The nav has no `aria-label`; no `<h1>` on most pages; the Deny/Approve buttons have no description tying them to their decision. Banner text changes are not announced.
- No keyboard traps found.

### S7. No Content-Security-Policy
- Live headers on `/`: no `content-security-policy` (only nosniff, referrer, X-Frame-Options, HSTS). The page renders attacker-influenced text and is attacked on purpose.
- Today's code is injection-clean, but a single future `innerHTML` would be exploitable and the session key would be at risk.
- Fix: add in the `onSend` hook (routes.ts:38): `default-src 'none'; script-src 'self' 'sha256-<rewind inline hash>'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. Easier: move the inline scripts in rewind.html and bond.html into `app.js` or separate files and use `script-src 'self'`.

### S8. Unexpected payload shapes silently drop events or whole renders
- app.js:32, 141-152, 122-123, 199-209, 301.
- `ago(ts)` throws `RangeError` on a missing or invalid timestamp. `stageText` assumes `result.attempts` and `result.limits` exist (app.js:147-150); a harness-error `run` stage without them throws and the line vanishes. `liveListView` assumes `s.data` is an array. In `replay`, one bad `row.ts` aborts the `forEach` and the remaining rows never render. `JSON.parse(e.data)` is unguarded in every listener.
- Fix: a `safe(fn)` wrapper for each SSE listener that falls back to rendering `JSON.stringify` of the payload, and make `ago` return 'unknown time' for invalid input.

### S9. Approval cards are brittle
- app.js:175-185.
- `api('/api/approvals')` is fired on every ESCALATE verdict, including all replayed ones on page load (one broker call per event; N replayed escalations means N calls). If the pending record is not visible yet, `find` returns nothing and the card silently never appears, with no retry and no "approval not found" text. There is no catch.
- After clicking Approve or Deny, the buttons stay enabled, so a double-click gives a confusing `NOT_FOUND` second answer.
- Fix: fetch `/api/approvals` once per batch and cache it (or retry once after about 500 ms). Disable both buttons after the first click. Show a fallback line when no pending approval is found.

### S10. Canned and Fire controls can double-fire
- app.js:227, 229-233.
- Canned attack buttons call `fire()` directly and are not disabled while an attack is in flight, so a double-click or a click while another attack runs sends another request (limited by 3/min and `inFlight`, but it produces 429s the judge reads as failures). `#fire` is re-enabled on the first `result` event even if a second attack is still running.
- Fix: a single `busy` flag set in `fire()`, cleared on `result`, and checked by the canned buttons. Disable the canned buttons while busy.

### S11. Mobile (~400px) horizontal scroll caused by markup/logic
- app.js:289 (64-hex floor hash), app.js:293 (`JSON.stringify(v).slice(0,220)`, no spaces), proof.html, plus `.grid` items in range.html.
- Plain `<div>`s with long unbroken strings (the 64-char hash, minified JSON) have no wrap rule, so on a 400px viewport `/proof` overflows horizontally and drags the page. `JSON.stringify(v.counts)` on /verify has the same risk.
- On `/range`, the two `<section>` grid items have an implicit `min-width:auto`. A wide `<pre>` (`#envout`, a stage with a long Python line) can stretch the single 1fr track beyond the viewport even though `pre` has `overflow-x:auto`. I did not render this in a browser, so treat it as likely rather than confirmed.
- Handoff note for the new design: wrap long values in an element with `overflow-wrap:anywhere` (or `<code>` in an `overflow-x:auto` wrapper) and give grid/flex children `min-width:0`.

### S12. Policy page hides load failures
- app.js:243-249, 250-254.
- If `GET /api/policy/<sid>` fails, `load()` just returns, leaving an empty textarea and no message. The Save button is live, so a judge can PUT an empty policy. `r.json.floor.hash.slice` throws on an unexpected shape. In the save handler `r.json.errors` throws when `r.json` is null (non-JSON error). Save has no in-flight state.
- Fix: show the error (`#errs`) on load failure and disable Save until a successful load. Use `(r.json || {})`.

### S13. User-authored policy text appears in global pages (content spoofing)
- app.js:301 (replay), bond.html:37, routes.ts:64.
- `rule_id` and `reason` come from the judge's own policy YAML and are stored in the global ledger. `/replay` and `/bond` show them to everyone as text. It is not XSS, but a judge can name a rule `ALL-CLEAR verifier GREEN` or a 5 000-character string and it appears in other visitors' recorded-run page and in the bond list, with the official REPLAY badge.
- Fix: the broker's YAML validator should cap `rule_id` to `[a-z0-9-]{1,48}` and `reason` to 200 chars. In the UI, also truncate (`.slice(0, 120)`).

### S14. Banners use one slot and are overwritten
- app.js:54-65, 36-39, 50.
- `showBanner` replaces the single banner's text. A "Kill-switch engaged" or "Budget exhausted" message from `chrome()` (async, completes late) can overwrite the `PLAYGROUND_CAPACITY` or session-refusal message, or vice versa. `SESSION_UNKNOWN` (404) from stream/policy is not covered by the 401/403 handler at app.js:25.
- Fix: append messages (one `div` per banner, dedupe by text) and include a link to `/replay` in the refusal texts.

---------------------------------------------------------------------------------------------------

## NOTE

- N1. `POST /api/session` returns `session_key` in the JSON body (routes-session.ts:62) even though app.js:5 states the key never reaches the script. The page ignores it; but any future XSS could read it from the response only if it makes its own call, so keep it only if the gate scripts need it, or limit it to requests with `x-plumbline-script` style headers.
- N2. DOM growth: `feed.prepend` / `stages.prepend` are unbounded (app.js:199-206). At 3 attacks/min over a 60-min session that is a few thousand nodes: tolerable, but cap each at about 200 children.
- N3. `/range/` (trailing slash) and unknown paths return a JSON 404 (curl confirmed). Set `ignoreTrailingSlash: true` and serve an HTML not-found page for GETs that accept `text/html`.
- N4. Duplicate `referrer-policy` and `x-content-type-options` headers on every response (Caddy and the app both set them). Harmless.
- N5. SSE: ids come from one global counter that restarts on process restart (sse.ts:13), so a client holding `Last-Event-ID: 500` after a restart is not replayed anything it should be; no `retry:` hint; per-session buffer maps are only freed when a later `register` prunes them (sessionBook.ts:75).
- N6. `GET /api/live-list?session_id=<sid>` and `GET /api/policy/:sid` need only a known session id, not the key (routes.ts:50-52, 77-79). Ids are public via `/api/replay`, so any visitor can read another judge's VPC list and policy text.
- N7. The cookie's `Secure` flag depends on `req.protocol` (routes-session.ts:61), which needs Caddy to send `X-Forwarded-Proto` and the `trustProxy: '127.0.0.1'` match (main.ts:12). I could not verify without a POST. Check the live `Set-Cookie` once with a real browser: it should contain `Secure; HttpOnly; SameSite=Strict`. Also confirm `req.ip` is the client, not 127.0.0.1; otherwise all judges share one per-IP budget.
- N8. `/api/replay` is uncached and unauthenticated (100 rows with `detail_json`) and is hit by both `/replay` and `/bond` on every load; it exposes every judge's quoted attack calls.
- N9. `status.html` dumps the raw `/api/status` JSON (lease info, key expiry days, in-flight count). Intentional transparency, but confirm none of it is sensitive.

## Counts
MUST-FIX 3 | SHOULD-FIX 14 | NOTE 9
