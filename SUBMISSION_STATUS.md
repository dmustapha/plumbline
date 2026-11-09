# Submission status
_Last updated after the lablab submission (2026-11-08). The numbers below are recomputed by the commands shown, not typed in._

## Status
- [x] Range built and deployed on two Vultr VMs: broker and range in ewr (https://plumbline.108-61-70-169.sslip.io), verifier and watchdog in ord (https://66-42-126-97.sslip.io/api/verify).
- [x] Gates L1 to L7 pass live and write `evidence/gate-lN.json`. `PLUMBLINE_URL=https://plumbline.108-61-70-169.sslip.io npm run verify-claims` lists which claims are citable at the current commit; at the submitted commit all eight (CL-L1 to CL-L7 and CL-GV) are.
- [x] Offline suite: `npm test` (1189 passed, 13 skipped, 82 files, no credentials). `npm run typecheck` is clean.
- [x] gVisor (runsc) isolation verified live; `evidence/probe-first-hour.txt` carries the line `GVISOR OK`.
- [x] Public repo, hosted demo video, slides PDF and the lablab entry exist (links in `submission/links.md`).

## Known limitations
The authoritative lists are `LIMITATIONS.md` and `HONESTY-LEDGER.md`. In short:
- The sandbox is a hardened Docker container under gVisor, not a microVM (no `/dev/kvm` on the VM plan).
- Registry image push is not claimed; registry create, list and delete go through the engine.
- Spend shown is broker arithmetic from public hourly prices, not Vultr's invoice.
- The verifier is point-in-time: it detects resources that exist at poll time and have no ALLOW row; it cannot see a create-then-delete between two polls.
- The demo runs the operator in disclosed compliant-operator mode; the claim is the containment, not that the model resists attacks.
- Gate evidence is only citable when it was recorded at a declared commit; if code changes after a gate ran, `verify-claims` withholds that claim until the gate is re-run.
