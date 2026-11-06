# Honesty ledger

Limits stated on screen and in the README. Each line is a promise not to claim more.

- That Plumbline prevents create-then-delete: the verifier is point-in-time and destroy is visible within 0.8 s (KP-P1). Say "detects resources that exist at poll time and have no ALLOW row".
- That spend shown is Vultr's invoice or ground truth: it is broker arithmetic from public hourly prices (Vultr's `pending_charges` is whole cents with a 1-hour minimum, KP-P1).
- That the model resists attacks: the demo runs in disclosed compliant-operator mode; models refused 15 of 15 injected deletes in the probe (KP-P3), which is anecdotal and is not a safety claim either way.
- That the sandbox is a microVM or "unescapable": it is a hardened Docker container; gVisor only if a run on the VM succeeded (R2).
- That it reverses VM deletion: the VM snapshot took 609.9 s (KP-P5). The only reversible class is Object Storage versioning (restore 0.29 s, KP-P4).
- That a bond or slash deters the model: "authority is the deterrent"; the bond is a risk budget (Undo-or-Insure challenge finding).
- That policy edits change production behavior: they change the judge's own sandbox copy only.
- That ACL tiers give per-resource scoping or a deploy-only tier: Vultr has neither (KP-P2); the engine is the fine-grained control and the ACL key is defense in depth.
- That receipts, hash chains or logs are the proof: the headline is reconciliation against the live account (Thesis DRIFT TRIPWIRES).
- That any code, policy or document from leash or Backstop was reused (concern 15 override condition).
- That registry push works unless U-8 passed; that gVisor works unless U-1 passed; that a read-only key can read billing unless U-6 passed.

## Limits found on the real Vultr account (2026-11-06, each with evidence)
- Isolation tier: the sandbox is a hardened Docker container run under gVisor (`runsc`, U-1 evidence/probe-first-hour.txt). The VM has no /dev/kvm (U-3), so it is NOT a microVM and not claimed to be unescapable.
- Registry: Vultr allows one free registry per account and the protected shared `plumblinereg` holds it. A registry create is engine-gated (the engine ALLOWs, Vultr then answers 422); we do not claim a live registry create/delete cycle. Registry push is not claimed (U-8).
- Playgrounds: Vultr allows 5 VPCs per location on this account. Hot-edit playgrounds are VPCs spread over ewr and ord, capped at 4 per region; when full, a session still attacks but shows "playground at capacity".
- Verifier ACL check: a view-only key is 403 on GET /account, so the verifier cannot read its own ACL list. It proves its shape by status codes (read-only probes); the exact ACL set is asserted by the owner when the keys are created (bootstrap).
- Rewind proof: the L6 gate reads object versions through the broker's own S3 store, not an independent client.
- Spend shown is broker arithmetic from public hourly prices, not Vultr's invoice.
- New Vultr instances answer 409 "Server is currently locked" until installed (~20 s); gates and cleanup retry on it.
- Instance creation showed one transient "maximum number of active instances" refusal from Vultr that cleared on its own; provisioning under load is subject to Vultr account limits.
