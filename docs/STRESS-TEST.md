# Stress Test Report
> 2026-11-08, run against the deployed range and in-process suites

## Result
**Complete with declared gaps.** the full suite passes, tsc clean. Stage-5 gate: 7 distinct attack classes + fuzz, spine CLOSED, 2 spine findings fixed with proof (adversarial-round gate exit 0).

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

## Follow-up round (same day, after the owner key was re-allowed)
- **Live gates re-run today, all PASS:** L1 (09:53Z), L2 (09:06Z and 10:05Z, two runs), L3 (dead hand), L4, L5, L6, L7. L7's `live_other_session_unaffected`, which failed in an earlier attempt, passes. DW-2 (L2 first-attempt flake) did not reproduce in 3 L2 attempts, so it is **not reproduced, not proven fixed**. Claims ledger: 8 of 8 citable again (`PLUMBLINE_URL=... npm run verify-claims`).
- **A first gate attempt (08:36Z) failed on the owner-side harness**, not the product: `PLUMBLINE_SSH_BROKER` unset and the 6-sessions-per-10-minutes creation window. Kept in `evidence/stress/gate-attempt-0836/`; passing evidence was restored. That attempt also left one gate worker (`plumbline-wk-l3gate`), which was destroyed by hand.
- **V-2 (done):** the verdict panel leads with `ceiling-dollar-deny` when it denied; the session layer's deny is listed under it. Rendering checked in the browser. In a live run the ceiling only appears when no worker is up, because `max-instances` (priority 80) outranks it.
- **V-3 (done):** live sessions per IP 2 to 4, creations per 10 min 3 to 6, streams per IP 3 to 8.
- **V-7 (closed):** the 06:14Z worker is gone; the account holds only the 3 infra instances after the gates.
- **Session-page sweep:** range, policy, rewind, bond at 5 widths: no overflow, no axe violations. The one sub-24 px target is the in-sentence "Limits" footer link (WCAG 2.5.8 inline exception).
- **Light theme axe:** found the ALLOW badge at 4.44:1 on `/range`; light `--true` darkened (50% to 47% lightness), brand.json regenerated, deployed; 10 pages x 5 widths now clean.
- **Recovery drills (9 scenarios, all PASS):** corrupted storage, injected 503, 200 with a non-JSON body, 429, offline, garbage live-list/spend, dropped SSE (120 s watchdog, then "NO RESULT"), rapid double-click (1 request), refresh mid-attack then back. Two real bugs found and fixed: a 2xx that is not an attack receipt left Fire stuck (`MALFORMED_REPLY` guard added), and the stream cap of 3 per IP returned 429 to a multi-tab judge.

## Honest gaps
- **DW-2** not reproduced, not proven fixed (see above).
- **Not run:** a deliberate broker-restart-mid-session drill (it kills a live service on the judging path) and a throttled-network (slow 3G) pass.
- Judges behind one NAT can still reach the new cap of 4 live sessions; the page says so with a Retry-After.
- V-5/V-6 (rehearsal capture, R10 demo deliberation) are Dami's and the demo phase's.
