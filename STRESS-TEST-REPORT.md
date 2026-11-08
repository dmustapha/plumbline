# Stress Test Report: Plumbline
> hackathon-stress, 2026-11-08, adapted to this project (see STRESS-TEST-PLAN.md "Adaptations")

## Result
**Complete with declared gaps.** 1140 tests pass (13 skipped, 79 files), tsc clean. Stage-5 gate: 7 distinct attack classes + fuzz, spine CLOSED, 2 spine findings fixed with proof (`bash ~/.claude/skills/utils/stage5-hardening-gate.sh plumbline/app` rc 0).

## Coverage achieved per tier
- **P0 (F1-F6):** exhaustive classes in-process (API 69 tests, agent 98, isolation 36, falsification 46, ablation: engine no-oped breaks 147 of 420 tests) plus 30 live attacks.
- **P1 (F7-F11):** F8/F9/F10/F11 sampled (isolation, S3 independent listing AGREE, rewind). **F7 dead hand (gate L3) not re-run: owner key IP-blocked.**
- **P2 (F12-F13):** smoke plus the 5-viewport x 10-page sweep (axe, overflow, tap targets).
- Skipped by design: Phase 5 contracts (none exist).

## Live reliability (30 attacks, one session, 21 s pacing)
dollar 5/5 ran (DENY bond-insufficient), loop-create 5/5 (DENY max-instances), poisoned-page 5/5 (ALLOW allow-fetch), environ 5/5, memory 5/5 SANDBOX_OOM, runaway 5/5 SANDBOX_TIMEOUT. Before: 4 of 9 canned buttons returned no tool call. Evidence: `evidence/stress/live-reliability-30.jsonl`.

## Findings and fixes
| ID | Class | Fix | Proof |
|---|---|---|---|
| V-1 | H | reasoning models spent max_tokens before a tool call; budgets raised, truncation-aware retry | live 30/30 |
| D1-D8 | H/M | loop.ts hardening (timeouts, malformed replies, clamp attempts) | stress-agent.test.ts |
| W2 | W (spine) | production policy route validates string fields | drill before FAIL (403 vs 400), after PASS |
| L1 | L | SESSIONS_PER_IP_LIVE 429 carries Retry-After | stress-api |
| H1 | H | /api/proof shares one in-flight fetch, 2 s TTL | stress-api |
| DH-8 | H (spine) | GREEN older than 300 s served as STALE | drill before FAIL, after PASS |
| V-4 | M | AC-ALL-1 test added (was the one real traceability gap) | ac-all-1.test.ts, 16 of 16 covered |
| UI | L | tablet header wrap, 24 px tap targets, "also denied by" lines | viewport sweep |

## Honest gaps (not hidden)
- **Owner key blocked:** Vultr rejects this Mac's IP (105.127.7.132; allowed 105.127.6.61). Live gates L2-L7 not re-run today; DW-2 (L2 first-attempt flake) stays **open/unproven**.
- **V-2 partial:** the dollar canned attack now runs, but the session layer's `bond-insufficient` wins over `ceiling-dollar-deny`; the verdict panel lists the floor's deny too, but the headline rule is the bond one.
- **V-3:** disclosed with Retry-After, cap not raised (judges behind one NAT can still hit it).
- **V-7:** the 06:14Z worker is absent from the verifier's read; 3 extra live instances are today's stress workers inside TTL, to confirm after reap.
- Not run: session pages (range, policy, rewind, bond) in the 5-viewport sweep because of the live-session cap; corrupted-localStorage, throttled-network and broker-restart recovery drills; light-theme axe on seven pages.
- V-5/V-6 (rehearsal capture, R10 demo deliberation) are Dami's and the demo phase's.
