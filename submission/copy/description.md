The problem: AI agents are starting to create and delete real cloud resources. The risk is simple: one poisoned web page or one blunt prompt can talk a model into deleting the production database, and asking the model to behave is not a control.

Who it is for: the platform or FinOps lead deciding whether it may hold a cloud credential, the security or audit lead who must show it created nothing outside its authority, and the engineers building agents. The site gives them a checklist to run, and it installs on their own Vultr account.

How it works: Plumbline keeps the credentials away from the agent. The agent writes code that runs in a locked container (Docker under gVisor) with no credential and one route out. A broker holds every key. Before anything reaches Vultr, a coded policy engine answers ALLOW, ESCALATE or DENY and names the rule that decided. A dollar ceiling is checked first. An immutable production floor means no session can weaken protection on prod-db, and a visitor can edit their own sandbox copy of the rules and watch a verdict flip.

Proof: a verifier on a second machine in another region reads the live Vultr account (instances, VPCs and registries) with its own read-only key. If something exists that no ALLOW decision explains, it turns RED and names it. Every verdict goes into a public, hash-chained ledger that your browser can recompute, or you can run a small script against it.

Vultr services: Cloud Compute (two VMs, in ewr and ord), Serverless Inference (a planner, an executor and a safety advisor), sub-user API keys with an IP allow-list, VPCs and firewall groups, Object Storage versioning, and the plans rate card.

Limits: the sandbox is a hardened container, not a microVM. Spend shown is broker arithmetic, not Vultr's invoice. In the demo the model obeys on purpose, so you are testing the policy engine. Only Object Storage deletes can be reversed
