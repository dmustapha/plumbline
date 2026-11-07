# Phase 5 core critique: policy-engine, ledger, vultr-adapter, broker

Scope: packages/policy-engine, packages/ledger, packages/vultr-adapter, apps/broker. Read-only on source.
Not re-covered: range-api, broker auth, sandbox (earlier security review).
Method: full read of the four domains, then four findings reproduced offline against the real broker harness
(mock Vultr, in-memory DB). Scratch tests live in the session scratchpad (t1.test.ts, t2.test.ts), not in the repo.

Verdict: REQUEST CHANGES. The engine itself is tight (fail-closed NaN handling, deny-over-escalate-over-allow,
request-hash binding, nonce single-use). The weak spots are in the glue around it: concurrency in the pipeline,
the spend gate on zero-cost calls, resource bookkeeping when Vultr misbehaves, and a feature that exists but is not wired.

Counts: MUST-FIX 4, SHOULD-FIX 9, NOTE 8.

---------------------------------------------------------------------------------------------------

## MUST-FIX

### M1. max_instances is a check-then-act race; N concurrent creates all pass (REPRODUCED)
- apps/broker/src/pipeline.ts:296-316 (evaluate reads live_worker_count), 495-501 (recordResource runs only AFTER the awaited Vultr POST),
  packages/ledger/src/spend.ts:118-121 (liveWorkerCount counts ledger rows only).
- Scenario: maxInstances=2, five parallel `create instance` calls (plan vc2-1c-1gb, five distinct plumbline-wk-* labels).
  Every call evaluates while the ledger still shows 0 live rows, so all five get ALLOW and all five POST.
  Reproduced result: decisions ALLOW x5, Vultr holds 5 instances, ledger live = 5, cap = 2.
- Why it matters: this is the headline blast-radius rule and the first thing a judge fires a parallel burst at.
  Spend is still safe (charge() is synchronous), but the instance cap is not, and the demo can be made to show "cap 4, 9 live".
- Fix: serialize create-instance from evaluate through recordResource with the existing `Serial` (playground.ts:17-24), or keep an
  in-memory `inflightCreates` counter that buildState adds to live_worker_count and that is decremented in a finally.
  Minimal: `if (call.verb==='create' && call.class==='instance') return this.createLock.run(() => this.#runInner(...))`.

### M2. Zero-cost calls are spend-gated, so one cent of overshoot disables reads, cleanup and the kill-switch fleet destroy (REPRODUCED)
- packages/ledger/src/spend.ts:77-78 (`estimateUsd > remainingGlobal` / `> remainingSession` with estimate 0),
  callers with cost 0: http.ts:129 (every GET, DELETE, PATCH), s3.ts:88, vsi.ts:99, plans.ts rate-card refresh.
- Scenario: global cap 1.00. Inference is recorded after the fact (llmProxy.ts:29) with no cap check, and vsi.chat only gates on an
  estimate, so recorded spend can exceed the cap (actual > estimate, or concurrency, see S3). With globalSpend = 1.01,
  remainingGlobal = -0.01 and `0 > -0.01` is true: every Vultr GET/DELETE and every S3 call returns `global-cap-exceeded`.
  Reproduced: `charge('vultr',0)` and `charge('s3',0)` both return {ok:false,'global-cap-exceeded'}; with one live worker,
  `destroyWorkers()` returns failed:[{code:ARGS_INVALID}] (the lookup GET is refused, the target reads as unresolved, cleanup refuses) and the instance survives.
- Why it matters: the kill switch advertises "fails closed, destroys the fleet". With the budget exhausted (the exact moment you most want
  it to work) it silently does nothing, TTL reaping stops too, and the dashboards (live-list, rewind, rate-card) go dark.
- Fix: only gate real spend. In `charge`: `if (estimateUsd > 0) { if (estimateUsd > remainingGlobal) ...; if (kind!=='vsi' && estimateUsd > remainingSession) ... }`.
  Add a regression test: over-cap ledger, `charge(kind,0)` must be ok:true.

### M3. A worker row whose Vultr instance is already gone stays "live" forever (REPRODUCED)
- apps/broker/src/pipeline.ts:299-302 and 208-209 (cleanup scope needs a label; an unresolved target has none), 278-294 (lookup),
  apps/broker/src/main.ts:75-91 (reap) and 118-132 (only VPC/firewall rows are reconciled against Vultr; instances never are),
  pipeline.ts:504-507 (markDestroyed only after a successful DELETE).
- Scenario: a worker disappears from Vultr without the broker seeing a 2xx DELETE: console delete, Vultr-side failure, DELETE that
  succeeded but timed out (OutcomeUnknown), or DELETE answering 404. The row keeps destroyed_at_ms NULL.
  Every minute reap() selects it, cleanup() looks it up, gets an unresolved target with label undefined, records CLEANUP_REFUSED and returns.
  Reproduced: after the out-of-band delete, cleanup returns ARGS_INVALID and liveWorkerCount stays 1; with maxInstances=2 the
  third create is denied by `max-instances` with zero real instances.
- Why it matters: demo livelock. Two such rows and the range refuses all new workers until someone edits SQLite by hand.
  It also writes one CLEANUP_REFUSED event per row per minute.
- Fix: treat "not in the live Vultr list" as destroyed for instances, the same way sweepOrphanPlaygrounds does for networks
  (main.ts:129): in reap, list instances once, `markDestroyed` every live worker row whose id is absent. Also treat a 404 on DELETE as success
  (`catch VultrError 404 -> markDestroyed`).

### M4. OutcomeUnknown is never recorded: the 5xx path leaves an untracked, unreaped, uncapped instance (REPRODUCED)
- Dead wiring: apps/broker/src/main.ts:35 and :41 (`new VultrHttp`/`TierKeys` are built without `onUnknown`), packages/ledger/src/export.ts:172-178
  (`recordUnknownOutcome`/`resolveUnknownOutcome` have no non-test callers), pipeline.ts:440-452 (`#mapError` has no OutcomeUnknown branch, so it surfaces as generic `ERROR`).
- Scenario: Vultr answers 502 to POST /instances after creating it (this happened live for VPCs, see the comment at main.ts:100-103).
  Reproduced with nextCreateStatus=502: caller gets `{code:'ERROR', message:'outcome unknown...'}`, Vultr has 1 instance, ledger live = 0,
  `listUnknownOutcomes` = 0, session spend 0.007.
  The instance is not in `resources`, so it is not counted against max_instances, not TTL-reaped, not destroyed by the kill switch,
  and the export's `unknown_outcomes` is always empty. The reclaim sweep (main.ts:106-116) only handles VPCs.
- Why it matters: the headline claim "5xx/unknown outcomes are ledgered for reconcile" is false for the broker; a judge who forces a 5xx
  (or just waits for Vultr to flake) gets a live, billing instance the policy engine cannot see. Cost is held (good) but the instance is orphaned.
- Fix: pass `onUnknown: (u) => recordUnknownOutcome(db, u, clock())` into every VultrHttp (TierKeys + rate). Add `OutcomeUnknown` to `#mapError`
  (code `OUTCOME_UNKNOWN`). Add an instance reclaim like reclaimUnrecordedPlaygrounds: unrecorded plumbline-wk-* instance seen in two sweeps -> adopt
  (record a resource row tied to the ALLOW) or cleanup; then `resolveUnknownOutcome`. Also call `onUnknown` in resources.ts:87 (it throws OutcomeUnknown directly, bypassing the hook).

---------------------------------------------------------------------------------------------------

## SHOULD-FIX

### S1. A single 401 downs a tier for the life of the process; the recovery code is dead
- packages/vultr-adapter/src/tiers.ts:56-62 (`#down` only grows; `clearDown` has no callers), apps/broker/src/pipeline.ts:445-448 (any 401 marks ALL four tiers down).
- Scenario: one transient 401 (IP-lock flap, Vultr hiccup) on any call -> observer/deployer/network/registry all unavailable -> every list, lookup and create
  is denied `tier-key-unavailable` until broker restart. `http(tier)` throws before any call, so nothing can heal it.
- Fix: re-probe a downed tier on the reap tick (one cheap GET /account or `/instances?per_page=1`) and `#down.delete(tier)` on 200; only mark the tier whose key failed.

### S2. The pinned chain_head is invalidated by normal operation, which defeats the truncation check
- packages/ledger/src/export.ts:109-119: resources (mutable: destroyed_at_ms changes on every delete/TTL reap) and unknown-outcome rows (resolved ones vanish) are chained
  after the decisions and feed `chain_head`. A verifier that pins `expect_head` (export.ts:159) gets HEAD_MISMATCH after the next reap, with no tampering.
- Scenario: verifier pins head H at t0; a worker is TTL-reaped at t0+60s; the next export has a different head -> false tamper alarm, so operators learn to ignore it
  or re-pin each time (which removes the protection). Also `resolveUnknownOutcome` deletes history from the export (export.ts:183-188), so the chain does not prove nothing was resolved away.
- Fix: expose `decisions_head` (append-only, stable) as the thing to pin; keep resources/unknown in separate non-pinned chains, and emit resolved outcomes as rows with a `resolved` flag rather than dropping them.

### S3. Inference spend is not reserved; fallback double-bills and loses the first call
- packages/vultr-adapter/src/vsi.ts:69,86-92 (kind 'vsi' never writes to the ledger, so concurrent chats all pass the same stale cap check; `usage` numbers unvalidated:
  NaN makes `recordInference` throw on NOT NULL, a negative token count records negative spend), apps/broker/src/llmProxy.ts:17-24 and 29.
- Scenario: provider returns 200 with a bad `usage` -> `recordInference` throws inside `#once` -> `chat()` catches and retries on the other model: two billed calls, zero rows recorded for the first, 2x25 s latency. A timeout on model 1 likewise doubles the wait in a 3-minute demo.
- Fix: validate `usage` fields (`Number.isFinite && >= 0`) before pricing; record inference in a `finally` per attempt; only fall back on network/5xx/timeouts, not on local errors; reserve the estimate in `inference_calls` (or a `pending` row) at charge time.

### S4. Bond handling in approve(): a ledgered ALLOW that never ran, and releases on ambiguous failure
- apps/broker/src/pipeline.ts:406-416.
  (a) The ALLOW row is recorded (406) before `bond.hold` (409). If hold fails the caller receives a synthetic DENY `bond-insufficient` that exists nowhere in the ledger, while the ledger says ALLOW and the approval nonce is spent.
  (b) `else this.d.bond.release(decisionId)` runs for any `out.error`, including an ambiguous S3 timeout where the delete may have happened: the bond is refunded for a destructive act that may have occurred.
  (c) A crash between hold and settle leaves the hold in `held` forever (no sweep).
- Fix: hold first, record ALLOW second (or record a real DENY row on failure); release only for definitive pre-execution failures (SpendRefused, TierUnavailable, 4xx), burn on unknown; add a startup sweep that releases or burns stale `held` rows.

### S5. Adapter-level binding gaps: the executor trusts a caller-supplied value the ALLOW did not bind
- packages/vultr-adapter/src/resources.ts:91-94 (`update(allow, req, patch)` sends `patch.firewall_group_id`, never compared to `req.params.firewall_group_id`),
  packages/vultr-adapter/src/s3.ts:125-129 (`putObject(..., body)` body not compared to `req.params.content`).
  `Firewalls.addRule` already does this right (resources.ts:121-123 PORT_NOT_BOUND).
- Scenario: today the broker passes the same object, so it is safe; but any second caller (a future route, a test harness, a refactor) can reuse a cheap ALLOW to attach to, or write, something else. The engine hashes these params, so the check is one line.
- Fix: derive both values from `req.params` inside the adapter (drop the argument) or throw `NOT_BOUND` on inequality.

### S6. External Vultr bodies are dereferenced without null checks after the resource already exists
- packages/vultr-adapter/src/resources.ts:116 (`res.firewall_group` -> `r.id`), :148 (`res.vpc`), :72-73 (`res.instance`), :67/106/140 (`res.instances` when the body is null).
  An empty or non-JSON 2xx (http.ts:160 turns it into `null`/a string) throws a TypeError after the POST succeeded, so the firewall/VPC exists with no ledger row and no unknown-outcome record (cf. M4). Instances.create handles this (line 87); the siblings do not.
- Fix: mirror line 87 in firewall/vpc/registry create (`if (!r?.id) throw new OutcomeUnknown(...)`), and `res?.instances ?? []` in the lists.

### S7. Retry-After is honoured without a cap
- packages/vultr-adapter/src/http.ts:164-167. `retryAfter * 1000` has no ceiling (the backoff branch caps at 8 s, the header branch does not). A 429 with `Retry-After: 3600` parks the request, the held spend reservation, and the caller for an hour; with 4 retries worst case is also 5 x 15 s timeouts plus sleeps inside one tool call.
- Fix: `Math.min(retryAfter, 10) * 1000` and an overall deadline per request (e.g. 30 s) after which a GET fails and a mutation becomes OutcomeUnknown.

### S8. Kill switch: three small races
- apps/broker/src/killswitch.ts:23-29: `#engaged = true` then `writeFileSync` then `revokeAll()`; if the write throws (disk full, perms) revokeAll never runs and engage reports failure while tokens stay valid. Revoke first, then persist in try/catch.
- apps/broker/src/routes-internal.ts:221-228 + pipeline.ts:363-373: destroyWorkers snapshots rows once. A create already past evaluate (M1 window, seconds wide) finishes after the snapshot and survives until the next TTL tick; reap is allowed during the kill switch, so it dies within a minute plus TTL, but the demo claim is "fleet destroyed". Re-run destroyWorkers once more after a short delay, or refuse in `#instance` create after the POST if `kill.engaged()` (immediate cleanup).
- apps/broker/src/lease.ts:74-80: `expireNow` swaps `#ttlS` to 0 across an await. A periodic `beat()` that started earlier with ttl 45 can reach the verifier after the ttl-0 beat and renew the lease. Pass ttl as an argument to `beat(ttl)` instead of mutating state.

### S9. Read endpoints write, and the decisions query trusts its inputs
- packages/ledger/src/bond.ts:16-19: `snapshot()` calls `#touch` (INSERT OR IGNORE). `GET /v1/bond?session_id=<any 8 hex>` and `/v1/rewind` (routes-internal.ts:172-177, 185-195) create a bond_sessions row for a session that never existed, and `aggregate().sessions` (shown in /v1/proof) counts them. Fix: read-only snapshot returns initial values without inserting; touch only on hold.
- apps/broker/src/routes-internal.ts:155-156 + packages/ledger/src/decisions.ts:57: `Number('abc')` is NaN, `Math.min(Math.max(NaN,1),500)` stays NaN, SQL becomes `LIMIT NaN` and the route 500s. `before_ts` uses `ts < ?`, so rows sharing one millisecond are skipped across pages (ties). Fix: `Number.isFinite` check with default, paginate on `(ts,rowid)`.

---------------------------------------------------------------------------------------------------

## NOTE

- N1. spend.ts:109-111 `INSERT OR REPLACE` on resources resurrects a destroyed row (destroyed_at_ms reset to NULL; reproduced: liveWorkerCount 1 after destroy + re-record) and can silently reassign session_id/allow_decision_id. Use `INSERT ... ON CONFLICT DO NOTHING` and fail if the allow differs.
- N2. allow-guard.ts:6-16: `consumed` is an unbounded process-wide Set (slow leak under a flood of ALLOWs). It also burns the ALLOW before parameter validation (resources.ts:81-83 calls `need()` after `guard`), so a PARAM_REQUIRED error spends the decision. Validate first, then guard; prune ids older than the approval TTL.
- N3. The engine is advertised as total but can throw: facts.ts:360 `req.target.tags` and :347 `req.target.label` dereference an absent target while hash.ts:402 already tolerates `target?.id`. The broker always sets target, but the verifier re-runs evaluate() from ledger rows (evaluate.ts:158 comment), so a malformed row throws instead of yielding a verdict. Same for `verifyExport` (export.ts:147-166): no shape check, so a missing `decisions` array is a TypeError, not `CHAIN_BROKEN`.
- N4. S3: the AWS SDK retries Put/Delete/Copy up to 3 times on its own (s3.ts:127,133,141), so a timed-out Put can create two versions (and the last-copy arithmetic then differs), and S3 mutations never emit an unknown-outcome record. Set `maxAttempts: 1` for mutating commands.
- N5. Dead code: `S3Store.probe` (s3.ts:77), `TierKeys.clearDown` (tiers.ts:60), `recordUnknownOutcome`/`resolveUnknownOutcome` (see M4), the unused global `bond` table and the never-written `'expired'` approval status (db.ts:64-69, 86), `void req` and the unused `req` parameter of `whenHolds` (evaluate.ts:42,79), duplicated JSDoc at spend.ts:104-105, the orphaned doc comment block at main.ts:93-99 that documents nothing, `SEQ_GAP` is reachable only for hand-built exports.
- N6. Size/nesting: `assemble` (main.ts:32-155, ~120 lines), `registerInternalRoutes` (routes-internal.ts:65-235, ~170 lines), `whenHolds` (evaluate.ts:42-81, 12 sequential guards, correct but easy to break), `Pipeline.#evaluate` (296-316) and `approve` (394-418) mix I/O, policy and bond accounting. None is wrong today; splitting `assemble` into reaper/reconciler modules would also make M3/M4 fixes testable.
- N7. sessions.ts:13-19: the comment says "first octet 100..199" but the code makes the SECOND octet 100..199 (10.X.y.0). The subnet-uniqueness check only looks at live in-memory sessions, so after a session is dropped (reap, restart) a new id can derive the same subnet while the old VPC still exists, and Vultr returns 422.
- N8. main.ts:75-91: reap runs steps in series with one try/catch around the whole tick (`every`), so a single throwing cleanup starves session expiry and the orphan sweep on every tick. Wrap each step. `RateCardCache.refresh` (plans.ts:21-27) swallows errors with no log, so a bad key shows up ten minutes later as `rate-card-unavailable` with no trail.

---------------------------------------------------------------------------------------------------

## What is solid (keep)
- evaluate.ts: NaN-safe comparisons (`!(cost <= ref)`), unknown facts satisfy deny/escalate but never allow, engine-level ttl/args denies, deterministic tie-breaks, and a request hash that survives the verifier round trip.
- approvals: signature over decision id + rule + request hash, single-use nonce, re-evaluation at approve time with a target fingerprint, so a stale or swapped escalation yields STALE rather than ALLOW.
- http.ts: charge-before-send with a settle in `finally`, 4xx refunds, 5xx/timeouts on mutations keep the reservation (never undercounts), shared process-wide rate slot.
- ledger: append-only triggers on decisions, per-session bond with transactional hold/settle, chained export with a clean verifier and a hash that includes `seq`.

## Verification notes
- Reproduced with `node node_modules/vitest/vitest.mjs run` against the repo harness: M1 (5 ALLOW, 5 instances, cap 2), M2 (charge(0) refused when over cap; destroyWorkers left the worker alive), M3 (live row stuck, third create denied by max-instances), M4 (502 -> 1 Vultr instance, 0 ledger rows, 0 unknown outcomes), and N1 (resurrected row), plus NaN settle/hold throwing a NOT NULL error (S3, S4 support).
- No source file was modified; no live Vultr call and no .env read.
