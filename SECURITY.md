# Security

| Threat | Enforcement | File |
|---|---|---|
| Agent or sandbox reads a credential | no secret in the sandbox env, image, stdin job or filesystem; docker CLI spawned with a scrubbed env; operator/API types have no secret member; boundary lint | `packages/sandbox/src/docker.ts`, `packages/operator/src/llm.ts`, `tests/boundary-lint.test.ts` |
| Sandbox reaches the internet or the host | internal network, path-restricted relay, host INPUT drop from `br-plb`, `--cap-drop ALL`, read-only rootfs, pids/mem/cpu/wall caps | `packages/sandbox/gate/relay.mjs`, `ops/scripts/firewall-rules.sh`, `packages/sandbox/src/docker.ts` |
| Mutation without an engine ALLOW | branded `AllowDecision` required by every mutator, runtime `assertAllow`, verb/class binding | `packages/policy-engine/src/evaluate.ts`, `packages/vultr-adapter/src/resources.ts` |
| Model lies about a target's label or tags | broker resolves target facts from the live account; model-supplied label/tags discarded | `apps/broker/src/pipeline.ts` |
| Judge weakens protection | per-session copy only; immutable floor evaluated together; production write route answers only `SIG_REQUIRED`/`SIG_INVALID` | `apps/broker/src/policyStore.ts`, `apps/range-api/src/routes.ts` |
| Forged or replayed approval | approval bound to decision id + nonce, re-evaluated at approval time, floor deny cannot be approved | `apps/broker/src/approvals.ts`, `packages/policy-engine/src/evaluate.ts` (`approveEscalation`) |
| Credit drain | `spend()` before I/O, session ceiling, global cap, one-hour minimum, fail-closed rate card | `packages/ledger/src/spend.ts`, `policy/floor.yaml` |
| Fabricated verdicts or counters | `recordDecision` accepts only engine-minted decisions; append-only triggers; no seed path; mock cannot boot | `packages/ledger/src/decisions.ts`, `packages/ledger/src/db.ts`, `apps/broker/src/config.ts` |
| Compromised broker rewrites ground truth | verifier on another host with its own view-only key and a baseline the broker cannot edit | `apps/verifier/src/reconcile.ts`, `apps/verifier/src/verifierServer.ts` |
| Watchdog destroys the wrong resource | engine-decided deletes under the repo floor plus a watchdog policy; protected-tag rule; dry-run first | `apps/verifier/src/watchdog.ts` |
| Public flood | 3 attacks/min/session, in-flight cap, session creation limit, 2 KiB body, per-task call budget | `apps/range-api/src/rateLimit.ts`, `apps/broker/src/routes-sandbox.ts` |
| Task token abuse | HMAC token, 120 s expiry, kill-switch epoch revokes all | `apps/broker/src/tokens.ts` |
| Owner key on a VM | every service refuses to boot with `VULTR_API_KEY`; owner scripts run from the owner machine | `apps/broker/src/config.ts`, `apps/range-api/src/config.ts`, `apps/verifier/src/config.ts` |
| Exfiltration through the `fetch` verb | host allow-list in the floor, GET only, no redirects, 64 KiB cap | `policy/floor.yaml`, `apps/broker/src/egress.ts` |
| Key expiry or IP change kills the range | explicit expiry >= 2026-11-14 at issue, status banner shows days left, tier marked unavailable, no fallback | `ops/scripts/bootstrap-range.ts`, `packages/vultr-adapter/src/tiers.ts` |

### Not defended against

- A container escape through a shared-kernel vulnerability: the sandbox is a hardened Docker container, not a microVM; it runs under gVisor (runsc), verified live.
- Compromise of the runner daemon: it has Docker access, which is root-equivalent on VM 1, so host root and every file on it (including the broker env file) would follow. The mitigation is its small surface and no credential, not impossibility.
- Compromise of the broker process: a `provisioning` key can destroy any instance in the account (Vultr has no per-resource scoping or destroy-only tier). Defence in depth is the IP lock, the tier keys, the verifier on another host and the watchdog, which turn the event red; they do not prevent it.
- Create-then-delete between two verifier polls (destroy is visible within 0.8 s); firewall groups and buckets are outside the view-only key's coverage.
- Spend accuracy against Vultr's invoice: the meter is broker arithmetic.
- Model robustness: the demo runs in disclosed compliant-operator mode; no claim about the model resisting attacks.
- Subscription-wide Object Storage keys: a leak exposes every bucket of the subscription (the bucket holds only canary data).
- Denial of service by a volumetric attacker against the public host; the limits protect credit, not availability.
- Supply-chain compromise of npm, PyPI or Docker Hub packages beyond a lockfile and a pinned base digest.
- Loss of the owner's policy-signing key or machine.

