# Organizer Feedback: Plumbline on Vultr

_Built during Vultr Agent Rush (Blast Radius Zero). Field notes from shipping on your stack and on lablab, sent to make both easier for the next agent builder._

## What Worked Well
- Tool calling on Serverless Inference was solid: glm-5.3 and qwen3.8-27b returned valid tool calls 20 of 20, with a usage block on every response (first-hour probe).
- Provisioning speed made a live demo possible: create 4.6 s, usable about 21 s, destroy 2.3 s, destroy visible within 0.8 s.
- Sub-user ACL tiers behaved as documented: view-only could list but not create, and service users needed no invitation.
- Object Storage versioning restored a deleted object in 0.29 s, and firewall, VPC and registry round trips took 1 to 1.5 s.
- The inference endpoint took 60 calls at 10-way concurrency with no 429 (p50 1.08 s), and the documented 30 requests per second API limit matched reality (evidence/probes/INDEX.md).
- The unauthenticated /v1/models list was the one reliable source of truth for models, and gVisor ran cleanly on a stock Debian 12 instance (evidence/probes/INDEX.md, U-1).
- The organizer idea lists and the evidence checklist (blocked access, caps, containment moment) made the target clear on day one.

## Friction & Suggestions

_Ordered by cost-to-discover within each category. Costs are taken from artifact timestamps and measured runs; where an item was never timed, it says so rather than guessing._

### SDK / API

#### IP allow-list blocks changing IPs, owner key included
**What we hit:** Service-user keys answer 401 'Unauthorized IP address' until an IP is added; the owner key did the same once our home IP rotated. It hit three times: the SSH key upload while setting up the first VM, a gate re-run, and the rogue-server demo scene (the home IP changed between the first and last hit).
**Cost to discover:** Recurred on 3 occasions across Nov 6 and Nov 8; each time cleared only by the account owner editing Account, API, Access Control in the console. Never timed per occurrence, so no hour figure is claimed.
**Delta:** a fresh key on an empty allow-list fails every call (GET and POST alike); the 401 body names only the caller IP, not the list or how to extend it.
**Impact:** First VM setup stalled, a dead-hand gate (L3) re-run was delayed, and the rogue-server scene of the demo could not run until the IP was re-added.
**Evidence:** measured on a live account during the build (first-hour probe and later gate runs)
**Suggestion:** Accept a CIDR or a temporary entry with an expiry, and return the current allow-list size and a console link in the 401 body so a builder on a changing IP can self-serve.
_Severity: BLOCKER_

#### No per-resource scoping or destroy-only tier
**What we hit:** Service-user ACLs are real and enforced (view-only could list but not create), but the only delete-capable tier is `provisioning`, which can also create and can delete any instance on the account, including the protected one.
**Cost to discover:** Found by probe in the first hour; the design cost ran through the whole build (the watchdog needed its own `provisioning` key because no destroy-only tier exists).
**Delta:** docs describe ACL strings; there is no tag, label or id scope on an ACL, so `provisioning` = create + delete everywhere.
**Impact:** This is why Plumbline exists: we built a broker and policy engine to do what a scoped key could, and the verifier key had to stay view-only.
**Evidence:** HONESTY-LEDGER.md, LIMITATIONS.md
**Suggestion:** Let an ACL or key carry a tag or label scope, for example 'delete only resources tagged X', or split a destroy-only ACL out of `provisioning`.
_Severity: FRICTION_

#### No exact read-only billing view
**What we hit:** A key with only `subscriptions_view` is refused on /account, /billing/pending-charges, firewalls and object storage. Adding `billing` makes pending-charges readable (probe U-6).
**Cost to discover:** Small: found in the first-hour probe and again when the verifier could not read its own ACL list.
**Delta:** the spend number is rounded to cents per resource-hour line, so it cannot cross-check hourly arithmetic on cheap resources.
**Impact:** The spend meter on the site is broker arithmetic from the public rate card, not Vultr's number, and the site says so. The verifier proves its key shape by status codes.
**Evidence:** evidence/probes/INDEX.md, HONESTY-LEDGER.md
**Suggestion:** A read-only billing scope with exact pending charges (sub-cent), and GET on the caller's own key ACLs.
_Severity: POLISH_

#### DELETE on an allow-list entry returns 404
**What we hit:** We could add an allow-list entry and list it, but could not remove it by either path form.
**Cost to discover:** One probe (U-11 FAILED), then a design change.
**Delta:** docs-style path accepted for create and list, 404 on delete of an existing entry.
**Impact:** Key rotation became 'recreate the service user' (deleting a user returned 204 and revokes its keys), which is heavier than needed.
**Evidence:** evidence/probes/INDEX.md
**Suggestion:** Confirm the intended delete path (or fix it), and document it next to the create call.
_Severity: FRICTION_

#### Reasoning models can spend max_tokens before a tool call
**What we hit:** With a small max_tokens, the reasoning share consumed the budget and the response ended without a call.
**Cost to discover:** Caught by our stress run, fixed the same day.
**Delta:** no per-model note on how much of max_tokens reasoning consumes.
**Impact:** We raised budgets and added a truncation-aware retry; live reliability reached 30 of 30.
**Evidence:** measured on a live account during the build (first-hour probe and later gate runs)
**Suggestion:** List a recommended minimum max_tokens for reasoning models in the model table.
_Severity: POLISH_

### Documentation

#### Inference docs omit key creation, rate limits and model names
**What we hit:** Which models support tool calls, and the request limit, were unknown until we hit the API. The unauthenticated /v1/models list (35 models, 13 with text output) was the most reliable source.
**Cost to discover:** About one first-hour probe session (20 calls per model for tool calling, 60 calls at 10-way concurrency for rate).
**Delta:** the tutorial says the key is the subscription key under Products, Serverless, Inference (not the account token); the provisioning page does not.
**Impact:** We spent first-hour budget on probing instead of building; result was good (glm-5.3 20 of 20, qwen3.8-27b 20 of 20, 60 of 60 calls at 10-way concurrency returned 200).
**Evidence:** evidence/probes/INDEX.md
**Suggestion:** Add key creation steps, a per-model capability table (tools, vision, context) and the request limit to the provisioning page.
_Severity: FRICTION_

#### Deadline and time window disagree across pages
**What we hit:** A builder cannot tell the hard deadline from the lablab page. We planned against the earlier time and kept an internal cutoff 7 hours before the later one.
**Cost to discover:** Cheap to find, expensive to carry: it shaped the whole schedule.
**Delta:** lablab.ai event page: no deadline, schedule 'TBA'; community notes: 22:00 UTC; schedule line: 'End of Submissions 12:00 AM WAT Nov 9' = 23:00 UTC; dashboard versus agenda differ by 1 hour.
**Impact:** On the final day we worked to 23:00 UTC while an earlier note still said 22:00; the open question went to Discord and stayed unanswered.
**Evidence:** read on the public lablab and Vultr pages on 2026-11-05
**Suggestion:** State one deadline with a timezone-explicit timestamp on the lablab event page, and link the same value from the Vultr community page.
_Severity: FRICTION_

#### lablab.ai 308-redirects every path to lablab.build
**What we hit:** Published links and tools that do not follow a cross-host redirect fail on lablab.ai, including the credit redeem link and event page we were given.
**Cost to discover:** Minutes.
**Delta:** every lablab.ai path answers 308 with a lablab.build target.
**Impact:** Our submission links had to be re-pointed to lablab.build and re-verified.
**Evidence:** read on the public lablab and Vultr pages on 2026-11-05
**Suggestion:** Update the links in the Vultr community page and kickoff materials to the lablab.build host, or say which host is canonical.
_Severity: POLISH_

#### Tutorial names a model that is not in the live catalog
**What we hit:** The lablab VSI tutorial recommends kimi-k2-instruct; the unauthenticated /v1/models list on 2026-11-05 did not contain it, nor DeepSeek V3.2 from the third-party listing.
**Cost to discover:** Minutes, but it made the 'tool-calling model' risk real until probed.
**Delta:** tutorial model: kimi-k2-instruct; live catalog: 35 models, none by that name.
**Impact:** Our plan carried 'tool-calling model unverified' until the first-hour probe.
**Evidence:** read on the public lablab and Vultr pages on 2026-11-05
**Suggestion:** Point the tutorial at a model that is in the catalog, or generate its model list from /v1/models.
_Severity: POLISH_

#### Sandboxing guide has an empty troubleshooting section
**What we hit:** The Microsandbox guide ends with a 'Permission denied (os error 13)' troubleshooting heading and no content, on the path the docs recommend for isolation.
**Cost to discover:** Not hit: we read it in intel and chose gVisor instead, so we cannot time it.
**Delta:** heading present, body empty.
**Impact:** We priced Microsandbox at 1 to 3 hours with this risk and did not take it.
**Evidence:** read on the public lablab and Vultr pages on 2026-11-05
**Suggestion:** Fill the section with the cause (KVM or permissions) and the fix, or remove the heading.
_Severity: POLISH_

#### Prize and criteria details conflict between pages
**What we hit:** 1st place is $3,000 credits on the Vultr event page and $1,000 on the earlier Milan edition page; the Vultr page lists 2 of lablab's 4 judging criteria.
**Cost to discover:** Minutes; but it affects what to optimize.
**Delta:** credits $3,000 vs $1,000; criteria 2 vs 4.
**Impact:** We scored ourselves against all four lablab criteria and treated the split as unconfirmed.
**Evidence:** read on the public lablab and Vultr pages on 2026-11-05
**Suggestion:** One page of record for prizes and criteria, with the edition named.
_Severity: POLISH_

### Infrastructure

#### 409 lock after create and 502 on creates that succeed
**What we hit:** Destroying or touching a just-created instance returns 409 until install finishes (about 20 s). We also saw creates that errored but left a server behind, which then looks like an unexplained resource.
**Cost to discover:** The 409 is measured (create 4.6 s, usable 20.8 s); the gate helper retries up to 14 times at 8 s. The 502 case was seen rarely, so its cost is a debugging session plus a leftover server, not a number.
**Delta:** a 5xx on POST /instances gives no signal that the resource now exists, so a retry can create a second server.
**Impact:** We added a retry on 409 in the gates and a reclaim sweep in the broker that deletes an unrecorded worker only after two consecutive sightings, and our debug review recorded a permanent false-RED risk from a 502 create.
**Evidence:** ops/scripts/gates.ts, debug-results/phase-5-agent-verifier-critique.md, HONESTY-LEDGER.md
**Suggestion:** Accept an idempotency key on create, or return the new instance id on a 5xx so a client can reconcile.
_Severity: FRICTION_

#### Account limits were learned by hitting them
**What we hit:** The registry free tier allows one registry per account, VPCs cap at 5 per location, active instances at roughly 4, and the API at 30 requests per second (429 confirmed at about 33 per second). None of the first three is returned by an API call we found; the console shows some caps under Accounts, Limits.
**Cost to discover:** Two demo-prep gate failures (18:31Z and 18:34Z) were this limit: new sessions got no playground until the earlier ones idled out (10 min). Elsewhere not timed.
**Delta:** we found no endpoint or doc page that lists per-account limits with their current usage.
**Impact:** We capped playgrounds at 4 per region, set the broker to 1 worker instance, could not claim a live registry create and delete cycle, and wrote the limits into the honesty ledger. A support ticket for a higher instance limit was still open at the end.
**Evidence:** HONESTY-LEDGER.md, DEBUG-REPORT.md
**Suggestion:** Expose limits and current usage in one API call (or one docs table), and name the limit in the refusal body.
_Severity: FRICTION_

#### vultr.com pricing and API pages refuse automated fetch
**What we hit:** Automated fetches of vultr.com/pricing and vultr.com/api returned HTTP 403, so rate cards and limits could not be machine-checked.
**Cost to discover:** Minutes; we used the authenticated API (GET /plans, /registry/plan/list) instead.
**Delta:** 403 on documentation and pricing pages for non-browser clients.
**Impact:** The public rate card the spend meter relies on had to be read from the API, not the page.
**Evidence:** read on the public lablab and Vultr pages on 2026-11-05
**Suggestion:** Allow a documented read-only fetch of pricing and docs pages, or publish pricing as JSON.
_Severity: POLISH_

#### Snapshots take about 10 minutes and carry no instance id; Legacy $6 tier lists no locations
**What we hit:** A live 'undo VM deletion' beat was not possible, and picking the cheapest object storage tier needed trial.
**Cost to discover:** One probe each.
**Delta:** docs-style expectation of up to 30 minutes for a snapshot is confirmed; there is no field linking snapshot to instance.
**Impact:** We cut VM undo from scope; the only reversible class we claim is Object Storage versioning (restore 0.29 s).
**Evidence:** LIMITATIONS.md, HONESTY-LEDGER.md
**Suggestion:** Return the source instance id on a snapshot, and flag which object storage tiers are deployable where.
_Severity: POLISH_

### Developer Experience

#### Event credit code was not on the page
**What we hit:** Credits needed an email never used on Vultr, a card at signup was possible, and the code was shared in the kickoff, so builders who joined later had to find it.
**Cost to discover:** Not hit: our credit of $200 applied, so this is a seed we confirmed from the event page, not a failure of ours.
**Delta:** page says credits exist; the code arrives separately.
**Impact:** Signup ordering was a day-one risk in our plan until the account existed.
**Evidence:** read on the public lablab and Vultr pages on 2026-11-05
**Suggestion:** Show the redeem link and the new-email rule on the event page, and answer the open question about existing Vultr customers.
_Severity: POLISH_

#### Submission form is only visible after enrollment
**What we hit:** The pre-registration material gave title 5 to 50, short description 50 to 255, long description 600 to 2000 characters, video under 5 minutes and 300 MB with one containment moment. The live form was login-gated, so we could not confirm the exact fields (for example category or tag limits) until late; we found no stated limit on categories or tags in the material we had.
**Cost to discover:** Registration and the screening form had to precede any look at the real form; approval email stayed unconfirmed in our notes.
**Delta:** guideline page and event form can differ, and the page says the form wins.
**Impact:** Copy was written to the guideline limits (short description ended at 253 of 255), then re-checked against the form at the end.
**Evidence:** read on the public lablab and Vultr pages on 2026-11-05
**Suggestion:** Publish the exact form fields and limits (including tag or category counts) before registration closes, or a preview of the form.
_Severity: FRICTION_

#### Small API inconsistencies found by probing
**What we hit:** Each was a one-call surprise rather than a wall.
**Cost to discover:** A few minutes each, found in the first-hour probe.
**Delta:** the error bodies do not say which rule was broken (name pattern, path) or which timezone date_created uses.
**Impact:** We avoid parsing date_created for TTL logic and validate registry names client side.
**Evidence:** HONESTY-LEDGER.md
**Suggestion:** Return the violated rule in the 422 body and document the date_created timezone.
_Severity: POLISH_

### Sponsor Integration

#### MicroVM isolation depends on KVM that is not documented
**What we hit:** The Microsandbox guide and Vultr's agent winners point to microVMs, but we could not tell from docs which plans expose /dev/kvm.
**Cost to discover:** One first-hour probe plus one on the real VM; VX1 stayed unknown.
**Delta:** guide prerequisites assume KVM; plan docs do not say.
**Impact:** Our isolation tier is a hardened container under gVisor, and we say it is not a microVM and not 'unescapable'.
**Evidence:** evidence/probes/INDEX.md, HONESTY-LEDGER.md
**Suggestion:** Add a column to the plan docs: nested virtualization or /dev/kvm yes or no.
_Severity: FRICTION_

## Contributions

Fixes and findings offered back for the frictions we worked around:

- **Orphaned creates (502 or error that left a server):** reclaim sweep in the broker that deletes an unrecorded worker only after two consecutive sightings, so a create still being recorded is never raced. Where: apps/broker/src/reclaim.ts and apps/broker/test/orphan-sweep.test.ts in github.com/dmustapha/plumbline.
- **409 'Server is currently locked' right after create:** retry loop: up to 14 tries at 8 s, only for 409 or 'locked', so a gate never leaves its test instance behind. Where: ops/scripts/gates.ts (lines 81 to 85); apps/broker for the production path.
- **Out-of-band resource for a verifier demo:** a create and destroy script that uses the owner key to make one labelled server, bypassing the broker, so a second-region verifier has something to find (not a retry helper). Where: ops/demo/rogue.sh.
- **Limits learned by hitting them:** a measured table of the real limits on a live account (instances, VPCs, registry, 429 rate, 409 lock, snapshot time) with evidence ids, free to copy into docs. Where: HONESTY-LEDGER.md and evidence/probes/INDEX.md.
- **No per-resource scoping:** a policy engine, hash-chained ledger and second-region verifier as an open reference for safe agent access with the ACL tiers Vultr has today. Where: github.com/dmustapha/plumbline (packages/policy-engine, scripts/verify-ledger.mjs).

## At a Glance

| Category | BLOCKER | FRICTION | POLISH |
|---|---|---|---|
| SDK / API | 1 | 2 | 2 |
| Documentation | 0 | 2 | 4 |
| Infrastructure | 0 | 2 | 2 |
| Developer Experience | 0 | 1 | 2 |
| Sponsor Integration | 0 | 1 | 0 |

## Shareable Summary
Vultr was quick and reliable to build on: tool calling worked 20 of 20, and create and destroy times made a live demo possible. The costliest thing was the API key IP allow-list, which blocked the owner key itself whenever our home IP rotated and has no self-serve fix. Next were no per-resource scoping on sub-user keys, 409 and 502 responses around provisioning that can leave orphans, and account limits we only found by hitting them. On the lablab side, one deadline stated in one place, and the form fields visible before enrollment, would have saved planning time. An idempotency key on create and tag-scoped ACLs would fix most of the platform pain.
