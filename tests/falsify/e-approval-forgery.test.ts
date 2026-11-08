// FALSIFY (e): forged approval nonces, foreign signatures and cross-decision replays are refused.
// Make verifyApproval return 'OK' or drop NonceStore.consume and these go RED.
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ApprovalError, NonceStore, approvalDecisionId, approvalMessage, approveEscalation, evaluate, isGenuineAllow,
  type EscalateDecision, type CallRequest,
} from '../../packages/policy-engine/src/index.ts';
import { openDb } from '../../packages/ledger/src/index.ts';
import { floor, req, session, state } from '../../packages/policy-engine/test/fixtures.ts';
import { ApprovalAuthority, Approvals } from '../../apps/broker/src/approvals.ts';

const noFloor = { version: 1, layer: 'floor' as const, hash: 'e', rules: [] };
const delLast = (): CallRequest => req({ verb: 'delete', class: 'bucket_object', target: { id: 'orders.json', label: 'plumbline-orders-db', tags: [], resolved: true } });
function escalation(r = delLast()): EscalateDecision {
  const d = evaluate(r, session, noFloor, state({ object_versions: 1 }));
  if (d.decision !== 'ESCALATE') throw new Error('setup: expected ESCALATE');
  return d;
}
function owner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64'), priv: privateKey };
}
const sig = (priv: KeyObject, e: EscalateDecision, nonce: string) =>
  sign(null, Buffer.from(approvalMessage(approvalDecisionId(e), nonce, e.request_hash)), priv).toString('base64');
const code = (fn: () => unknown): string => { try { fn(); return 'NO_THROW'; } catch (e) { return e instanceof ApprovalError ? e.code : String(e); } };

describe('FALSIFY (e) approval forgery (engine)', () => {
  it('control: a valid owner signature over this escalation yields a genuine ALLOW', () => {
    const o = owner(); const e = escalation();
    const a = approveEscalation(e, { nonce: 'n1', signature: sig(o.priv, e, 'n1') }, { publicKey: o.publicKey, nonceStore: new NonceStore() });
    expect(isGenuineAllow(a)).toBe(true);
  });
  it('a forged nonce (signature was for another nonce) is SIG_INVALID', () => {
    const o = owner(); const e = escalation();
    expect(code(() => approveEscalation(e, { nonce: 'n-forged', signature: sig(o.priv, e, 'n1') }, { publicKey: o.publicKey, nonceStore: new NonceStore() }))).toBe('SIG_INVALID');
  });
  it('a signature from the wrong key is SIG_INVALID; a missing one is SIG_REQUIRED', () => {
    const o = owner(); const attacker = owner(); const e = escalation();
    const opts = { publicKey: o.publicKey, nonceStore: new NonceStore() };
    expect(code(() => approveEscalation(e, { nonce: 'n1', signature: sig(attacker.priv, e, 'n1') }, opts))).toBe('SIG_INVALID');
    expect(code(() => approveEscalation(e, { nonce: 'n1' }, opts))).toBe('SIG_REQUIRED');
    expect(opts.nonceStore.has('n1')).toBe(false);
  });
  it('an approval minted for decision A replayed against decision B (different request id) is refused', () => {
    const o = owner(); const a = escalation(); const b = escalation();
    expect(a.request_id).not.toBe(b.request_id);
    const forA = { nonce: 'n1', signature: sig(o.priv, a, 'n1') };
    expect(code(() => approveEscalation(b, forA, { publicKey: o.publicKey, nonceStore: new NonceStore() }))).toBe('SIG_INVALID');
  });
  it('a valid approval cannot be used twice: the second use is NONCE_REPLAYED', () => {
    const o = owner(); const e = escalation();
    const opts = { publicKey: o.publicKey, nonceStore: new NonceStore() };
    const ap = { nonce: 'n1', signature: sig(o.priv, e, 'n1') };
    approveEscalation(e, ap, opts);
    expect(code(() => approveEscalation(e, ap, opts))).toBe('NONCE_REPLAYED');
  });
  it('a hand-built ESCALATE object or a DENY is not an engine escalation', () => {
    const o = owner(); const e = escalation();
    const forged = { ...e } as EscalateDecision;
    expect(code(() => approveEscalation(forged, { nonce: 'n1', signature: sig(o.priv, e, 'n1') }, { publicKey: o.publicKey, nonceStore: new NonceStore() }))).toBe('NOT_AN_ENGINE_ESCALATION');
    const deny = evaluate(delLast(), session, floor, state({ object_versions: 2, kill_switch: true }));
    expect(deny.decision).toBe('DENY');
    expect(code(() => approveEscalation(deny as never, { nonce: 'n1', signature: 'x' }, { publicKey: o.publicKey, nonceStore: new NonceStore() }))).toBe('NOT_AN_ENGINE_ESCALATION');
  });
  it('empty or oversized nonces are NONCE_INVALID', () => {
    const o = owner(); const e = escalation();
    for (const n of ['', 'n'.repeat(129)]) expect(code(() => approveEscalation(e, { nonce: n, signature: 'x' }, { publicKey: o.publicKey, nonceStore: new NonceStore() }))).toBe('NONCE_INVALID');
  });
});

describe('FALSIFY (e) approval forgery (broker)', () => {
  it('ApprovalAuthority refuses a binding for a different decision than the escalation it is given', () => {
    const auth = new ApprovalAuthority(); const a = escalation(); const b = escalation();
    const bindingB = { request_id: b.request_id, rule_id: b.rule_id, request_hash: b.request_hash, target_fp: 'fp' };
    expect(code(() => auth.approve(a, bindingB, 'n1'))).toBe('SIG_INVALID');
  });
  it('control + replay: ApprovalAuthority approves its own escalation once, then refuses the nonce again', () => {
    const auth = new ApprovalAuthority(); const e = escalation();
    const binding = { request_id: e.request_id, rule_id: e.rule_id, request_hash: e.request_hash, target_fp: 'fp' };
    expect(isGenuineAllow(auth.approve(e, binding, 'n1'))).toBe(true);
    expect(code(() => auth.approve(e, binding, 'n1'))).toBe('NONCE_REPLAYED');
  });
  it('Approvals.take: wrong nonce, wrong session and a second take are all refused', () => {
    const db = openDb(':memory:'); const ap = new Approvals(db);
    const call = { verb: 'delete', class: 'bucket_object', target: { id: 'orders.json' }, params: {} } as never;
    const binding = { request_id: 'r', rule_id: 'last-copy-block', request_hash: 'h', target_fp: 'f' };
    const nonce = ap.create('dec-1', 'sess0001', call, 1000, binding);
    expect(ap.take('dec-1', 'sess0001', 'forged-nonce', true, 1001).kind).toBe('bad_nonce');
    expect(ap.take('dec-1', 'othersess', nonce, true, 1001).kind).toBe('not_found');
    expect(ap.take('dec-other', 'sess0001', nonce, true, 1001).kind).toBe('not_found');
    expect(ap.take('dec-1', 'sess0001', nonce, true, 1001).kind).toBe('ok');
    expect(ap.take('dec-1', 'sess0001', nonce, true, 1002).kind).toBe('not_found');
  });
  it('Approvals.take: an approval older than the TTL is refused', () => {
    const db = openDb(':memory:'); const ap = new Approvals(db);
    const binding = { request_id: 'r', rule_id: 'x', request_hash: 'h', target_fp: 'f' };
    const nonce = ap.create('dec-2', 'sess0001', {} as never, 1000, binding);
    expect(ap.take('dec-2', 'sess0001', nonce, true, 1000 + 11 * 60_000).kind).toBe('not_found');
  });
});
