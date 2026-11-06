// File: packages/policy-engine/src/index.ts
export * from './types.ts';
export { VERB_CLASS, RULE_IDS, isKnownCall, tierFor, isAllowedRuleId } from './catalog.ts';
export { evaluate, approveEscalation, assertAllow, isGenuineAllow, isGenuineDecision } from './evaluate.ts';
export { deriveFacts, projectCost, RATE_CARD_MAX_AGE_MS } from './facts.ts';
export type { Facts } from './facts.ts';
export { parsePolicy, validatePolicy, diffRules, hashRules } from './loader.ts';
export type { LoadResult, PolicyError } from './loader.ts';
export { verifyApproval, verifyPolicySignature, verifyDetached, approvalMessage, policyMessage, publicKeyFromRawB64 } from './approval.ts';
export type { SigStatus } from './approval.ts';
