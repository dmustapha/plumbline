// File: packages/policy-engine/src/approval.ts
import { createPublicKey, verify } from 'node:crypto';

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
