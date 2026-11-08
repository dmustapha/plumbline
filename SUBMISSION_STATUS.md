# Submission status
_Last updated: forge Phase 2 (ARCHITECTURE.md, DECISIONS.md, LIMITATIONS.md written; no code in the repository yet)_

## Status
- [x] PRD, INVARIANTS, DEEP-RESEARCH (technical spike), USER-ONBOARDING, ROUTE-ARCHITECTURE and the c1 SCOPE-KICKOFF exist (forge Phases 0 to 1).
- [x] ARCHITECTURE.md written with 163 complete file blocks; the extracted text typechecks (`tsc --noEmit`, 0 errors) and its unit suite passes in a scratch directory (24 test files, 154 passed, 1 skipped). This is a check of the document, not of the platform.
- [x] DECISIONS.md (20 ADRs, each with a Rejected field), LIMITATIONS.md, and the security spec inside ARCHITECTURE.md Section 26.
- [ ] Core packages committed to `plumbline/app` (engine, ledger, adapter, broker skeleton): not started (build phase).
- [ ] GATE-L1 Tamper floor on the deployed broker VM: not started.
- [ ] GATE-L2 verifier GREEN/RED, dollar-DENY, caps/destroy/next task: not started.
- [ ] GATE-L3 watchdog dead hand: not started.
- [ ] GATE-L4 ACL tiers: not started.
- [ ] GATE-L5 breadth (firewall, VPC, registry): not started.
- [ ] GATE-L6 Rewind: not started.
- [ ] GATE-L7 bond (`refuses_after_slash` plus a live run): not started.
- [ ] First-hour probes U-1 to U-15 recorded in `evidence/probe-first-hour.txt`: not started.
- [ ] Bootstrap of both VMs, tier keys, baseline manifest, TLS: not started.
- [ ] Video, slides PDF, README, repo, lablab form: not started (demo and package phases).

## Known limitations / blockers
- Nothing has run on a Vultr VM. Reason: build and deploy have not started; every platform-dependent file is tagged UNVERIFIED in ARCHITECTURE.md.
- Demo, narration, opening and slides are undecided. Reason: Dami deferred R10 with a binding commitment; the demo phase must not run without a full deliberation with him.
- lablab enrollment approval is still pending (external email). Reason: R9; blocks the submission form only, not the build.
- Spend approval for the two always-on VMs is not recorded. Reason: `durability-tier.json` has `spendApproved: false` until Dami confirms the credit-only plan (about $12 to $22 of the $200 credit) and that no payment method is attached.
- Repo creation and publishing need Dami's explicit OK. Reason: publishing is irreversible (R8/R9); the public repo is created later by copying `plumbline/app/` into a fresh directory with fresh history.
- gVisor is not claimed. Reason: U-1 is a single 30-minute attempt on the VM and has not been made.
- Registry push is not claimed. Reason: U-8 is unverified.
- Sandbox egress on the VM image is unproven. Reason: U-4 was proven only on a local Docker (colima 28.5.1); the fallback transport is designed.
- Object Storage from Node is unproven. Reason: U-5; boto3 was proven, the Node SDK path was not run.
- Tier key expiry control and the ip-whitelist removal path are unproven. Reason: U-10 and U-11; the bootstrap prints a warning if `date_expire` is missing.
- Any rung not passing its gate by Nov 7 2026 20:00 UTC is excluded from the demo. Reason: the safety rule (R7).
