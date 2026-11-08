# PLUMBLINE adversarial review: `apps/range-api` (public HTTPS surface)

I read all of `apps/range-api/src/*` and followed every broker handler these routes forward to (`apps/broker/src/routes-internal.ts`, `sessions.ts`, `policyStore.ts`, `liveList.ts`, `main.ts`), plus the runner, verifier and Caddy settings that affect this surface.

**What holds up (checked, no finding):**
- **Credentials:** the API refuses to boot if any of the credential env vars is present (`config.ts:43`).
- **Session auth:** `sessionFor` binds a session id to the key issued at creation. It compares SHA-256 hashes in constant time, rejects a mismatched claimed id, and keeps the cookie HttpOnly with SameSite=Strict.
- **Approvals:** the broker's `take()` filters by session id, so you cannot approve another session's decision. Deny is always allowed.
- **Policy PUT:** needs the session key, and the broker checks the session id against its pattern.
- **Production policy:** `/api/policy/production` cannot write. The broker returns 403 or 409 `DEPLOY_ONLY` even when the signature is valid.
- **`/v1/ledger/export` forward:** only the fixed path and the two HMAC headers are forwarded. The broker checks the signature with a 30-second window. Admin routes are not reachable through the API.
- **Rate-limit keys:** with `trustProxy: '127.0.0.1'`, the client IP comes from Caddy's X-Forwarded-For. I believe Caddy 2.5+ overwrites a client-supplied XFF by default, but I did not confirm the deployed Caddy version (UNCONFIRMED).
- **Verifier run:** `/api/verify/run` is rate-limited and serialised on the verifier itself.
- **Policy YAML:** parsed with the `yaml` package, whose default alias limit should block alias-expansion ("billion laughs") attacks. Default not verified against the installed version.

---

## H1 - HIGH: one judge can fill the whole range (session hoarding)
**Where:** `apps/range-api/src/routes-session.ts:30-47` and `src/main.ts:21-22`

The API caps session creation per IP (3 per 10 minutes) and globally (10 per minute), and refuses new sessions once the broker holds `maxSessions` (20). Nothing limits how many **live** sessions one IP holds. Broker sessions expire only after 10 minutes idle, and any authenticated `/api/env-proof` call refreshes them through `/v1/task` → `sessions.get`.

**Exploit:**
1. `POST /api/session` three times every 10 minutes, from one IPv4 address. That is about 60 minutes to hold all 20; with a handful of IPs or an IPv6 /64, it takes 2 minutes.
2. Every 9 minutes, call `POST /api/env-proof` with each session's key headers to keep it alive.
3. Every other judge now gets `503 SESSION_CAP`.

Spamming `POST /api/session` from several IPs also uses up the global 10-per-minute budget, which locks out new judges as well.

**Smallest fix:** in `createSession`, refuse a new session when the IP already holds 2 or more live sessions. Count `d.book.sessionsOf(req.ip)` and drop ids the broker no longer has. Optionally, only count a session as alive while a model-backed attack is running, not on env-proof.

## H2 - HIGH: playground slots are never freed, even with honest traffic (reached via `POST /api/session`)
**Where:** `apps/broker/src/main.ts:87`, together with `sessions.ts:38-41`

`sweepOrphanPlaygrounds` runs every 60 seconds and calls `sessions.get(r.session_id)` for every protected playground network (VPC). `get()` updates `last_seen`. So every session that owns a playground has its idle timer reset every minute and never reaches the 10-minute idle expiry.

**Exploit:** create 8 sessions (`playgroundCapPerRegion` 4 × 2 regions), or just let 8 judges visit. From then on, every new session gets `playground: null` plus `playground_error`, so the playground scenes fail for everyone until the broker restarts. Those 8 sessions also permanently count toward `maxSessions`, which makes H1 cheaper.

**Smallest fix:** use a non-refreshing existence check in the sweep. Add `SessionRegistry.has(id)` (`this.#sessions.has(id)`) and filter with `!sessions.has(r.session_id)`.

## H3 - HIGH: `/api/live-list` lets anyone flood the Vultr API with the broker's keys
**Where:** `apps/range-api/src/routes.ts:47` → `apps/broker/src/liveList.ts:22-31`

The route needs no auth, has no rate limit and no cache. Each request fans out into 5 upstream calls: 4 Vultr lists (instances, firewalls, VPCs, registries) and 1 S3 version list, all with the broker's tier keys.

**Exploit:** `while :; do curl -s https://HOST/api/live-list?session_id=system & done` at about 10 requests per second means about 40 Vultr calls per second. Vultr then rate-limits the account or key. I did not confirm Vultr's exact limit (UNCONFIRMED); about 30 per second is the commonly cited figure. `http.ts:165` retries 429s with backoff, so every session's real work stalls or fails:
- creates and deletes,
- rewind,
- the live list on `/proof`.

It may also affect the verifier, if Vultr's limit applies per account rather than per key (UNCONFIRMED).

**Smallest fix:** in range-api, cache the live list per session id for about 3 seconds, and coalesce concurrent identical requests into one in-flight promise. Accept only `system` or `SessionBook.isSessionId(sid) && d.book.has(sid)`. Add a per-IP `SlidingWindow`, for example 30 per minute.

## M1 - MED: `GET /api/policy/:sid` grows broker memory without limit (crash risk)
**Where:** `apps/range-api/src/routes.ts:67` → `apps/broker/src/policyStore.ts:50-58`

`PolicyStore.get` inserts a new entry for **any** string. `sweep()` exists but is never called (no `.sweep(` anywhere in `apps/broker/src`). The route needs no auth and has no rate limit.

**Exploit:** loop `GET /api/policy/<random ~8 KB string>`. Each request leaves a permanent Map entry keyed by that string. At around 100k requests, the broker runs out of memory, and the broker is the only credential holder, so the whole range goes down.

**Smallest fix:** in range-api, return 404 unless `SessionBook.isSessionId(sid) && d.book.has(sid)`. In the broker, make `get()` return the default without inserting when there is no copy, and call `policies.sweep` from `reap`.

## M2 - MED: env-proof skips the operator concurrency gate and can starve the sandbox runner
**Where:** `apps/range-api/src/routes-session.ts:68-80`

`envProof` mints a task and calls `runner.run` without `d.inFlight.tryEnter()`. The runner allows only 2 concurrent runs (`apps/runner/src/main.ts:10`). It also does not check the kill switch or the spend cap itself; `/v1/task` does catch the kill switch.

**Exploit:** with the sessions from H1 (20 × 3 per minute), call `POST /api/env-proof` continuously. Both runner slots stay busy, so every real attack's sandbox step gets `RUNNER_BUSY` and the operator returns `OPERATOR_BUSY`.

**Smallest fix:** wrap it in `if (!d.inFlight.tryEnter()) return 503 OPERATOR_BUSY; try { … } finally { d.inFlight.leave(); }`. Add a per-IP limit if wanted.

## M3 - MED: SSE stream has no auth and no connection cap
**Where:** `apps/range-api/src/routes.ts:109-117`

1. **No connection cap:** anyone can open unlimited `GET /api/stream/<known sid>` connections. Each one holds a socket, a 15-second interval and a subscriber closure. Session ids are public through `/api/replay`. Opening tens of thousands of connections from a few hosts exhausts file descriptors and memory in Node and Caddy (Caddy has `flush_interval -1` and no timeout on this path), and the API stops answering.
2. **Cross-session read:** any visitor can watch another judge's live stream: attack text (`run.ts:45`), operator stages, verdict cards and approval events. This leaks other judges' activity. It does not bypass any control.

**Smallest fix:** call `sessionFor(d, req, reply, req.params.sid)` before `writeHead`. A same-origin `EventSource` sends the SameSite=Strict cookie, so the browser client keeps working. Cap open streams per IP (for example 3) and globally (for example 200), using a counter that is decremented on `close`.

## L1 - LOW: `/api/proof` does uncached synchronous file reads on every request
**Where:** `apps/range-api/src/routes.ts:83-93`

Each unauthenticated request does a blocking `readdirSync`/`readFileSync` of every evidence file (152 KB and 20 files today, and growing) plus a runner `/containers` call. Sustained spam blocks the event loop and takes more load from the shared runner socket.

**Fix:** cache the evidence map in memory for about 10 seconds, or read it once at startup and re-read when files change.

## Noted, not reported as a defect
- **Shared-canary approval check is enforced only in the API and matches only on the exact id `orders.json`** (`routes-session.ts:89-91`). I could not confirm whether the floor or engine could ever put a differently-spelled key, or a whole-bucket delete, into pending approval. UNCONFIRMED.
- **`startAttack` kill-switch check fails open** when broker status answers non-200 (`routes-session.ts:60-61`). The broker's `/v1/task` re-checks the kill switch and its spend cap, so there is no real bypass.

---

**Smallest set to ship:** H2 (a one-line `has()` fix), H3 (cache plus limit), M1 (validate the sid in the API), then a per-IP live-session cap for H1 and auth plus caps on the SSE stream (M3).

**Verdict: SHIP-WITH-FIXES**: no credential, policy-bypass or sandbox-escape defects found in this area; H1–H3 and M1 must be fixed first because each lets one anonymous judge degrade or take down the shared range.
