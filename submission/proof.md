# Proof

Real evidence only. Nothing here is a transaction hash; Plumbline runs against a Vultr account, not a chain.

- Public ledger export: https://plumbline.108-61-70-169.sslip.io/api/ledger/public. Check it with `scripts/verify-ledger.mjs` (see HACKATHON-README.md, Verify in 60s).
- As of 2026-11-08 22:34 UTC (regeneration at origin commit debe3a9; no code changed since in 8220497). Evidence files can change when the gate runner reruns, so recompute rather than trust a number.
- Claims ledger: `npm run verify-claims` re-derives 8 of 8 claims as CITABLE (CL-L1 to CL-L7 and CL-GV), none withheld, none tampered. Output: `evidence/claims-regenerated.json`, table in `CLAIMS.md`.
- Gate evidence files: `evidence/gate-l1.json` to `evidence/gate-l7.json`, plus `evidence/probe-first-hour.txt` for the gVisor line.
- Restore round trip: 929 ms in the latest gate L6 run (`evidence/gate-l6.json`, 2026-11-08 18:55 UTC).
- Tests: 1189 tests across 82 files, offline, no credentials (`npm test`, repo README Tests section).
- Second-region verifier: https://66-42-126-97.sslip.io/api/verify
- Live range self-report: https://plumbline.108-61-70-169.sslip.io/api/proof
- Checks page: https://plumbline.108-61-70-169.sslip.io/docs/check
