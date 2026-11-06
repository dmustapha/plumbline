
## Appended by BROKER agent (task 1.11b, stream G0 broker part), 2026-11-06

Broker findings AG4-BRK-1..7 are FIXED with tests in apps/broker/test (ag4.test.ts, ledger-export.test.ts, tokens.test.ts).
Everything below is NOT implemented by the broker agent; it is queued to the owning stream. Hints are from .forge-critical-review.json.

### G1a (L1 tamper floor: sandbox, runner, operator, range-api, bootstrap-vm.sh, firewall-rules.sh)
- AG4-PRD-5 [WARN] No rate limit on POST /api/session, so the 3/min limit is bypassed by new sessions; each session creates a real firewall group and a fresh $1.50 ceiling; ~7 sessions drain the $10 cap. Fix: per-IP session-creation limit (and a global sessions/min cap) in range-api before calling the broker `/v1/session`.
- AG4-PRD-6 [WARN] POST /api/approval/:decision_id has no session binding in the spec; any judge can approve the last version of shared orders.json. Fix: range-api must send the caller's own session_id (broker already refuses a cross-session approval: NOT_FOUND), and the shared canary needs a per-session copy or an approval-count guard (UI decision for G1b/G1f).
- AG4-SBX-1 [BLOCKER] sandbox #destroy treats empty `docker ps` stdout as destroyed; never checks exit code, timedOut, stderr. Fix: require code 0 and not timedOut for both rm -f and ps; otherwise result is SANDBOX_STUCK, never a pass.
- AG4-SBX-2 [WARN] untrusted code can forge/drop PLB_RESULT and ATTEMPTS (same interpreter). Fix: collect attempts out of band (host-side network log / gate counter), never from the container's stdout trailer.
- AG4-SBX-3 [WARN] `_BROKER_NETS=('172.28.',)` whitelists the whole sandbox subnet incl. bridge gateway and peer sandboxes. Fix: whitelist only the exact broker relay ip:port; treat peers and the gateway as external attempts.
- AG4-SBX-4 [WARN] network create / ICC / DOCKER-USER / plb-gate flags not defined. Fix: define `docker network create --internal --subnet`, `enable_icc=false`, the DOCKER-USER drop rule, and gate flags (--read-only, --cap-drop ALL) in bootstrap-vm.sh and test them.
- AG4-SBX-5 [WARN] U-4 fallback needs `--network none` plus a socket mount, which the static no-credential test forbids; harness would count each SDK call as external. Fix: decide U-4, make buildRunArgs emit the fallback form behind a flag, adjust the test and harness exemption together.
- AG4-SBX-6 [WARN] SDK `_call` returns None for 413/502/5xx. Fix: raise a typed error for every non-2xx and for non-JSON bodies.
- AG4-SBX-7 [NIT] OOM/PIDS classified by stderr substring the code controls. Fix: classify from docker inspect (OOMKilled, exit code 137) not stderr text.
- AG4-SBX-8 [NIT] POST /run with limits null returns 500; tiny limits reach docker. Fix: type-guard limits and clamp a lower bound, return ARGS_INVALID.
- AG4-OPS-2 [WARN] firewall-rules.sh runs once; rules are lost on reboot while services come back. Fix: persist (netfilter-persistent or a oneshot unit ordered Before=plumbline-broker/plb-gate) and probe `iptables -C INPUT -i br-plb -j DROP` after a reboot.
- AG4-OPS-3 [WARN] plumbline-runner is in the docker group (root-equivalent) so broker.env 0600 does not protect keys from it. Fix: harden the runner unit (ProtectSystem, NoNewPrivileges), and do not claim env-file isolation against docker-group users.
- CO-2 H-4 (hard gate): `getaddrinfo` from inside the sandbox network on the VM must FAIL and Docker must be >= 26.0. Add the DNS-exfiltration test (probe-first-hour and a gate). Owners G1a (sandbox/network) and G1h (probe script).

### G1b (L2 verifier: reconcile, verifierServer, cli, vultr-lite)
- AG4-VER-1 [BLOCKER] findingsOf only checks allow_decision_id non-empty. Fix: use `verifyExport` from @plumbline/ledger (freshness, chain, expect_head pin, resource tied to an ALLOW row with the same request hash) AND re-run the policy engine on each live resource (E-1), so a forged ALLOW or a made-up id is RED. The broker side is DONE: export schema `plumbline-ledger-export/v2` is frozen (apps/broker/docs/ledger-export.schema.md).
- AG4-VER-6 [WARN] verifier without --baseline treats any `plumbline-infra-*`/`plumbline-prod-*` label as baseline, and trusts an unsigned --ledger. Fix: no baseline => status DEGRADED, never GREEN; the CLI must verify the export chain and a pinned head.
- AG4-VER-7 [WARN] verifier boots with the watchdog key in PLUMBLINE_VERIFIER_KEY. Fix: check the key's actual ACL via the Vultr account/user endpoint at boot, BOOT_REFUSED on over-scope.
- AG4-VER-8 [NIT] RECONCILE_RED_PROTECTED_CHANGED compares only label/plan/region; missing baseline file silently yields []. Fix: see CO-2 H-3 below; missing baseline => DEGRADED.
- AG4-PRD-7 [WARN] false RED_UNLOGGED when a worker is created between the export and the live-list poll. Fix: take the live list FIRST, then the ledger export (export.generated_at >= live poll time), and treat a ledger row newer than the poll as in-flight; polling twice does not fix a stale ledger snapshot.
- CO-2 H-3 (hard gate, G1b + G1d): baseline compares `power_status` and `os` as well; `power_status: 'stopped'` on prod-db => RECONCILE_RED_PROTECTED_CHANGED. The baseline file written by bootstrap-range (G1d) must record power_status/os.
- CO-2 H-1 baseline side (hard gate, G1d + G1b): registry `plumblinereg` is in BOTH the baseline and the ledger (a bootstrap-created ALLOW row), and `/api/verify` is GREEN right after `bootstrap:range`. Broker/floor side already DENYs its deletion (floor-registry-shared).
- CO-2 E-1 logic (G1b): the verifier re-runs `evaluate` on the live state with the exported `request`, `plan`, `region` (a live `vc2-24c-96gb` in `sgp` with a matching ledger row must reconcile RED).

### G1c (L3 watchdog / lease)
- AG4-VER-2 [BLOCKER] lease ttl_s is unbounded, so a compromised broker keeps the lease alive for years. Fix: clamp ttl_s to a maximum (e.g. 60 s) in the receiver and refuse larger.
- AG4-VER-3 [WARN] missing/garbage lease file => state NEVER => never sweeps (fails open). Fix: after a first heartbeat has ever been seen (or past a boot grace), missing/unparseable lease is treated as EXPIRED; owner/mode of the shared dir enforced.
- AG4-VER-4 [WARN] watchdog-actions.jsonl is unsigned and writable, excusing RED_MISSING forever. Fix: sign entries (HMAC) or keep in a verifier-only dir; require destroy ts after the ALLOW row.
- AG4-VER-5 [WARN] watchdog deletes any firewall group starting `plumbline-s`; protect-tagged-destroy does not cover firewall tags. Fix: the watchdog must use the floor's PLAYGROUND_LABEL_RE (plumbline-s<8 hex>-<name>), not the bare prefix.
- Note for G1c: the broker now destroys its own workers on kill-switch engage (AG4-BRK-6), so the watchdog is the second line, not the only one.

### G1d (L4 ACL tiers / bootstrap-range / owner scripts)
- AG4-OPS-1 [BLOCKER] owner scripts (createServiceUser, ipAllow, issueKey, deleteUser, ensureVersionedBucket, object-storage DELETE) take no AllowDecision. Fix: route every mutation through an engine ALLOW (owner caller) or document the owner-key exception with a signed owner action; the adapter agent changed OwnerAdmin signatures, update the call sites.
- AG4-OPS-7 [WARN] bootstrap-range is not idempotent: issues new keys each run, never revokes old, regenerates all tokens. Fix: reuse existing users, revoke prior keys, keep tokens unless --rotate.
- AG4-OPS-8 [WARN] missing inputs written as empty/'undefined' into broker.env/watchdog.env. Fix: refuse to write when PLUMBLINE_POLICY_PUBKEY / VULTR_INFERENCE_API_KEY etc. are absent; include PLUMBLINE_REQUIRE_FLOOR_SIG, caps, socket, bind in the generated file.
- CO-2 H-1 (see G1b): bootstrap creates `plumblinereg` via the engine, records it in the ledger and the baseline.
- CO-2 H-3 (see G1b): baseline must record power_status/os for prod-db.

### G1h (OPS and probes: gates.ts, verify-claims.ts, probe-first-hour.sh)
- AG4-OPS-4 [WARN] gate l3 cannot tell a broker-death reaper from an always-on sweeper. Fix: add a control run proving the worker survives while the broker is alive.
- AG4-OPS-5 [WARN] verify-claims never compares an evidence file's `base` to PLUMBLINE_URL or checks age. Fix: reject evidence whose base differs from the deployed URL or is older than the run window.
- AG4-OPS-6 [WARN] gate l5 only checks ALLOW verdicts, never lists Vultr; l1 sandbox_env_clean is vacuous. Fix: list Vultr to confirm create then delete; assert the ENV COUNT value and absence of VULTR_/PLUMBLINE_ secret names.
- CO-2 H-4 (see G1a): getaddrinfo-from-sandbox probe + Docker >= 26.0 recorded as evidence.

### Broker follow-ups (G0 broker, partially done)
- AG4-BRK-8 [NIT]: boot-with-flag now bumps the revocation epoch (tested); the hardcoded 120 s task TTL is unchanged and the in-memory epoch still resets on a restart without the flag.
- Engine follow-up (DEV-B1): add `owner_session` to `Target` and a floor rule `session-ownership-mismatch`; the broker already sends `target.owner_session` and, until the rule exists, relabels a foreign resource so `scope-label-prefix` denies it.
- Engine robustness: `isKnownCall('read','__proto__')` throws (VERB_CLASS lookup walks the prototype). The broker guards with Object.hasOwn; evaluate() itself should too.
