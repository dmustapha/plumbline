# WIRE-REPORT (PLUMBLINE, hand-driven, 2026-11-07)

Status: WIRED. Commits: fixes a9218f7 (after 5822417), evidence at declared commits (see evidence/declared-commits.json).

## Topology (Phase 1)
Components: range-api (VM1, public), broker (VM1, sole credential holder), runner + gVisor sandbox (VM1), verifier + watchdog (VM2, ord), Vultr API, Vultr Serverless Inference, Vultr Object Storage, shared registry, prod-db. Connections: browser to range-api, range-api to broker (unix socket + token), range-api to runner (socket + token), runner to sandbox, sandbox to relay to broker (HMAC task), broker to Vultr (4 scoped keys), broker to inference, broker to S3, verifier to broker ledger export (HMAC), verifier and watchdog to Vultr (view-only / destroy-only keys), watchdog to broker lease.

## Credentials (Phase 2)
All required variables present on the right host only (names only; values never printed). Mock flags: none active. Disclosure: one display of PLUMBLINE_TASK_HMAC to the session during this phase (filter miss); rotated the same hour.

## Integration results (Phase 4, live, post-fix code)
| Connection | Proof | Result |
|---|---|---|
| range-api to broker/runner | gate l1 (full attack path, 4 sessions) | PASS |
| broker policy engine to Vultr (protect, floor) | l1, l5 | PASS |
| verifier to broker ledger export and Vultr list | l2 (RED names instance, GREEN after destroy) | PASS (first attempts flaked, see gaps) |
| observer key ACL | l4 | PASS |
| Vultr write tiers (firewall, vpc, registry) | l5 | PASS |
| Object Storage versioning rewind | l6 | PASS |
| per-session bond | l7 | PASS |
| broker death, dead-hand watchdog | l3 | PASS |
| judge flow on production defaults (2 live / 3 per 10 min) | smoke: create, attack, result | PASS, 7 to 20 s end to end |
claims recompute: CL-L1..L7 + CL-GV all CITABLE, 0 withheld.

## Authorization and isolation (4.2e, 5.6)
Cross-session probe, live: session B writing A's policy 403, firing on A 403, anonymous 401. FOUND AND FIXED: reading A's policy copy and live list needed only the public 8-hex id (CO-W1, DBG-W1); now owner key required, re-probed live: 403 / 401, owner 200. Bond and rewind already ignored a client-named session.

## Fix and retest (4.5)
CO-W1 fixed (1 attempt). Rehearsal overrides reverted (SESSIONS_PER_IP, LIVE_SESSIONS_PER_IP removed; MAX_IN_FLIGHT=2). Secret rotated.

## Async latency (5.7)
Judge attack to result: 7.1 s and 19.6 s observed (canned prod-db attack), first stream event 0.7 to 3.4 s. Operator-written Python with a worker create is longer (L2 runaway runs to a sandbox timeout by design). Demo guidance: narrate during the first 20 s; do not promise sub-10 s.

## Privacy (5.5), sentinel values (4.2d), explorer links (4.2c)
Skipped, trigger absent: no FHE/ZK, no contracts. Sentinel scan: no sentinel hits in gate responses (verdicts carry real rule ids, model named, live list counts match Vultr).

## Deep integration (5.8)
The claimed integration is Vultr itself. Load-bearing: l1/l5 show the Vultr list unchanged after a DENY and changed only via ALLOW. Fail-closed: l2/l3 (kill switch, dead hand). Non-custodial: sandbox_env_clean (no Vultr key in the sandbox), broker alone holds keys. Live-tested: every gate runs against the real account. Multi-party: ed25519 approval signer, broker, independent verifier. BT-5 (browser network proof) DEFERRED: UI is being replaced; run after design integration (handoff DW-1).

## env-proof gate
Clean. Seven key-shaped hits were placeholders (__SET_BY_BOOTSTRAP__) and test decoys, dispositioned in .env-proof.json; real .env values were swept against full history and tree separately: no match.

## Blockers
None.
