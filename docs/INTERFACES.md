# Frozen interfaces (tag g0-frozen)

Authoritative short form. ARCHITECTURE.md is long background.

## packages/policy-engine/src/index.ts
```ts
// File: packages/policy-engine/src/index.ts
export * from './types.ts';
export { VERB_CLASS, RULE_IDS, isKnownCall, tierFor, isAllowedRuleId } from './catalog.ts';
export { evaluate, assertAllow, isGenuineAllow, isGenuineDecision } from './evaluate.ts';
export { deriveFacts, projectCost, ttlIsValid, RATE_CARD_MAX_AGE_MS } from './facts.ts';
export type { Facts } from './facts.ts';
export { parsePolicy, validatePolicy, diffRules, hashRules } from './loader.ts';
export type { LoadResult, PolicyError } from './loader.ts';
export { requestHash, canonicalJson, toLedgerRequestFields } from './hash.ts';
export { PLAYGROUND_LABEL_RE, PLAYGROUND_LABEL_PREFIX } from './catalog.ts';
export { approveEscalation, approvalDecisionId, NonceStore, ApprovalError, verifyApproval, verifyPolicySignature, verifyDetached, approvalMessage, policyMessage, publicKeyFromRawB64 } from './approval.ts';
export type { SigStatus, SignedApproval, ApprovalOptions, ApprovalErrorCode } from './approval.ts';
```
## packages/ledger/src/index.ts
```ts
// File: packages/ledger/src/index.ts
export { openDb } from './db.ts';
export type { Db } from './db.ts';
export { Ledger } from './spend.ts';
export type { SpendGate, SpendKind, SpendContext, SpendResult, Receipt, DisplaySpend, LedgerLimits } from './spend.ts';
export { recordDecision, recordEvent, listDecisions, getDecision, proofCounts } from './decisions.ts';
export { exportLedger, verifyExport, recordUnknownOutcome, resolveUnknownOutcome, listUnknownOutcomes, GENESIS_HASH } from './export.ts';
export type { LedgerExport, ExportDecision, ExportResource, ExportUnknown, ExportVerdict, VerifyOptions, UnknownOutcome } from './export.ts';
export type { DecisionMeta, DecisionRow, ProofCounts } from './decisions.ts';
export { Bond } from './bond.ts';
```
## packages/vultr-adapter/src/index.ts
```ts
// File: packages/vultr-adapter/src/index.ts
export { VultrHttp, VultrError, SpendRefused, OutcomeUnknown, redact, VULTR_BASE, SHARED_MAX_RPS, resetSharedLimiter } from './http.ts';
export { mintOwnerAction } from './owner-action.ts';
export type { OwnerAction, OwnerActionRecord, OwnerOp } from './owner-action.ts';
export type { HttpOptions, CallOptions } from './http.ts';
export { Instances, Firewalls, Vpcs, Registries, DEBIAN_12_OS_ID } from './resources.ts';
export type { Ctx, InstanceView, FirewallView, VpcView, RegistryView } from './resources.ts';
export { OwnerAdmin, TIER_ACL } from './users.ts';
export type { IssuedKey } from './users.ts';
export { fetchRateCard, RateCardCache } from './plans.ts';
export { S3Store } from './s3.ts';
export type { S3Sender } from './s3.ts';
export type { S3Config, VersionInfo, VersionListing } from './s3.ts';
export { VsiClient, VSI_MODELS, VSI_BASE, priceUsd } from './vsi.ts';
export type { ChatMessage, ChatRequest, ChatResult } from './vsi.ts';
export { TierKeys, TierUnavailable } from './tiers.ts';
export type { TierKeyConfig, SelfTestResult } from './tiers.ts';
```
## Broker routes
'/healthz'
'/v1/acl-self-test'
'/v1/admin/'
'/v1/admin/kill-switch/clear'
'/v1/admin/kill-switch/engage'
'/v1/approval/:id'
'/v1/approvals'
'/v1/bond'
'/v1/call'
'/v1/decisions'
'/v1/egress-counter'
'/v1/ledger/export'
'/v1/live-list'
'/v1/llm'
'/v1/policy-production'
'/v1/policy/:sid'
'/v1/proof'
'/v1/rewind'
'/v1/rewind/act'
'/v1/session'
'/v1/session/:sid/tier'
'/v1/spend/:sid'
'/v1/status'
'/v1/task'

See apps/broker/docs/INTERFACES-BROKER.md and ledger-export.schema.md.
