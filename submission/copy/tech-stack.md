# Tech stack

Tags: AI agents, agent safety, sandboxing, policy engine, containment, Vultr, Vultr Serverless Inference, cloud security, FinOps, TypeScript

## Vultr services used
- Cloud Compute (broker VM in ewr, verifier and watchdog VM in ord)
- Serverless Inference (three models: planner, executor, safety advisor)
- Sub-user API keys with ACL tiers and an IP allow-list
- VPCs and firewall groups
- Object Storage with versioning
- Plans rate card (prices a request before it runs)

Language: TypeScript on Node 24 with tsx, no build step (README Tech stack section).
