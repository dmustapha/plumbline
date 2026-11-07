# DEBUG-REPORT (PLUMBLINE, hand-driven, 2026-11-06)

## Executive Summary
Mode: full (phases 1-6). Baseline green. Three independent read-only reviewers (core, agent/verifier/ops, frontend) found 11 MUST-FIX, 34 SHOULD-FIX, 26 NOTE. 9 of 11 MUST-FIX are fixed in this phase, each with a DBG- regression test. The 2 unfixed MUST-FIX are frontend JS (app.js) and are deliberately deferred to the design integration, which rewrites that file. Nothing is committed or deployed yet; the VMs still run the pre-debug build.
CONFIDENCE-SCORE: 80 (see justification).

## Baseline Snapshot (Phase 1)
- tsc --noEmit: clean. vitest: 845 passed / 13 skipped (64 files). Boundary lint 17/17.
- Test:source ratio 0.65 (65 test files / 100 source files): PASS (>= 0.5).
- Live smoke: broker /healthz ok, /api/status ok (kill switch not engaged, lease ok), verifier /healthz lease ALIVE.
- No BUILD-REPORT.md exists (hand-driven build); KNOWN-RISKS came from PULSE build-exit and HONESTY-LEDGER.md.

## Known Risks Disposition (Phase 2)
| Risk | Class | Disposition |
|---|---|---|
| Sandbox relay container has docker0 egress (review item 3) | STRUCTURAL | RISK-ACCEPTED: second-stage compromise needed; defence in depth. Handed to stress (DH-3) |
| L6 reads object versions via the broker's own S3 store | STRUCTURAL | RISK-ACCEPTED: independent direct-S3 listing is a follow-up (DH-4) |
| L5 VPC scene about 50% first-attempt pass (model/Vultr variance) | EXTERNAL | RISK-ACCEPTED: disclosed in gate-run-log.md (DH-5) |
| ~4 active-instance ceiling per account | EXTERNAL | RISK-ACCEPTED: broker MAX_INSTANCES=1; Vultr support ticket pending with Dami |
| Rehearsal overrides on VM1 (SESSIONS_PER_IP=30, LIVE=10) | STRUCTURAL | OPEN: must revert before public window (DH-1) |
| Session key lifetime 60 min | STRUCTURAL | RISK-DISMISSED: by design |

## Delegation Manifest (Phase 3)
Ownership: connections/credentials = wire; demo path = verify_milestone; journeys, edges, attacks, AI-agent classes = stress_test. Handoff rows appended to PULSE Downstream Items (DH-1..DH-8) and mirrored in .debug-state.json. Single smoke: broker + verifier health PASS.

## Security Audit (Phase 4, structural)
- Secrets: no key-shaped strings in tree; no .env tracked; .env gitignored; value-scan of every .env variable against full git history and tree: only VULTR_S3_HOST (a public hostname, not a secret). PASS.
- Config: no /debug|/admin|/test routes; no CORS headers (same-origin only); rate limits present on write endpoints.
- Mock leak scan: no vi.mock of live dependencies in tests. PASS.
- Gas / events / reentrancy: N/A (no contracts).
- Frontend review found no XSS (all dynamic values via textContent) and no dead links. No CSP header (SHOULD-FIX, S7).

## Senior Dev Critique (Phase 5)
Reports: debug-results/phase-5-core-critique.md (4 M / 9 S / 8 N), phase-5-agent-verifier-critique.md (4 M / 11 S / 9 N), phase-5-frontend-critique.md (3 M / 14 S / 9 N).

## Fix Round (Phase 6)
| ID | Finding | Fix | Test |
|---|---|---|---|
| core M1 | max_instances check-then-act race (5 parallel creates, cap 2, all ALLOW) | creates serialized via Serial helper (pipeline.ts) | DBG-M1 (fails when the fix is reverted, verified by the fixer) |
| core M2 | zero-cost calls spend-gated; kill switch dead at cap | caps apply only to cost > 0 (spend.ts) | DBG-M2 x3 |
| core M3 | worker row stuck live after instance gone | reap reconciles via instance list (new reclaim.ts); DELETE 404 closes row | DBG-M3 x2 |
| core M4 | OutcomeUnknown never recorded | onUnknown wired; counts toward max_instances; reclaim resolves | DBG-M4 x3 |
| agent M1 | stale lease.json after VM2 reboot makes the watchdog destroy everything | boot-grace window from process start (opt-in, production on) | DBG-V-M1 x7 |
| agent M2 | 64 KB stdout cap drops PLB_RESULT | head + rolling 16 KB tail capture | DBG-S-M2 x3 |
| agent M3 | runner capacity 2 vs api admission 4 | api MAX_IN_FLIGHT default 2 | DBG-R-M3 x2 |
| agent M4 | watchdog.env missing VERIFIER_UID; re-run clobbers hand-set values | flag + preserve | DBG-O-M4 x5 |
| frontend M1 | production-policy button always 413 | per-route bodyLimit 70 KB | DBG-1 |
| frontend M2 | dead SSE leaves Fire disabled | DEFERRED to design integration (DH-6) | n/a |
| frontend M3 | button handlers lack error handling | DEFERRED to design integration (DH-6) | n/a |

Final: tsc clean; vitest 872 passed / 13 skipped (67 files); boundary lint 17/17; existing tests untouched (git diff shows additions only).

## Unresolved Items
- 2 MUST-FIX frontend (M2, M3) deferred by sequencing, not abandoned.
- 34 SHOULD-FIX and 26 NOTE not fixed this round (listed in the three phase-5 reports). Highest value among them: verifier cached-GREEN of any age and permanent false RED after a create returns 502 but succeeds; chain_head changes on every reap; operator retries re-run code that may already have created resources; teardown has no wait between instance and VPC deletes; no CSP header.
- Fixes are NOT deployed. The live VMs run pre-debug code; gates were not re-run against the new code.

## Confidence Score Justification
100 - 20 (two MUST-FIX deferred, 10 each) = 80. No adjustment. Above the 75 live-demo threshold. Not a claim that exhaustive behaviour was tested (stress owns that).
