// File: packages/policy-engine/test/approval.test.ts
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { approvalMessage, policyMessage, verifyApproval, verifyPolicySignature } from '../src/index.ts';

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64');
  return { raw, privateKey };
}

describe('detached ed25519 approvals', () => {
  it('SIG_REQUIRED when the signature is missing', () => {
    expect(verifyPolicySignature('p', undefined, keys().raw)).toBe('SIG_REQUIRED');
  });
  it('OK for a valid signature, SIG_INVALID for another key or tampered text', () => {
    const k = keys();
    const sig = sign(null, Buffer.from(policyMessage('version: 1')), k.privateKey).toString('base64');
    expect(verifyPolicySignature('version: 1', sig, k.raw)).toBe('OK');
    expect(verifyPolicySignature('version: 2', sig, k.raw)).toBe('SIG_INVALID');
    expect(verifyPolicySignature('version: 1', sig, keys().raw)).toBe('SIG_INVALID');
    expect(verifyPolicySignature('version: 1', '!!notbase64!!', k.raw)).toBe('SIG_INVALID');
  });
  it('an approval is bound to one decision id, nonce and request hash', () => {
    const k = keys();
    const sig = sign(null, Buffer.from(approvalMessage('d1', 'n1', 'h1')), k.privateKey).toString('base64');
    expect(verifyApproval('d1', 'n1', 'h1', sig, k.raw)).toBe('OK');
    expect(verifyApproval('d2', 'n1', 'h1', sig, k.raw)).toBe('SIG_INVALID');
    expect(verifyApproval('d1', 'n2', 'h1', sig, k.raw)).toBe('SIG_INVALID');
  });
});
