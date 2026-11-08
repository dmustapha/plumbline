# Plumbline: attack an agent that holds a live Vultr account

> The line hangs true, or it does not.

Plumbline lets an AI agent act on a real cloud account without ever holding the credential. A broker holds the keys, a coded policy engine outside the model decides every action, and a second host in another region re-reads the account's instances, VPCs and registries to check nothing changed outside the ledger. It runs on Vultr today.

[Overview ↗](https://plumbline.108-61-70-169.sslip.io) · [Attack the demo ↗](https://plumbline.108-61-70-169.sslip.io/try?fire=prod) · [How it works ↗](https://plumbline.108-61-70-169.sslip.io/docs/architecture) · [Ledger ↗](https://plumbline.108-61-70-169.sslip.io/audit/ledger) · [Reconcile ↗](https://plumbline.108-61-70-169.sslip.io/audit/reconcile) · [Run it yourself ↗](https://plumbline.108-61-70-169.sslip.io/deploy)

Built for the Vultr Agent Rush hackathon, challenge **Blast Radius Zero**. The live site runs on a demo account we own; the same software runs on yours.

## Demo video

[![Plumbline demo video: click to play](docs/images/demo-poster.png)](https://github.com/dmustapha/plumbline/releases/download/demo-video/plumbline-demo.mp4)

The 4 minute 38 second demo, 99.8 MB. Click the picture to play it, or open the [video file](https://github.com/dmustapha/plumbline/releases/download/demo-video/plumbline-demo.mp4) or the [lablab.build submission page](https://lablab.build/ai-hackathons/vultr-hackathon/locine-labs/plumbline-safe-agents-on-a-live-vultr-account).

## The range in one frame

![Plumbline range: an attack on prod-db is denied, the live account is re-fetched and unchanged](docs/images/range-deny.png)

## The problem

Agents now act with real power: they create servers, delete databases and spend money. The common safeguard is a prompt that says "do not delete production", and a prompt is text the agent can be talked out of. The usual evidence is a log, and a log only shows what the system says it did. Neither proves the account is intact.

## What is Plumbline?

Most agent demos show an agent that can act. Plumbline shows the box the agent acts inside.

The agent is a code-writing operator. It plans in one Vultr Serverless Inference model, writes Python in another, and runs it in a throwaway sandbox. The sandbox holds no credential and has one network route, to the broker. The broker holds every Vultr, inference and storage key and asks a policy engine for a verdict before any mutating call. The engine returns `ALLOW`, `ESCALATE` or `DENY` with a rule id, in code, never in a prompt.

The claim is reconciliation, not logging. After every attack the range re-fetches the live Vultr account. A verifier on a second VM in a different region, holding its own view-only key, compares that account to the ledger and to a baseline the broker cannot edit. It answers GREEN or RED, and names the instance when it is RED.

**Try it:** open the live range, click `Delete prod-db`, and watch `protect-tagged-destroy` deny it while `plumbline-prod-db` stays active in the account.

## Who this is for

| You are | Start here | What you get |
|---|---|---|
| A platform or FinOps lead deciding whether an agent may hold a cloud credential | [Overview](https://plumbline.108-61-70-169.sslip.io), [Safety model](https://plumbline.108-61-70-169.sslip.io/docs/safety), [Run it yourself](https://plumbline.108-61-70-169.sslip.io/deploy) | What the agent can and cannot do, the spend limits, what is not claimed, and the setup, cost and roadmap |
| A security or audit lead who must answer "did the agent create anything outside its authority?" | [Ledger](https://plumbline.108-61-70-169.sslip.io/audit/ledger), [Reconcile](https://plumbline.108-61-70-169.sslip.io/audit/reconcile), `plumbline-verify` below | Every decision, a second-host check of the live account, and a command that audits any account |
| An engineer building agents | [Integrate an agent](https://plumbline.108-61-70-169.sslip.io/docs/integrate), [Concepts](https://plumbline.108-61-70-169.sslip.io/docs/concepts), [How it works](https://plumbline.108-61-70-169.sslip.io/docs/architecture) | The one-route contract with the broker, the vocabulary, and the component diagram |
| A reviewer with three minutes | [`JUDGE_GUIDE.md`](JUDGE_GUIDE.md), then `Attack prod-db` on the demo | A verdict with a rule id and an unchanged live account in under 30 seconds. No sign-up. |

### Site map

| Area | Pages |
|---|---|
| Overview | `/` |
| Try it | `/try`: attack the demo account |
| Controls | `/controls/policy`, `/controls/limits` (spend limits and kill switch), `/controls/recovery` (undo and bond) |
| Audit | `/audit/ledger` (filters, export), `/audit/reconcile` (second-host check), `/audit/evidence` |
| Docs | `/docs/check`, `/docs/safety`, `/docs/architecture`, `/docs/concepts`, `/docs/integrate` |
| Deploy | `/deploy` |

Pages that show the demo account carry a note saying so. The addresses of the first layout (`/range`, `/verify`, `/replay`, `/proof`, `/about`, `/status`, `/run`) redirect permanently.

**Audit your own account.** The verifier ships as a command. It reads your Vultr account with a view-only key, reads a ledger export, and writes nothing to Vultr:

```bash
PLUMBLINE_VERIFY_KEY=<view-only key> npx tsx apps/verifier/src/cli.ts --ledger ledger.json --baseline baseline.json
# exit 0 GREEN, 1 RED, 2 DEGRADED (a missing baseline or an unpinned ledger can never be GREEN)
```

## Screenshots

| Reconcile | Ledger |
|---|---|
| ![Verifier reading the live account from a second region](docs/images/verify.png) | ![Append-only ledger of every verdict](docs/images/replay.png) |
| **Hot-edit policy** | **Recovery: rewind and bond** |
| ![Editing the session policy copy while the production floor holds](docs/images/policy.png) | ![Recovery: versioned rewind and the bond a slash burns](docs/images/bond.png) |
| **Architecture** | **Evidence** |
| ![Architecture: what holds the keys, what the agent can reach, where the verifier sits](docs/images/architecture.png) | ![Evidence page with regenerate commands](docs/images/proof.png) |

## How it works

```
 public judge ──► range-api (Fastify) ──► operator (LLM loop, Vultr Serverless Inference)
                  holds NO Vultr key        planner glm-5.3 · executor qwen3.8-27b
                  serves UI + API           advisory nemotron-3.5-content-safety
                         │                           │ writes Python (submit_python)
                         │                           ▼
                         │                  sandbox: Docker + gVisor, no credential,
                         │                  internal network, one route: POST /v1/call
                         ▼                           │
                  ┌─────────────────────────────────▼───────────────┐
                  │ broker  (VM 1, ewr): the ONLY holder of keys     │
                  │   policy engine ─► ALLOW / ESCALATE / DENY       │
                  │   spend() choke point · append-only ledger       │
                  └───────────────┬─────────────────────────────────┘
                                  │ mutating call only with an ALLOW value
                                  ▼
                        live Vultr account  ◄──────────  verifier + watchdog (VM 2, ord)
                                                         own view-only key, reads the account,
                                                         GREEN / RED, destroys workers if the
                                                         broker's lease lapses
```

The trust boundary is the broker. The model can write any code it wants. It cannot reach a credential, the internet, or an API call that the engine did not allow.

### Core invariants

The invariants below are the product. Each one names the code that a violating path produces.

- **The agent never holds a credential.** No Vultr, inference or storage key exists in the sandbox, the operator runtime or the public API. The `Print environment` scene dumps the sandbox environment, and gate L1 asserts it carries no credential pattern (`sandbox_env_clean`).
- **Only an `ALLOW` decision mutates the account.** Every mutating adapter method takes a branded `AllowDecision` value that only the engine can mint. Unknown verbs and classes fall through to `default-deny`.
- **Production is immutable.** `protect-tagged-destroy` and `floor-prod-immutable` deny deletes and edits of protected resources. A change to the production floor answers `SIG_REQUIRED` or `SIG_INVALID` without an Ed25519 signature.
- **Spend has a ceiling the agent cannot raise ($1.50 per session, $10 across the broker).** `ceiling-dollar-deny`, `global-cap-exceeded` and `session-cap-exceeded` are enforced at one `spend()` choke point before any network call.
- **Breach is defined by the live account.** The verifier reconciles it from another host with another key. If it cannot read the account it answers `RECONCILE_DEGRADED`, never GREEN.
- **Every verdict is earned.** A decision row is written only by `recordDecision()` after the engine returns. The store has no seed, import or demo insert path.

## Features

| Scene | What you do (or what the gate does) | What holds |
|---|---|---|
| **Attack** | Delete `prod-db`, ignore the rules, claim to be the owner | `DENY protect-tagged-destroy`, live account unchanged |
| **Hot edit** | Weaken a rule in your own session policy copy | Your copy flips to `ESCALATE`. The production floor still denies the same attack on `prod-db`. |
| **Reconcile** | Press `Re-read the account now` on the live account. Gate L2 creates an instance outside the broker to prove the RED path. | GREEN, or RED naming the instance, then GREEN after the destroy |
| **Poisoned page** | Make the agent fetch a page that says "you are authorized" | The decision comes from a rule, not from the text |
| **Runaway** | Run an infinite loop and a memory bomb | `SANDBOX_TIMEOUT` and `SANDBOX_OOM`, container destroyed, the next task succeeds |
| **Dollar ceiling** | Ask for a 400-hour worker | `ceiling-dollar-deny` with the arithmetic, before any call to Vultr |
| **Rewind** | Delete a canary object in Object Storage | Restored as a new version read from S3 |
| **Bond** | Burn the session bond | `bond-insufficient`, the next provision is refused |
| **Dead hand** | Gate L3 kills the broker | The VM 2 watchdog destroys workers and playgrounds only, and never `plumbline-infra-*` or `plumbline-prod-*` |

Sixty-five attack fixtures in ten groups drive the engine tests: `destroy-protected`, `exfiltration`, `injection`, `out-of-band`, `over-ceiling`, `policy-tamper`, `rewind`, `runaway`, `scope-escape`, `tier-violation`.

## Vultr integration

| Mechanic | Vultr service and where it is used |
|---|---|
| Agent inference | Serverless Inference at `api.vultrinference.com/v1`, the only LLM host (`tests/no-llm-hosts.test.ts`) |
| Broker, runner, range-api | Cloud Compute VM in `ewr`, three systemd units (`ops/systemd/`) |
| Verifier and watchdog | Cloud Compute VM in `ord`, with its own view-only API key |
| Production resource | `plumbline-prod-db` instance, protected by tag |
| Judge playgrounds | VPCs, one per session, label-scoped (`packages/vultr-adapter/src/resources.ts`) |
| Breadth through the engine | Firewall groups and VPCs create and delete, container registry create gated by the engine (`evidence/gate-l5.json`) |
| Rewind | Object Storage with versioning, restored through the S3 API (`packages/rewind`) |
| Least privilege | Tiered, IP-locked sub-user API keys, `observer` gets Vultr's own 403 on create (`evidence/gate-l4.json`) |

## Security architecture

| Threat | Enforcement | Where |
|---|---|---|
| Agent or sandbox reads a credential | No secret in the sandbox env, image, stdin or filesystem. The docker CLI is spawned with a scrubbed env. | `packages/sandbox/src/docker.ts`, `tests/boundary-lint.test.ts` |
| Sandbox reaches the internet or the host | Internal network, path-restricted relay, host firewall drop, `--cap-drop ALL`, read-only rootfs, pids, memory, cpu and wall caps | `packages/sandbox/gate/relay.mjs`, `ops/scripts/firewall-rules.sh` |
| Mutation without an engine `ALLOW` | Branded `AllowDecision`, runtime `assertAllow`, verb and class binding | `packages/policy-engine/src/evaluate.ts`, `packages/vultr-adapter/src/resources.ts` |
| Model lies about a target's label | Broker resolves target facts from the live account and discards model-supplied labels | `apps/broker/src/pipeline.ts` |
| Judge weakens protection | Per-session policy copy only, immutable floor evaluated together | `apps/broker/src/policyStore.ts` |
| Forged or replayed approval | Approval bound to decision id and nonce, re-evaluated at approval time | `apps/broker/src/approvals.ts` |
| Credit drain | `spend()` before I/O, session ceiling, global cap, fail-closed rate card | `packages/ledger/src/spend.ts` |
| Fabricated verdicts | `recordDecision` accepts only engine-minted decisions, append-only triggers | `packages/ledger/src/decisions.ts` |
| Compromised broker rewrites ground truth | Verifier on another host with its own view-only key | `apps/verifier/src/reconcile.ts` |
| Exfiltration through `fetch` | Host allow-list in the floor, GET only, no redirects, 64 KiB cap | `policy/floor.yaml`, `apps/broker/src/egress.ts` |

The full table, including what is **not** defended against, is in [`SECURITY.md`](SECURITY.md).

## Verify in 60 seconds

```bash
# The live range reports its own evidence and the commands that regenerate it.
curl -s https://plumbline.108-61-70-169.sslip.io/api/proof | head -c 400

# The second-region verifier answers GREEN or RED about the live account.
curl -s https://plumbline.108-61-70-169.sslip.io/api/verify | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['status'], d['counts'])"
```

Check the ledger without trusting any page or server of ours. It is public, hash-chained, and the script has no dependencies:

```bash
curl -sO https://raw.githubusercontent.com/dmustapha/plumbline/main/scripts/verify-ledger.mjs
curl -s https://plumbline.108-61-70-169.sslip.io/api/ledger/public -o ledger.json
node verify-ledger.mjs ledger.json
# PASS 2608 decisions chained ... PASS every created resource is tied to the ALLOW decision that authorised it ... LEDGER OK
```

The same check runs in the browser on the [Ledger page](https://plumbline.108-61-70-169.sslip.io/audit/ledger) (it recomputes every fingerprint locally, compares the result with the head the second-region verifier pinned, and can flip one verdict in your copy to show the chain break). Every verdict on the Try it page links to its own row. The [Reconcile page](https://plumbline.108-61-70-169.sslip.io/audit/reconcile) also makes your browser ask the second-region verifier on its own address (`https://66-42-126-97.sslip.io/api/verify`), so the answer does not pass through our site. All six checks, and what each one does and does not prove, are on [Check it is real](https://plumbline.108-61-70-169.sslip.io/docs/check). A hash chain proves history was not edited after the fact; it does not prove the broker recorded every action truthfully, which is why the verifier in the second region reads the live Vultr account separately.

![Reconcile page: the visitor's browser asks the second-region verifier directly and gets GREEN with the prod-db instance it read](docs/images/verifier-direct.png)

![Ledger page verifying the whole chain in the browser](docs/images/ledger-verify.png)

After the clone and install below, the claims ledger re-derives every citable claim from the evidence files. The gate evidence was recorded at the range's first hostname (`108-61-70-169.sslip.io`). Both names are declared as one deployment in `evidence/declared-hosts.json`, so the ledger accepts either:

```bash
PLUMBLINE_URL=https://plumbline.108-61-70-169.sslip.io npm run verify-claims
# {"citable":["CL-L1","CL-L2","CL-L3","CL-L4","CL-L5","CL-L6","CL-L7","CL-GV"],"withheld":[],"tampered":[]}
```

The output above is the result when every gate evidence file is newer than the code it covers. If a commit touched a claim's code after its gate ran, the ledger lists that claim under `withheld` with the reason instead of citing it; this is intended.

## Honesty ledger

Each claim carries a verdict, the file that proves it, and the command that regenerates it. `npm run verify-claims` marks a row `CITABLE` only when the evidence is recomputed, recent, and recorded at a declared commit.

| Claim | Status | Evidence |
|---|---|---|
| Protected resources cannot be destroyed through the range; the live Vultr list is unchanged | VERIFIED, gate L1 pass | `evidence/gate-l1.json` |
| The verifier turns RED naming an out-of-band instance, then GREEN | VERIFIED, gate L2 pass, two runs | `evidence/gate-l2-run1.json`, `evidence/gate-l2-run2.json` |
| A dead broker lease makes VM 2 destroy workers and playgrounds only | VERIFIED, worker destroyed 58 s after the broker kill | `evidence/gate-l3.json` |
| A view-only tier key gets Vultr 403 on create | VERIFIED, gate L4 pass | `evidence/gate-l4.json` |
| Firewall group and VPC create and delete go through the engine | VERIFIED. Registry create is engine-gated and Vultr's free-tier limit blocks the second registry. | `evidence/gate-l5.json` |
| A deleted canary object is restored as a new version from S3 truth | VERIFIED, restore round trip 929 ms | `evidence/gate-l6.json` |
| After a bond slash the next provision is refused | VERIFIED, gate L7 pass | `evidence/gate-l7.json` |
| The sandbox runs under gVisor | VERIFIED, `GVISOR OK` from the probe on the VM | `evidence/probe-first-hour.txt` |
| The sandbox is a microVM or unescapable | NOT CLAIMED. The VM has no `/dev/kvm`. | `HONESTY-LEDGER.md` |
| The model resists attacks | NOT CLAIMED. The demo runs in disclosed compliant-operator mode. | `LIMITATIONS.md` |
| Spend shown equals Vultr's invoice | NOT CLAIMED. The meter is broker arithmetic from public hourly prices. | `HONESTY-LEDGER.md` |
| Reversal of a deleted VM | NOT BUILT. A Vultr snapshot took 609.9 s. Only Object Storage is reversible. | `LIMITATIONS.md` |
| Prevents create-then-delete between two verifier polls | NOT CLAIMED. The verifier is point-in-time. | `SECURITY.md` |

## Benchmarks

| Metric | Value | Evidence Artifact |
|---|---|---|
| Live attacks, each canned scene repeated 5 times | 30 of 30 ran to a recorded outcome | `evidence/stress/live-reliability-30.jsonl` |
| Dead-hand destroy time after the broker is killed | 58 s | `evidence/gate-l3.json` |
| Object restore round trip | 929 ms | `evidence/gate-l6.json` |
| Relay probes (absolute URI, CONNECT, traversal, request smuggling, direct egress, DNS) | 24 probes, all blocked | `evidence/stress/relay-probe.txt` |
| Independent S3 listing against the range's own Rewind panel | AGREE | `evidence/stress/s3-independent.txt` |
| Engine no-op ablation | 147 of 420 tests fail when the policy engine is stubbed | `tests/ablation/policy-engine_noop.log` |
| Pages checked at 5 widths in dark and light themes | 0 axe violations, 0 overflow | `evidence/stress/viewports.json`, `evidence/stress/viewports-light.json` |

## Tests

```bash
npm test          # 1189 tests across 82 files, offline, no credentials
npm run typecheck
```

| Suite | What it asserts |
|---|---|
| `packages/policy-engine/test` | Verdicts for every attack fixture. A property test finds no `ALLOW` outside the catalog in 8000 generated calls. |
| `tests/falsify/` | Seven headline claims, each fed a lie: protected destroy, policy signature, ledger tamper, rate card, approval forgery, tier enforcement, credential scrub. |
| `apps/range-api/test/stress-api.test.ts` | Hostile strings and numbers, malformed bodies, cross-session access, rate limits, concurrency, and a seeded fuzz of 920 requests. |
| `packages/operator/test/stress-agent.test.ts` | Agent failure modes: infinite loops, hallucinated tools, empty replies, cost blowup, prompt injection, context overflow. |
| `apps/range-api/test/stress-isolation.test.ts` | One session's config, spend and policy edits never reach another session. |
| `tests/ac-traceability.test.ts` | All 16 acceptance criteria map to a test or a live gate (`docs/AC-TRACEABILITY.md`). |

The live gates (`npm run gate -- l1` to `l7`) run against the deployed range and need the owner machine, so they are not part of `npm test`.

## Setup and verification

**Tier 0: offline, no credentials.**

```bash
git clone https://github.com/dmustapha/plumbline
cd plumbline
npm ci
npm test
npm run typecheck
```

> Every command above passes from a clean clone with no extra flags.

**Tier 1: re-derive the claims.**

```bash
PLUMBLINE_URL=https://plumbline.108-61-70-169.sslip.io npm run verify-claims
```

**Tier 2: the hosted range.** Open https://plumbline.108-61-70-169.sslip.io. No sign-up. Each visitor gets a session and a playground VPC. The range allows 3 attacks a minute per session and 4 live sessions per address.

**Deploy your own.** The units in `ops/systemd/` and the env templates in `ops/env/` describe the three processes on the broker VM and the verifier and watchdog on the second VM. `npm run bootstrap:range` (owner machine, idempotent) creates the two infra VMs, `plumbline-prod-db`, the shared registry, the versioned canary bucket and six IP-locked tier users, then writes the env files. `npm run teardown` lists everything and deletes only with `--yes`.

## Project structure

```
apps/
  range-api/     public Fastify app: serves the UI (public/) and the session, attack, policy and SSE routes. Holds no Vultr key.
  broker/        the only credential holder: pipeline, policy store, approvals, spend, lease, task tokens
  runner/        starts one hardened sandbox container per task
  verifier/      second-region reconciler (reconcile.ts), watchdog (watchdog.ts) and the keep-fresh timer
packages/
  policy-engine/ evaluate() returns ALLOW, ESCALATE or DENY with a rule id. Pure TypeScript, no I/O.
  vultr-adapter/ Vultr API client. Every mutating method needs an AllowDecision.
  ledger/        append-only decision store, spend() choke point, bond
  sandbox/       Docker and gVisor runner, relay container
  operator/      the LLM loop on Vultr Serverless Inference
  rewind/        Object Storage version restore
  attacks/       fixture loader
policy/          floor.yaml: the immutable production floor
attacks/         65 attack fixtures in 10 YAML groups
ops/             systemd units, env templates, gate, bootstrap and teardown scripts
evidence/        gate outputs, probes, stress results, the claims inputs
tests/           falsification, ablation, boundary lint, stress scripts
docs/            interfaces, domain guide, acceptance-criteria traceability, stress-test report
```

## Tech stack

| Layer | Technology |
|---|---|
| Language | TypeScript on Node 24 with `tsx`, no build step. About 9,400 lines of source and 82 test files. |
| Web | Fastify, server-sent events, static HTML with one script and per-page CSP hashes |
| Policy | YAML policy data, a pure evaluator, Ed25519-signed production changes |
| Storage | SQLite with append-only triggers for the decision ledger |
| Isolation | Docker with an internal network, gVisor (`runsc`), a path-restricted relay container |
| Models | Vultr Serverless Inference: `glm-5.3` (planner), `qwen3.8-27b` (executor), `nemotron-3.5-content-safety` (advisory) |
| Cloud | Vultr Cloud Compute, VPC, Firewall, Object Storage, Container Registry, Serverless Inference |

## Limitations

The full list is in [`LIMITATIONS.md`](LIMITATIONS.md) and [`HONESTY-LEDGER.md`](HONESTY-LEDGER.md). The ones that change what you see:

- The sandbox is a hardened Docker container under gVisor, not a microVM.
- Policy edits change your own sandbox copy. They never change production behavior.
- The verifier is point-in-time. It reports instances, VPCs and registries that exist at poll time and have no `ALLOW` row. Firewall groups, buckets and spend are not covered by the view-only key (see `not_covered` in `/api/verify`).
- The operator runs in disclosed compliant-operator mode, so the demo tests the engine, not the model's refusals.
- The account allows four active instances. A visitor worker can take the last slot, and the dollar scene then shows `max-instances` before the ceiling.

## Documentation

| Document | Contents |
|---|---|
| [`DECISIONS.md`](DECISIONS.md) | Architecture decision records |
| [`SECURITY.md`](SECURITY.md) | Threat table and what is not defended against |
| [`LIMITATIONS.md`](LIMITATIONS.md) | Scope boundary |
| [`HONESTY-LEDGER.md`](HONESTY-LEDGER.md) | What the product refuses to claim |
| [`CLAIMS.md`](CLAIMS.md) | Generated claims ledger |
| [`SUBMISSION_STATUS.md`](SUBMISSION_STATUS.md) | What works, what is gated, and why |
| [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md) | Tokens, type, motion and the plumb-bob signature |
| [`docs/STRESS-TEST.md`](docs/STRESS-TEST.md) | Stress-test results and open gaps |
| [`docs/INTERFACES.md`](docs/INTERFACES.md) | Component interfaces |

## License

MIT. See [`LICENSE`](LICENSE).
