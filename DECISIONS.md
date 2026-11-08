# Architecture Decision Records - Plumbline

Written by hackathon-forge Phase 2 (2026-11-06). Rulings R1 to R9 are transcribed from `warroom/OPEN-DECISIONS.md` (LOCKED with Dami); R10 is DEFERRED by Dami. The other records are architecture choices made while writing `ARCHITECTURE.md`. Every record carries a Rejected field. `Where` points into `ARCHITECTURE.md` (section numbers) or the file that carries the decision.

## ADR-001: TypeScript monorepo with no build step
- Context: the stack had to be chosen for a 2.4-day window; rivals mostly use Python; Dami's capability sheet says TypeScript; the generated operator code is Python anyway.
- Decision: npm workspaces, Node 24, Fastify, `better-sqlite3`, vanilla JS UI; packages expose `src/index.ts` through `exports` and run directly under `tsx` (no compile step, no bundler). Operator-generated code is Python 3.12 inside the sandbox. New clean MIT repo rooted at `plumbline/app/`, no leash or Backstop code.
- Rejected: a Python (FastAPI + static page) stack, because the engine, broker and UI would share one runtime with the untrusted generated code's language and Dami would context-switch; and a Next.js UI, because a framework adds a build step and a dependency surface to the public repo with no judge-visible benefit.
- Consequence: one language for all trusted code, shared types between engine, broker and UI contracts; every service starts with `node --import tsx`; the deployed VM needs `tsx` installed (Node 24 on the VM is [UNVERIFIED]).
- Where: Sections 1.2, 3.

## ADR-002: The operator is a code-writing agent in a sandbox
- Context: Blast Radius Zero requires an agent that writes and runs code or drives a browser, every action sandboxed; the first winner brief described only API tool calls.
- Decision: planner glm-5.3 and executor qwen3.8-27b produce Python (`submit_python`); it runs in a throwaway hardened container with no credentials and one route, the broker; the broker and engine gate every Vultr call the code makes.
- Rejected: (b) API tool-calling only, because it likely fails the Pattern A/B requirement and makes caps, destroy and the next task artificial; (c) the browser pattern, because it is heavier and needs vision and an approval gate.
- Consequence: caps, destroy and the containment moment are natural; the operator needs a retry loop for Python bugs; a model can refuse (shown honestly).
- Where: Sections 9, 10; `packages/operator/src/loop.ts`.

## ADR-003: Hardened Docker floor, one gVisor attempt, no microVM
- Context: `/dev/kvm` is untested (KP-P7 skipped) and microVM setup is risky; commodity Docker is table stakes in a saturated lane.
- Decision: no network except the broker, read-only rootfs, `--cap-drop ALL`, `no-new-privileges`, non-root, memory/CPU/pids/wall caps, destroy after every task. ONE 30-minute `runsc` attempt on the VM; claim above-Docker isolation only if it ran.
- Rejected: gVisor as the floor (unproven on the plan), and Firecracker/microVM (dropped: nested virtualization unproven).
- Consequence: the README claim is "hardened container, credentials in another process", never "unescapable"; the shared kernel remains in the Not defended against list.
- Where: Sections 9, 26, 27 (U-1..U-3); `ops/scripts/probe-first-hour.sh`.

## ADR-004: Three processes on the broker VM
- Context: the broker must hold every credential; the sandbox needs Docker; the public API faces the internet. Docker group membership is root-equivalent.
- Decision: `plumbline-broker` (credentials, no Docker), `plumbline-runner` (Docker, no credentials, Unix socket + token), `plumbline-api` (public, neither). All talk over 0660 Unix sockets in group `plumbline-ipc`.
- Rejected: one process (a public-API bug would hold both credentials and Docker), and Docker access inside the broker (a container escape would then sit next to every key).
- Consequence: three units and two IPC tokens to deploy; a runner compromise is host root (stated in Not defended against); the API cannot be made to hold a credential because its loader refuses to boot with one.
- Where: Sections 2.1, 9, 14; `apps/*/src/config.ts`.

## ADR-005: Relay-container egress shape for the sandbox
- Context: the sandbox needs exactly one route, to a broker that runs on the host. The probed pattern (DEEP-RESEARCH 0B-3) was an `--internal` network with a dual-homed peer.
- Decision: network `plb-sbx-net` (`--internal`, fixed subnet, bridge `br-plb`) plus one dual-homed relay container `plb-gate` that forwards only `POST /v1/call` and `GET /healthz` to the broker's docker0 listener; a host rule drops all INPUT from `br-plb`.
- Rejected: binding the broker on the internal network's own gateway address (untested, and the gateway is also a route to every host service), and `--network none` with a bind-mounted socket as the primary (a host mount is exactly what the invariant forbids; kept only as the U-4 fallback).
- Consequence: one extra container and one iptables rule set; the shape is verified locally but not yet on the VM image; the egress evidence shown to judges is the sandbox's own route table and connection log, not a packet sink.
- Where: Section 9; `packages/sandbox/gate/relay.mjs`; `ops/scripts/firewall-rules.sh`.

## ADR-006: Decisions are minted only by the engine; approvals re-run the engine
- Context: INVARIANT 2 says no mutating Vultr call without an engine ALLOW, and INVARIANT 7 says no fabricated verdict.
- Decision: `AllowDecision` is a branded type plus a runtime `WeakSet` of engine-minted frozen objects; every adapter mutator calls `assertAllow` and checks verb/class; `recordDecision` refuses non-minted decisions; an ESCALATE approval re-evaluates the stored request against the current policy and only then mints an ALLOW (`approveEscalation`), and never for a floor deny.
- Rejected: a type-only brand (a cast defeats it), and storing the first verdict and trusting it at approval time (a stale card could execute after the policy changed).
- Consequence: forged objects fail at runtime and at compile time; the approval path costs one extra evaluation; the engine owns a module-level `WeakSet`, the only mutable state in the core.
- Where: Section 4 (`evaluate.ts`), Section 7, Section 8 (`pipeline.ts`).

## ADR-007: Per-session policy copy, immutable signed floor, free playground
- Context: judges must edit policy under attack on a public range that owns a real protected instance.
- Decision: anonymous sessions; each judge edits a private YAML copy; the final verdict is the most restrictive of the session copy and the production floor (loaded at boot, verified against a baked-in Ed25519 public key); the flip demo targets a free per-session firewall group `plumbline-s<sid>-vault [protected]`; 3 attacks per minute; no HTTP route writes the production policy.
- Rejected: editing the one policy (a judge could destroy the protected target), and a per-session copy with no floor (the copy would still allow it).
- Consequence: judges may misread the floor as a failed flip on prod-db (the card shows both layers); one firewall group per session counts against an unknown Vultr limit (U-12).
- Where: Sections 4, 5, 8 (`policyStore.ts`), 12.

## ADR-008: Tiered restricted sub-user keys, IP-locked, with scoping, a cap and a kill-switch
- Context: random judges attack a real account.
- Decision: five tier keys (`subscriptions_view`, `provisioning`, `firewall`, `registry`, plus the verifier and watchdog keys on VM 2), each IP-locked, with explicit expiry; label-prefix scoping in the engine; global cap $10; session ceiling $1.50; owner-only kill-switch; no billing or users ACL anywhere.
- Rejected: using the owner key behind the broker (worst blast radius), and a single `provisioning` key for all verbs (Vultr has no deploy-only or destroy-only tier, so one key hides which verb needed which power).
- Consequence: a broker compromise is still an administrator-level event for compute (no per-resource scoping exists); the layers around it turn it red rather than prevent it.
- Where: Sections 7 (`tiers.ts`, `users.ts`), 14, 15, 26.

## ADR-009: Disclosed compliant-operator mode
- Context: models refused 15 of 15 injected deletes (KP-P3), so a range that relies on injection would never exercise the engine.
- Decision: a fixed system prompt makes the model execute the request; the prompt and the sentence "the model obeys; the engine is the defense" are on screen; refusals are still shown honestly; a second-model suite is a bonus.
- Rejected: relying on real prompt injection (would not fire), and a hidden scripted tool call posing as the model (fabrication; INVARIANT 7).
- Consequence: no claim about the model resisting attacks; U-14 measures whether the prompt reliably produces the attempt, with glm-5.3 as the fallback executor.
- Where: Section 10 (`prompts.ts`), `/about`.

## ADR-010: Verifier and watchdog on a second-region VM as two processes with two keys (R6 LOCKED, D-R6a)
- Context: the broker's ledger is written by the same trust root that acts; the watchdog must destroy, but Vultr has no destroy-only permission.
- Decision: VM 2 in another region (`ord`, with fallbacks) runs `plumbline-verifier` (view-only key) and `plumbline-watchdog` (its own scoped key, ACLs `provisioning` + `firewall` so it can also delete session playgrounds, list+delete code only, every delete decided by the engine under the repo floor). The verifier compares the live account to the ledger export AND to a baseline manifest the owner places on VM 2, and tolerates ids the watchdog destroyed. Verifier errors are DEGRADED, never GREEN.
- Rejected: a verifier on the broker box (a compromised broker could forge ground truth), one shared key for both jobs (the verifier would gain create/delete power), and a broker-held baseline (the broker could edit what "authorised" means).
- Consequence: coverage is instances, VPCs and registries only (the view-only key cannot list firewalls or buckets); create-then-delete between polls is invisible; the watchdog key is broader than PRD C9 said (firewall added).
- Where: Section 13; `apps/verifier/src/`.

## ADR-011: Spend is broker arithmetic behind one `spend()` choke point
- Context: Vultr's `pending_charges` is whole cents with a one-hour minimum per line and does not track real accrual (KP-P1).
- Decision: every Vultr, S3 and VSI call obtains a `SpendGate` receipt before any network I/O; projected cost is hourly price (public rate card) times `max(1, ceil(ttl))`; the number is labelled BROKER ARITHMETIC; the rate card fails closed after ten minutes.
- Rejected: showing `pending_charges` as live spend (it lies about granularity), and per-adapter budget checks (a new adapter could forget one).
- Consequence: the adapter's http client cannot be constructed without a gate; the displayed figure can differ from the invoice (U-15); the verifier uses a call-count gate instead of dollars.
- Where: Section 6 (`spend.ts`), Section 7 (`http.ts`).

## ADR-012: Append-only SQLite decision store written only by `recordDecision`
- Context: INVARIANT 7 forbids seeded, imported or typed verdicts and counters.
- Decision: SQLite with `BEFORE UPDATE/DELETE` triggers that abort; the only insert is `recordDecision`, which refuses anything the engine did not mint; `bootstrap:range` creates Vultr resources only; the mock Vultr client lives in `test/` and the broker refuses to boot when `PLUMBLINE_MOCK_VULTR` is set.
- Rejected: a JSON ledger file (no append-only guarantee, easy to hand-edit), and a seed script for first-visit rows (violates the earned-state rule).
- Consequence: first-visit rows exist only after `earn-history` actually ran attacks; an empty store shows "nothing is fabricated".
- Where: Section 6 (`db.ts`, `decisions.ts`), Section 8 (`config.ts`).

## ADR-013: Static vanilla multi-page UI with `textContent` only
- Context: the UI shows attacker-controlled strings (labels, quoted calls, reasons) and must work at 400 px with no login.
- Decision: ten HTML shells, one `app.js`, one stylesheet, served by Fastify; all dynamic text via `textContent`; verdict cards come from server-built SSE events read from the decision store.
- Rejected: a React/Next single-page app (build step, larger attack surface, nothing a judge sees), and `innerHTML` rendering (XSS from model- and judge-controlled text).
- Consequence: no client-side verdict state; page logic is plain JS without type checking (covered by `node --check` and the UI smoke path in the livetest phase).
- Where: Section 12.

## ADR-014: Rewind via Object Storage versions, classified from S3 truth
- Context: a VM snapshot takes 609.9 s and has no instance id (KP-P5); versioned restore took 0.29 s (KP-P4).
- Decision: the only reversible class is the `plumbline-orders-db` bucket; last-copy detection reads `ListObjectVersions` straight from S3, not the broker's tags; restore is CopyObject of the earlier VersionId; the scene ships only if GATE-L6 passes.
- Rejected: VM snapshot as an undo (minutes, unlinked to its instance), and classification from broker tags (circular; cross-exam A3).
- Consequence: no VM undo claim anywhere; the Node S3 path (U-5) is unproven with boto3 as the fallback behind `S3Port`.
- Where: Section 11, Section 7 (`s3.ts`).

## ADR-015: Full ladder built in parallel behind gates
- Context: Dami: "I dont want the scope cut, go with whats best"; honest odds recorded.
- Decision: one build agent per rung against a frozen core; at Nov 7 2026 20:00 UTC any rung whose gate has not passed is excluded from the demo, not rushed; never dropped: engine, reconcile, caps+destroy+next task, honest trust-root statement, dollar-DENY.
- Rejected: cutting scope up front (Dami's ruling), and rushing a failing rung after the deadline (a half-working rung fails the earned-state rule).
- Consequence: seven gate scripts and a frozen core before fan-out; some routes may show "not enabled" in the final deployment.
- Where: Section 20; `ops/scripts/gates.ts`.

## ADR-016: Two always-on Vultr VMs with Caddy on sslip.io (D-DURABLE)
- Context: the judging window runs through at least Nov 12; free-tier hosts spin to zero and wipe state; BRZ needs a Vultr VM backend.
- Decision: broker VM `vc2-2c-4gb` (ewr) and verifier VM `vc2-1c-1gb` (second region), systemd units, Caddy automatic HTTPS on `<dashed-ip>.sslip.io`, plain-HTTP fallback.
- Rejected: spin-down hosts (state loss mid-window), and a third-party front (Vercel/Cloudflare) in front of the range (a non-Vultr hop in the demo path).
- Consequence: about $25/month rate, about $12 to $22 total over the window from the $200 credit; Dami must confirm no payment method is attached (spend approval pending).
- Where: Sections 14, 19; `durability-tier.json`.

## ADR-017: Owner scripts also go through the engine; no service accepts the owner key
- Context: owner tooling needs to delete `plumbline-prod-*` and `plumbline-infra-*`, which the runtime floor forbids.
- Decision: `ops/scripts/owner.ts` decides each call with an inline owner policy and a minimal owner floor; the adapter keeps exactly one mutator path; the broker, range API and verifier loaders throw if `VULTR_API_KEY` is in their environment.
- Rejected: an unguarded owner mutator in the adapter (a second path to defend), and keeping the owner key in the VM env files (the whole account on a public host).
- Consequence: owner scripts run only from Dami's machine; teardown cannot be run from a VM by design.
- Where: Section 14; `ops/scripts/owner.ts`.

## ADR-018: The sandbox job and capability token travel on stdin, not in the environment
- Context: the sandbox environment, `/proc/self/environ` and filesystem must hold no credential, and the headline test dumps all three.
- Decision: the runner pipes `{token, code}` to the harness on stdin; the container is started with no `-e`, `--env-file`, mount or published port; the docker CLI itself is spawned with a scrubbed environment; the token is a short-lived HMAC capability, not a Vultr credential.
- Rejected: passing the token as an environment variable (it would appear in the env dump the judge asks for and blur the "nothing to find" claim), and injecting any Vultr credential "just for the task".
- Consequence: the operator's code can read the token from the shim module; it expires with the task (120 s) and is revoked by the kill-switch.
- Where: Section 9; `packages/sandbox/src/docker.ts`, `harness.py`.

## ADR-019: Submission handling
- Context: the lablab screening form values are pending and approval is by external email; submission is an irreversible publish.
- Decision: Dami sends the form values; Claude fills the form in Dami's logged-in browser and STOPS before submit; Dami approves the two consents and the final click. No repo creation, Discord post or lablab submission without Dami's explicit OK.
- Rejected: Dami filling everything himself (slower), and Claude submitting autonomously (irreversible publish).
- Consequence: the package phase prepares `submission/` but publishes nothing; `SUBMISSION_STATUS.md` records the external approval as pending.
- Where: Section 22; `SUBMISSION_STATUS.md`.

## ADR-020: The demo is not designed in the architecture (R10 DEFERRED BY DAMI)
- Context: Dami deferred the opening, narration and format with a binding commitment to a full deliberation before the demo phase.
- Decision: the architecture provides what the demo needs (badged cuts, real timestamps, `DEMO_CAPS`, the lease TTL knob) and designs no script, voiceover or opening.
- Rejected: choosing an opening now "to unblock" the build, because the ruling says the demo phase must not run without the deliberation and no agent may settle it.
- Consequence: `PLUMBLINE_DEMO_CAPS` and `PLUMBLINE_LEASE_TTL_S=20` exist as knobs only; the first-15-seconds requirement (a consequence, not a title card) stays a constraint on whatever is decided.
- Where: Section 15; PRD Section 6 (skeleton only).
