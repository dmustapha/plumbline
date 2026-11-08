# Proof

Real evidence only. Nothing here is a transaction hash; Plumbline runs against a Vultr account, not a chain.

- Public ledger export: https://plumbline.108-61-70-169.sslip.io/api/ledger/public. Check it with `scripts/verify-ledger.mjs` (see HACKATHON-README.md, Verify in 60s).
- Claims ledger: `npm run verify-claims` re-derives 7 of 8 claims as CITABLE (CL-L2 to CL-L7 and CL-GV), none tampered. CL-L1 passed its live gate earlier today and is withheld only because a docs-only commit touched its test path afterwards; its re-run is pending. Output: `evidence/claims-regenerated.json`, table in `CLAIMS.md`.
- Gate evidence files: `evidence/gate-l1.json` to `evidence/gate-l7.json`, plus `evidence/probe-first-hour.txt` for the gVisor line.
- Tests: 1189 tests across 82 files, offline, no credentials (`npm test`, repo README Tests section).
- Second-region verifier: https://66-42-126-97.sslip.io/api/verify
- Live range self-report: https://plumbline.108-61-70-169.sslip.io/api/proof
- Checks page: https://plumbline.108-61-70-169.sslip.io/docs/check
