# Vultr tracks and services

Track: Blast Radius Zero (Vultr Agent Rush, lablab.build). Paths below were found by grep in the repo at the time of writing.

| Vultr service | Where it is used | Honest note |
|---|---|---|
| Cloud Compute | `packages/vultr-adapter/src/resources.ts` (`/instances`), `apps/verifier/src/vultr-lite.ts`, `apps/broker/src/reclaim.ts` | Two VMs: broker in ewr, verifier and watchdog in ord. The sandbox is a hardened Docker container under gVisor; the VM has no /dev/kvm, so it is not a microVM. |
| Serverless Inference, glm-5.3 (planner) | `packages/vultr-adapter/src/vsi.ts` line 7; fallback in `packages/operator/src/loop.ts` | Tool calling returned valid calls 20 of 20 in our probe (docs/ORGANIZER-FEEDBACK.md). |
| Serverless Inference, qwen3.8-27b (executor) | `packages/vultr-adapter/src/vsi.ts` line 8 | Sometimes answers in prose instead of a tool call, so the loop falls back to glm-5.3 on the second attempt. |
| Serverless Inference, nemotron-3.5-content-safety (safety advisor) | `packages/vultr-adapter/src/vsi.ts` line 9 | Advisory only. The coded policy engine decides, not the model. |
| VPC | `packages/vultr-adapter/src/resources.ts` (`/vpcs`) | Playgrounds are VPCs, capped at 4 per region because the account allows 5 per location. |
| Firewall groups | `packages/vultr-adapter/src/resources.ts`, `packages/vultr-adapter/src/tiers.ts` (`/firewalls`) | Create and delete go through the engine (gate L5). |
| Object Storage versioning | `packages/vultr-adapter/src/s3.ts` (`PutBucketVersioningCommand`), `packages/rewind` | The only reversible class. Restore round trip 929 ms in the committed gate L6 evidence. VM deletion is not reversible. |
| API sub-user keys with IP allow-list | `packages/vultr-adapter/src/users.ts` (`createServiceUser`, `ipAllow`), `packages/vultr-adapter/src/tiers.ts` | Vultr has no per-resource ACL scoping; the engine is the fine-grained control and the key tier is defense in depth. |
| Plans rate card | `packages/vultr-adapter/src/plans.ts` (`GET /plans`) | Prices a request before it runs. Spend shown is broker arithmetic, not Vultr's invoice. |
