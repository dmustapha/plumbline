# PLUMBLINE broker review (apps/broker)

I read the broker source, the floor and session-default policies, the parts of the policy engine they call (`evaluate.ts`, `facts.ts`), and the range-api routes that forward to the broker (`routes.ts`, `routes-session.ts`, `main.ts`). Every finding below was confirmed by reading the code unless it says otherwise. I ran nothing against the live range.

**Held up under review:**
- **Task tokens** use an HMAC with a timing-safe compare, an expiry and a revocation epoch.
- **Parsing** checks the verb/class pair against the catalog, and every parameter is allow-listed and pattern-checked.
- **Approvals** are bound to the request id, rule id, request hash and resolved target, and each nonce works once.
- **Unresolved targets** are refused by the floor, so a failed lookup cannot become an ALLOW.
- **Foreign resources** whose labels start with `plumbline-wk-` or `plumbline-s` are relabelled before the engine sees them, and the floor then refuses them.
- **Production policy writes** are blocked twice: by the floor rule and by the owner-only check in `#policyWrite`.
- **Egress** pins the resolved IP, refuses IP literals and non-public addresses, never follows redirects, and caps the body. The floor also limits the host to `docs.vultr.com` and `range.plumbline.local`, and the engine and egress parse URLs the same way.
- **Bucket keys** are confined to `sessions/<sid>/` with no path traversal.

---

### 1. HIGH — Sessions that own a playground never expire, so playground capacity runs out for good after 8 judges
**Where:** `main.ts:87` together with `sessions.ts:38-41`

**Cause:** `sweepOrphanPlaygrounds` runs inside every 60-second reap and calls `sessions.get(r.session_id)` for every live playground row. `get()` also sets `last_seen = now`. The idle limit is 10 minutes (`config.ts:91`), so every session that owns a playground is refreshed every minute. It never shows up in `sessions.expired()`, so its VPC is never cleaned up.

**What a judge sees:**
1. Eight visitors call `POST /api/session` (3 per IP per window is allowed). This does not even need to be malicious: the first 8 normal judges trigger it.
2. Each gets a protected playground VPC. The cap is 4 per region across ewr and ord.
3. Every later session gets `playground_error: PLAYGROUND_CAPACITY` until the broker restarts.

The playground hot-edit flip (D-FLOOR) is then dead for the rest of the judging window. Those sessions also count toward `maxSessions = 20`.

**Smallest fix:** make the existence check in the sweep side-effect free. Add `has(id)` (or `peek`) to `SessionRegistry` and use `!sessions.has(r.session_id)` at `main.ts:87`.

### 2. HIGH — Any judge can use up the 5-VPCs-per-location limit with the default policy, and those VPCs are never cleaned up
**Where:** `pipeline.ts:228-230` and `:523-531`, `playground.ts:5-11`, the session-default rule `allow-breadth-create`, and the reaper in `main.ts:67-94`

**Cause:**
- The default policy allows `create vpc` for any label starting with `plumbline`, in region ewr or ord.
- These VPCs are recorded with `protected = 0`.
- Nothing ever removes them. The reaper only handles `plumbline-wk-*` instances. The orphan sweep only handles protected VPCs. Session expiry only handles `s.playground`. The watchdog only matches `PLAYGROUND_LABEL_RE`.
- `pickPlaygroundRegion` counts only protected rows, so it still picks the full region and the Vultr create fails.

**Exploit:** one attack, *"create VPCs plumbline-a … plumbline-e in ewr and in ord, subnet 10.50.N.0/24"*, is about 10 calls, well under the 30-call budget per task. After that, every new session's playground fails, permanently.

**Smallest fix:** add a floor deny for `create vpc` from the sandbox. Playgrounds are created through `runSystem`, which uses the system policy, so they are unaffected. Alternatively, count all live VPC rows in `playgroundCounts` and reap unprotected VPCs and firewall groups when their session expires.

### 3. HIGH — After a session-policy edit, instances can be created that are never reaped, never killed and don't count toward the worker cap
**Where:** the floor rules `scope-label-prefix` and `max-instances`; `ledger/spend.ts:111-114` (`liveWorkerCount` counts only `plumbline-wk-%`); `pipeline.ts:351` (`destroyWorkers`); `main.ts:70` (reaper)

**Cause:** ALLOW comes only from the session layer, and judges may hot-edit their session layer. The floor only requires an instance label to start with `plumbline`. Nothing in the floor limits instance create labels to `plumbline-wk-`.

**Exploit:**
1. Call `PUT /api/policy/<own sid>` adding:
   `- {id: x, effect: allow, priority: 10, match: {verb:[create], class:[instance], label_prefix:[plumbline]}}`
2. Attack: *"create instance plan vc2-1c-0.5gb region ewr label plumbline-keep-N"*, 30 per task.

**Result:**
- **Worker cap bypassed:** the cap of 4 does not apply, because these labels are not counted.
- **Ceiling bypassed in practice:** each create is charged $0.005 (1 hour), but the instance lives forever. The TTL reaper, the kill-switch fleet destroy and the watchdog all match only `plumbline-wk-*`. The $1.5 session ceiling therefore turns into about 300 VMs per session running indefinitely.
- **Label squatting:** the judge can also choose `plumbline-prod-x` or `plumbline-infra-x`. After that the floor itself refuses to delete them.
- **Verifier stays GREEN,** because every instance has an ALLOW row.

This breaks the real-world meaning of NON-NEGOTIABLE 4 (the ceiling) and the blast-radius story, which INVARIANTS does not list as a known limitation.

**Smallest fix:** add a floor deny for `create instance` whose label does not start with `plumbline-wk-` (a `label_not_prefix: [plumbline-wk-]` match).

### 4. MED — The global worker cap can be held by one judge for days
**Where:** `pipeline.ts:111-112` (`ttl_h` is accepted up to 744), the floor `max-instances` rule (counts workers globally, `maxInstances = 4`), and session expiry, which does not destroy a session's workers.

**Exploit:** one session creates 4 `plumbline-wk-*` workers of `vc2-1c-0.5gb` with `ttl_h: 75`. That projects to 4 × 0.005 × 75 = $1.5, exactly the session ceiling. Every other judge's worker create then gets `max-instances` DENY for about 3 days.

With the bond enabled, `bond-insufficient` shortens ttl per session to about 10 hours. Several sessions or IPs can still keep the cap held.

**Smallest fix:** add a floor cap on ttl (for example `ttl_h <= 2`), and/or destroy a session's workers through `pipeline.cleanup` when the session expires.

### 5. MED — Any session can change another session's firewall groups, VPCs and registries if their labels are outside the two scoped prefixes
**Where:** `pipeline.ts:258-266` (`#withOwnership` applies only when the label starts with `plumbline-wk-` or `plumbline-s`)

**Cause:** a session can create a firewall group labelled `plumbline-fw` (the default policy allows it). The ledger row records its owner, but because the label is not in a scoped prefix, the owner is never compared.

**Exploit:** session B sends `{verb:'update', class:'firewall_group', target:{id:<A's group id, visible on public /api/live-list>}, params:{port:'22'}}`. The default `allow-breadth-delete` rule plus a resolved target gives ALLOW, and a 0.0.0.0/0 rule is added to session A's group. A delete works the same way, for VPCs and registries too.

**Smallest fix:** in `#withOwnership`, for update and delete, treat the target as foreign whenever `owner !== null && owner !== sid`, whatever its label. Also treat `owner === null` with a `plumbline*` label as foreign; the floor still covers prod and infra.

### 6. MED — Unauthenticated `/api/live-list` turns each request into 5 calls against the broker's single Vultr rate limit
**Where:** `liveList.ts:22-33`. There is no cache or request coalescing, and the range-api route `routes.ts:47` has no rate limit.

**Cause:** each request makes 4 Vultr list calls plus 1 S3 list. Vultr allows 30 requests per second per IP, and that limit is shared with every engine lookup.

**Exploit:** an anonymous client loops `GET /api/live-list` at about 10 requests per second. The broker then gets 429s everywhere:
- `#lookup` fails, the target is left unresolved, and the floor refuses every update or delete (`target-unresolved`).
- Creates fail with `VULTR_429`.
- Playground creation fails.

The range keeps failing safe, but it is unusable for everyone.

**Smallest fix:** cache `LiveList.fetch` for about 2 seconds with one shared in-flight request. Since the bucket listing depends on the session, cache the four Vultr sections globally. Also add a per-IP limit on the range-api route.

### 7. LOW — The shared `bond-scene/*` object prefix is open to every session
**Where:** `canary.ts:7` and `:20-24`

**Cause:** while the bond is enabled, any session may put, delete or restore any `bond-scene/<name>` key. The comment at `routes-session.ts:87` says these objects are "only the caller's own", which is not true.

**Exploit:** a session puts data to, or deletes (once the object has 2 or more versions), the gate's `bond-scene/g<ts>.json`, or writes unlimited junk keys.

**Fix:** scope the prefix per session, as `bond-scene/<sid>/…`.

### 8. LOW — Some broker maps grow without limit
- **Per-task maps:** `calls` (`routes-sandbox.ts:14`) and `taskModels` (`main.ts:53`) are never pruned. Growth is slow because attacks are rate-limited.
- **Session policy copies:** `PolicyStore.get` (`policyStore.ts:50-59`) creates a copy for *any* sid with no format check, and `sweep()` is never called. The unauthenticated `GET /api/policy/<random>` is not rate-limited, so memory grows with each new sid (keys up to about 100 characters, Fastify's default parameter length).
- **Fix:** check the sid format in `get` and return the default without storing it; delete map entries when a token expires.

---

**Verdict:** SHIP-WITH-FIXES. Fix 1, 2 and 3 before judging opens; each is a small change of one rule or one line. Fix 4 and 5 if time allows.
