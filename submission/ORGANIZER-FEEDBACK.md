# Organizer Feedback: Plumbline on Vultr

Field notes from building a broker and verifier on a live Vultr account during Agent Rush. Sent to make the platform easier for the next agent builder.

## What Worked Well
- Tool calling on Serverless Inference was solid: glm-5.3 and qwen3.8-27b both returned valid tool calls 20 of 20 times, with a usage block on every response.
- Provisioning speed made a live demo possible: create 4.6 s, active about 21 s, destroy 2.3 s.
- Sub-user keys with ACL tiers behaved exactly as documented (view-only could list, not create).
- Object Storage versioning restored a deleted object in 0.29 s.

## Friction & Suggestions

### Infrastructure
**What we hit:** an instance that is still provisioning returns 409 on destroy for about 20 s, and some create calls return 502 even though the server was created.
**Cost to discover:** about 1 h, plus a leftover server we had to find and delete by hand.
**Delta:** the 502 gives no hint that the resource exists, so a retry creates a second one.
**Impact:** we added a retry loop and a sweep that reclaims orphans.
**Evidence:** PULSE.md Real Vultr limits (HONESTY-LEDGER); ops/demo/rogue.sh
**Suggestion:** accept an idempotency key on create, or return the new id on 5xx.
_Severity: FRICTION_

### SDK / API
**What we hit:** the API key IP allow-list is deny by default for service users and also applies to the owner key. Our home IP changes, so calls failed with "Unauthorized IP address" at the worst moments (SSH key upload, gates, the final video scene).
**Cost to discover:** repeated, about 15 min each time.
**Impact:** blocked the VM1 setup, two test gates and one demo scene until the IP was re-added by hand.
**Evidence:** PULSE.md H-5 and the livetest blocker line
**Suggestion:** allow a CIDR or a temporary entry with an expiry, and name the allowed list in the 401.
_Severity: FRICTION_

**What we hit:** sub-user ACLs have no per-resource scoping. A key that can delete instances can delete any instance, including the protected one.
**Impact:** this is the reason Plumbline exists. We built a broker and policy engine to do what a scoped key could.
**Evidence:** PULSE.md Sub-user findings (no per-resource scoping)
**Suggestion:** tag or label scoped ACLs, for example "delete only resources with tag X".
_Severity: FRICTION_

**What we hit:** view-only keys get 403 on /account, and pending_charges rounds to cents with a 1 hour minimum.
**Impact:** the spend meter is broker arithmetic from the public rate card, not Vultr's number, and we say so on the site.
**Evidence:** PULSE.md Probe findings
**Suggestion:** a read-only billing scope that returns exact pending charges.
_Severity: POLISH_

### Documentation
**What we hit:** limits were learned by hitting them: one free registry per account, 5 VPCs per location, about 4 active instances, 30 requests per second, POST /users needing a password, VPC create needing v4_subnet_mask.
**Cost to discover:** about 2 h across the build. This may partly be our reading of the docs.
**Evidence:** PULSE.md Real Vultr limits
**Suggestion:** one page or endpoint listing account limits and required fields per resource.
_Severity: FRICTION_

## Contributions
- Retry-on-409 destroy helper and a reclaim sweep for orphaned resources: ops/demo/rogue.sh and the broker sweep in github.com/dmustapha/plumbline.
- A table of the real limits above, measured on a live account (HONESTY-LEDGER in the repo), free to copy into your docs.
- The policy engine, hash-chained ledger and second-region verifier are open source if you want a reference for safe agent access.

## At a Glance
| Category | BLOCKER | FRICTION | POLISH |
|---|---|---|---|
| SDK / API | 0 | 2 | 1 |
| Documentation | 0 | 1 | 0 |
| Infrastructure | 0 | 1 | 0 |
| Developer Experience | 0 | 0 | 0 |
| Sponsor Integration | 0 | 0 | 0 |

## Shareable Summary
Vultr was quick and reliable to build on: tool calling worked 20 of 20, and create and destroy times made a live demo possible. Three things cost us time. Key IP allow-lists that block on changing IPs, no per-resource scoping on sub-user keys, and 409 or 502 responses during provisioning that leave orphans. An idempotency key on create and tag-scoped ACLs would fix most of it.
