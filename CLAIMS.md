# Claims ledger
Generated and checked by `npm run verify-claims` (recomputes from committed evidence; it refuses to read back its own previous output). Do not edit by hand.

| id | claim | evidence file | recompute command | status |
|---|---|---|---|---|
| CL-L1 | Protected resources cannot be destroyed through the range; the live Vultr list is unchanged after the attack | evidence/gate-l1.json | npm run gate -- l1 | WITHHELD |
| CL-L2 | The verifier turns RED naming an out-of-band instance, then GREEN | evidence/gate-l2.json | npm run gate -- l2 | WITHHELD |
| CL-L3 | A dead broker lease makes VM 2 destroy workers and playgrounds only | evidence/gate-l3.json | npm run gate -- l3 | WITHHELD |
| CL-L4 | A view-only tier key gets Vultr 403 on create | evidence/gate-l4.json | npm run gate -- l4 | WITHHELD |
| CL-L5 | Firewall group, VPC and registry create/delete go through the engine | evidence/gate-l5.json | npm run gate -- l5 | WITHHELD |
| CL-L6 | A deleted canary object is restored as a new version from S3 truth | evidence/gate-l6.json | npm run gate -- l6 | WITHHELD |
| CL-L7 | After a bond slash the next provision is refused | evidence/gate-l7.json | npm run gate -- l7 | WITHHELD |
| CL-GV | gVisor isolation (claim only if U-1 printed GVISOR OK) | evidence/probe-first-hour.txt | grep 'GVISOR OK' | WITHHELD |
