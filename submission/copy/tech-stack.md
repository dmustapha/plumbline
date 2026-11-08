# Tech stack

Tags: AI agents, agent safety, sandboxing, policy engine, containment, Vultr, Vultr Serverless Inference, cloud security, FinOps, TypeScript

## Vultr services used
- Cloud Compute (broker VM in ewr, verifier and watchdog VM in ord)
- Serverless Inference (three models: planner, executor, safety advisor)
- Sub-user API keys with ACL tiers and an IP allow-list
- VPCs and firewall groups
- Object Storage with versioning
- Plans rate card (prices a request before it runs)

Tags selected on the lablab form (as shown on the public page): VULTR, Qwen3, NVIDIA, rest api. Category tags: Security, Cloud Application, Developer Tools.

Language: TypeScript on Node 24 with tsx, no build step (README Tech stack section).
