# Limitations

Design-time scope boundary for the Vultr Agent Rush submission (Blast Radius Zero). It is fixed at forge time; the live status of each item is in `SUBMISSION_STATUS.md`. Every gated item names its reason.

## In scope (built for this submission)
- A judge-attackable range: anonymous session, a code-writing operator (planner glm-5.3, executor qwen3.8-27b, advisory nemotron-3.5-content-safety), all LLM calls through Vultr Serverless Inference.
- A coded policy engine returning ALLOW, ESCALATE or DENY with a rule id; policy as YAML data; an immutable production floor; a per-session hot-editable copy; Ed25519-signed production changes at deploy time.
- A broker that is the only holder of Vultr, inference and Object Storage credentials; tiered, IP-locked sub-user keys; label-prefix scoping; a $10 global cap and a $1.50 session ceiling enforced at one `spend()` choke point; an owner kill-switch.
- A hardened Docker sandbox per task with no credentials and one route, destroyed after each task; the next task succeeds after a runaway.
- A verifier on a second-region VM with its own view-only key that reconciles the live account (instances, VPCs, registries) against the ledger and a baseline manifest, GREEN or RED, DEGRADED on any Vultr error.
- A watchdog on the same VM, as a separate process with its own scoped key, that destroys `plumbline-wk-*` and `plumbline-s*` when the broker lease lapses.
- Breadth through the same engine: firewall groups, VPCs, registry create/list/delete; an Object Storage Rewind scene; an Undo-or-Insure bond scene.
- An append-only decision store whose only writer is the engine path; `/proof`, `/replay` (badged), `/status`, `/about`.
- 33 attack fixtures in ten groups, a property test, 20 judge-attack pairs each mapped to a test file, and seven rung gate scripts that write `evidence/gate-lN.json`.

## Feature-gated (deliberately not built or not claimed for this scope)
- Registry image push. Reason: unverified (U-8); only create/list/delete are built and claimed.
- gVisor or any above-Docker isolation claim. Reason: one 30-minute attempt on the VM (R2); claimed only if it runs; microVM is out because `/dev/kvm` is unproven.
- VM undo or snapshot rollback. Reason: a Vultr snapshot took 609.9 s and has no instance id (KP-P5); only Object Storage versioning is reversible.
- Verifier coverage of firewall groups and buckets. Reason: the view-only key gets 403 on `/firewalls` and `/object-storage`, and the ACLs that would allow reading also allow writing (U-6).
- Detection of create-then-delete between two verifier polls. Reason: destroy is visible within 0.8 s (KP-P1); stated on `/verify`.
- Per-resource or deploy-only/destroy-only ACL tiers. Reason: Vultr has none (KP-P2); the engine is the fine-grained control.
- A claim that the model resists attacks. Reason: the demo runs in disclosed compliant-operator mode (R4).
- Spend equal to Vultr's invoice. Reason: Vultr's `pending_charges` rounds to whole cents with a one-hour minimum; the meter is broker arithmetic.
- Rung features whose gate does not pass by Nov 7 2026 20:00 UTC (watchdog live beat, ACL tiers, breadth, Rewind, bond). Reason: the safety rule excludes them from the demo rather than rushing them (R7).
- Sub-delegation tree, browser pattern, managed database, Standard-tier Object Storage, any paid service beyond the approved $6 Archival subscription. Reason: deferred or not approved (OPEN-DECISIONS D1, D-OBJ).
- Any leash or Backstop code. Reason: concern 15 override condition (clean new repo).
- The demo script, narration, slides and video. Reason: deferred by Dami (R10) with a binding deliberation before the demo phase.
- Login, accounts, multi-tenant isolation beyond the per-session policy copy and budget. Reason: anonymous access is the product (R5); out of scope for a hackathon range.
- Production-grade availability (HA, backups of the ledger, multi-region broker). Reason: cost and time; the replay path and the kill-switch are the degradation story.
