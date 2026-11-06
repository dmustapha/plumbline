// File: packages/policy-engine/src/approval.ts
import { createPublicKey, verify } from 'node:crypto';
import { isGenuineDecision, mint } from './brand.ts';
import type { AllowDecision, EscalateDecision } from './types.ts';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export type SigStatus = 'OK' | 'SIG_REQUIRED' | 'SIG_INVALID';

export function publicKeyFromRawB64(rawB64: string) {
  const raw = Buffer.from(rawB64, 'base64');
  if (raw.length !== 32) throw new Error('ed25519 public key must be 32 raw bytes');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function verifyDetached(message: string, signatureB64: string | undefined, pubkeyRawB64: string): SigStatus {
  if (!signatureB64) return 'SIG_REQUIRED';
  try {
    const ok = verify(null, Buffer.from(message, 'utf8'), publicKeyFromRawB64(pubkeyRawB64), Buffer.from(signatureB64, 'base64'));
    return ok ? 'OK' : 'SIG_INVALID';
  } catch {
    return 'SIG_INVALID';
  }
}

export function approvalMessage(decisionId: string, nonce: string, requestHash: string): string {
  return `plumbline-approval:v1:${decisionId}:${nonce}:${requestHash}`;
}

export function policyMessage(policyText: string): string {
  return `plumbline-policy:v1:${policyText}`;
}

export function verifyApproval(decisionId: string, nonce: string, requestHash: string, sigB64: string | undefined, pubkeyRawB64: string): SigStatus {
  return verifyDetached(approvalMessage(decisionId, nonce, requestHash), sigB64, pubkeyRawB64);
}

export function verifyPolicySignature(policyText: string, sigB64: string | undefined, pubkeyRawB64: string): SigStatus {
  return verifyDetached(policyMessage(policyText), sigB64, pubkeyRawB64);
}

/** Single-use nonce ledger for approvals (AG4-ENG-1). In-memory; a persistent store only needs `consume`. */
export class NonceStore {
  readonly #used = new Set<string>();

  /** Returns true the first time a nonce is seen and false on every replay. */
  consume(nonce: string): boolean {
    if (this.#used.has(nonce)) return false;
    this.#used.add(nonce);
    return true;
  }

  has(nonce: string): boolean {
    return this.#used.has(nonce);
  }
}

export type ApprovalErrorCode =
  | 'NOT_AN_ENGINE_ESCALATION' | 'FLOOR_DENY_CANNOT_BE_APPROVED' | 'NONCE_INVALID'
  | 'SIG_REQUIRED' | 'SIG_INVALID' | 'NONCE_REPLAYED';

export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;
  constructor(code: ApprovalErrorCode) {
    super(code);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

export interface SignedApproval {
  nonce: string;
  signature?: string;
}

export interface ApprovalOptions {
  /** Raw 32-byte ed25519 owner public key, base64. */
  publicKey: string;
  nonceStore: NonceStore;
}

/**
 * The id an operator signs. It binds the approval to the escalation's request AND the rule that escalated it,
 * so an approval for last-copy-block cannot cover a different ESCALATE reason (AG4-BRK-5).
 * Signed message: approvalMessage(approvalDecisionId(esc), nonce, esc.request_hash).
 */
export function approvalDecisionId(esc: Pick<EscalateDecision, 'request_id' | 'rule_id'>): string {
  return `${esc.request_id}:${esc.rule_id}`;
}

/** Turns an ESCALATE into an ALLOW only with a valid owner signature over this escalation and an unused nonce. */
export function approveEscalation(escalation: EscalateDecision, approval: SignedApproval, opts: ApprovalOptions): AllowDecision {
  if (!isGenuineDecision(escalation) || escalation.decision !== 'ESCALATE') throw new ApprovalError('NOT_AN_ENGINE_ESCALATION');
  if (escalation.layers.some((l) => l.layer === 'floor' && l.effect === 'deny')) throw new ApprovalError('FLOOR_DENY_CANNOT_BE_APPROVED');
  const nonce = approval?.nonce;
  if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 128) throw new ApprovalError('NONCE_INVALID');
  const status = verifyApproval(approvalDecisionId(escalation), nonce, escalation.request_hash, approval.signature, opts.publicKey);
  if (status !== 'OK') throw new ApprovalError(status);
  if (!opts.nonceStore.consume(nonce)) throw new ApprovalError('NONCE_REPLAYED');
  return mint<AllowDecision>({ ...escalation, decision: 'ALLOW', layer: 'engine', reason: `approved escalation of ${escalation.rule_id}` } as Omit<AllowDecision, never>);
}
