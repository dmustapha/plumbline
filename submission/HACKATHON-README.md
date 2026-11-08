# Plumbline

## Problem
AI agents are starting to create and delete real cloud resources. One poisoned web page or one blunt prompt can talk a model into deleting the production database, and asking the model to behave is not a control. The people who must approve an agent (platform, FinOps, security and audit leads) have nothing they can check for themselves.

## What We Built
Plumbline is a live range on a real Vultr account. The agent writes code that runs in a locked container (Docker under gVisor) with no credential and one route out. A broker holds every key. Before anything reaches Vultr, a coded policy engine answers ALLOW, ESCALATE or DENY and names the rule that decided. A dollar ceiling is checked first, and an immutable production floor means no session can weaken protection on prod-db.

## Our Integration
Cloud Compute (two VMs, ewr and ord), Serverless Inference (glm-5.3 planner, qwen3.8-27b executor, nemotron-3.5-content-safety advisor), sub-user API keys with an IP allow-list, VPCs and firewall groups, Object Storage versioning, and the plans rate card. File-level mapping is in [sponsor-tracks.md](sponsor-tracks.md).

## What Makes This Different
You do not have to take our word for the result. A verifier on a second machine in another region reads the live Vultr account with its own read-only key. If something exists that no ALLOW decision explains, it turns RED and names it. Every verdict goes into a public, hash-chained ledger that your browser can recompute. The limits are stated: the sandbox is a container, not a microVM, and spend shown is broker arithmetic. See [HONESTY-LEDGER.md](HONESTY-LEDGER.md).

## Try It
1. Open https://plumbline.108-61-70-169.sslip.io and click Attack prod-db. Expect a DENY, the rule that decided, and the account unchanged.
2. Edit a rule on your own sandbox copy and fire the same attack again to see the verdict flip.
3. Open the Ledger page to recompute the hash chain in your browser, and the Reconcile page to ask the second-region verifier directly.
4. Run the commands in Verify in 60s below.

## Verify in 60s
```bash
# The live range reports its own evidence and the commands that regenerate it.
curl -s https://plumbline.108-61-70-169.sslip.io/api/proof | head -c 400

# The second-region verifier answers GREEN or RED about the live account.
curl -s https://plumbline.108-61-70-169.sslip.io/api/verify | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['status'], d['counts'])"
```

Ledger check with no dependencies:

```bash
curl -sO https://raw.githubusercontent.com/dmustapha/plumbline/main/scripts/verify-ledger.mjs
curl -s https://plumbline.108-61-70-169.sslip.io/api/ledger/public -o ledger.json
node verify-ledger.mjs ledger.json
```

Claims ledger, from a fresh clone (re-derives each citable claim from the committed evidence files and lists any it must withhold):

```bash
git clone https://github.com/dmustapha/plumbline && cd plumbline && npm ci
PLUMBLINE_URL=https://plumbline.108-61-70-169.sslip.io npm run verify-claims
```

Deep technical sections (architecture, security, benchmarks, setup) are in the [repo README](https://github.com/dmustapha/plumbline#readme).
