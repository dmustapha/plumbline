# Domain guide

### 21.1 Key concepts

| Term | Definition | Source |
|---|---|---|
| Range | the public, judge-attackable environment: a real Vultr account scope guarded by the engine | PRD 1 |
| Operator | the code-writing AI agent (planner glm-5.3, executor qwen3.8-27b) that is attacked | PRD C3, R1 |
| Compliant-operator mode | system prompt that makes the model obey; disclosed on screen: "the model obeys; the engine is the defense" | R4, INVARIANT 8 |
| Policy engine | pure function `evaluate(request, sessionPolicy, floorPolicy, state)` returning ALLOW, ESCALATE or DENY with a rule id | PRD C6 |
| Production floor | immutable policy layer; final verdict is the most restrictive of floor and session copy | D-FLOOR, INVARIANT 5 |
| Session copy | the judge's private, hot-editable copy of the default policy; affects only that session | R5 |
| Broker | the only process that holds Vultr, inference and S3 credentials | INVARIANT 1 |
| Capability token | per-task token (not a Vultr credential) that is the sandbox's only transport | INVARIANT 1 |
| AllowDecision | engine-minted value that every mutating adapter method requires | INVARIANT 2 |
| spend() | the single ledger choke point consulted before any network I/O | INVARIANT 4 |
| Broker arithmetic | spend computed from public hourly prices with a one-hour minimum; NOT Vultr's invoice | KP-P1 |
| Verifier | second-region process with a view-only key that reconciles the live account against the ledger and the baseline | INVARIANT 3 |
| Baseline manifest | owner-created infra and `plumbline-prod-db` ids, stored on VM 2 where the broker cannot edit it | Section 13 |
| Watchdog / dead hand | VM 2 process that destroys `plumbline-wk-*` and `plumbline-s*` when the broker lease lapses | PRD C9, F7 |
| Rewind | restoring an earlier Object Storage version with CopyObject; the only live undo | KP-P4 |
| Bond | a small risk budget held and burned around irreversible actions; refuses the next provision after a slash | PRD F10 |

### 21.2 Rules the code must enforce

- Default is deny; an unmatched request returns `default-deny`.
- Target labels and tags come from the live account, never from the model.
- `plumbline-prod-*` and `plumbline-infra-*` cannot be deleted or updated through any non-owner path.
- The ledger refuses before any network I/O; the cap and ceiling are owner-set only.
- Every verdict shown is a decision row written by `recordDecision` after the engine returned.
- Hot-edit changes only the caller's session copy; production changes need a deploy with a detached Ed25519 signature.
- A tier whose key returns 401 is unavailable; there is no fallback to a stronger key.
- A verifier Vultr error or unreachable export is DEGRADED, never GREEN.

### 21.3 Glossary: domain term to code identifier

| Domain term | Identifier |
|---|---|
| attack verdict | `Decision` (`packages/policy-engine/src/types.ts`) |
| rule id | `Decision.rule_id`, catalog `RULE_IDS` (`catalog.ts`) |
| protected target | tag `protected` / label `plumbline-prod-db` |
| session playground | firewall group `plumbline-s<sid>-vault [protected]` |
| worker | instance labelled `plumbline-wk-*` |
| tier | `Tier` and `TierKeys` |
| live list | `LiveList.fetch` |
| lease | `LeaseEmitter` (broker) / `LeaseReceiver` (verifier) |
| kill-switch | `KillSwitch` |
| earned counter | `proofCounts` |

Source mapping: terms trace to PRD.md Sections 1, 2 and 4, INVARIANTS.md, and KP-P1 to KP-P6 as cited in the table above; build copies the definitions verbatim.
