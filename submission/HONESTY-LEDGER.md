# Honesty ledger

Sourced from the repo `HONESTY-LEDGER.md`, `LIMITATIONS.md` and the README Honesty ledger.

## Real
- Protected resources cannot be destroyed through the range; the live Vultr list is unchanged (gate L1).
- The verifier turns RED naming an out-of-band instance, then GREEN (gate L2, two runs).
- A dead broker lease makes VM 2 destroy workers and playgrounds only (gate L3, worker destroyed 58 s after the broker kill).
- A view-only tier key gets Vultr 403 on create (gate L4).
- Firewall group and VPC create and delete go through the engine (gate L5).
- A deleted canary object is restored as a new version from S3 truth, 1300 ms round trip (gate L6).
- After a bond slash the next provision is refused (gate L7).
- The sandbox is a hardened Docker container under gVisor (`GVISOR OK`, evidence/probe-first-hour.txt).

## Simplified
- Spend shown is broker arithmetic from public hourly prices, not Vultr's invoice.
- The demo runs in disclosed compliant-operator mode, so you are testing the policy engine, not the model's resistance.
- The verifier is point-in-time: it detects resources that exist at poll time with no ALLOW row.
- Policy edits change the visitor's own sandbox copy only.
- Hot-edit playgrounds are VPCs capped at 4 per region; when full, a session shows "playground at capacity".
- The L6 rewind proof reads versions through the broker's own S3 store, not an independent client.
- Registry create is engine-gated; Vultr allows one free registry per account and a shared one holds it.

## Not built
- A microVM or "unescapable" sandbox: the VM has no /dev/kvm.
- Reversal of a deleted VM: a Vultr snapshot took 609.9 s. Only Object Storage deletes can be reversed.
- Prevention of create-then-delete between two verifier polls.
- Per-resource ACL scoping or a deploy-only tier: Vultr offers neither.
- Registry push.
