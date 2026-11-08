# Plumbline: submission copy

Counts are computed in code (`build_copy.py`).

## Title (46 characters, limit 5 to 50)
Plumbline: safe agents on a live Vultr account

## Short description (253 characters, limit 50 to 255)
Give an AI agent real cloud power without the keys. For the platform and security leads who must approve it, Plumbline lets an agent act on a live Vultr account behind a coded policy engine, then a second region re-checks the account. Attack it yourself.

## Long description (1953 characters, limit 600 to 2000)
AI agents are starting to create and delete real cloud resources. The risk is simple: one poisoned web page or one blunt prompt can talk a model into deleting the production database, and asking the model to behave is not a control.

It is built for the people who have to say yes to an agent: the platform or FinOps lead deciding whether it may hold a cloud credential, the security or audit lead who must show it created nothing outside its authority, and the engineers building agents. The site gives them a checklist to run, and it installs on their own Vultr account.

Plumbline keeps the credentials away from the agent. The agent writes code that runs in a locked container (Docker under gVisor) with no credential and one route out. A broker holds every key. Before anything reaches Vultr, a coded policy engine answers ALLOW, ESCALATE or DENY and names the rule that decided. A dollar ceiling is checked first. An immutable production floor means no session can weaken protection on prod-db, and a visitor can edit their own sandbox copy of the rules and watch a verdict flip.

You do not have to take our word for the result. A verifier on a second machine in another region reads the live Vultr account (instances, VPCs and registries) with its own read-only key. If something exists that no ALLOW decision explains, it turns RED and names it. Every verdict goes into a public, hash-chained ledger that your browser can recompute, or you can run a small script against it.

It uses Cloud Compute (two VMs, in ewr and ord), Serverless Inference (a planner, an executor and a safety advisor), sub-user API keys with an IP allow-list, VPCs and firewall groups, Object Storage versioning, and the plans rate card.

The limits are stated on the site. The sandbox is a hardened container, not a microVM. Spend shown is broker arithmetic, not Vultr's invoice. In the demo the model obeys on purpose, so you are testing the policy engine. Only Object Storage deletes can be reversed.

## Tags
AI agents, agent safety, sandboxing, policy engine, containment, Vultr, Vultr Serverless Inference, cloud security, FinOps, TypeScript

## Vultr services used
- Cloud Compute (broker VM in ewr, verifier and watchdog VM in ord)
- Serverless Inference (three models: planner, executor, safety advisor)
- Sub-user API keys with ACL tiers and an IP allow-list
- VPCs and firewall groups
- Object Storage with versioning
- Plans rate card (prices a request before it runs)

## First comment (858 characters)
Hi everyone. If you are the platform or security lead who has to decide whether an AI agent can hold a cloud credential, Plumbline is built for you. It is a live range where you can try to make an agent break a real Vultr account. Click Attack prod-db on the site and you should see a DENY, the rule that decided it, and the account unchanged. Then edit a rule on your own sandbox copy and fire the same attack again to see the verdict flip. The part I care about most is that you can check the result without trusting our page: the Ledger page recomputes the whole hash chain in your browser, and the Reconcile page asks the verifier in the second region directly. We state what it does not claim, including that the sandbox is a container and not a microVM. If a check ever fails for you, I want to know. Live demo: https://plumbline.108-61-70-169.sslip.io

## Links
- Live demo: https://plumbline.108-61-70-169.sslip.io
- Repository: https://github.com/dmustapha/plumbline
- Check it yourself: https://plumbline.108-61-70-169.sslip.io/docs/check
