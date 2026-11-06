// File: packages/ledger/test/spend.test.ts
import { describe, expect, it } from 'vitest';
import { Ledger, openDb } from '../src/index.ts';

const mk = (ceiling = 1.5, cap = 10) => new Ledger(openDb(':memory:'), { session_ceiling_usd: ceiling, global_cap_usd: cap });

describe('spend()', () => {
  it('charges a session and refuses once the ceiling would be crossed', () => {
    const l = mk(0.02);
    const a = l.charge('vultr', 0.007, { session_id: 's' });
    const b = l.charge('vultr', 0.007, { session_id: 's' });
    const c = l.charge('vultr', 0.007, { session_id: 's' });
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, false]);
    expect(c.ok === false && c.reason).toBe('session-cap-exceeded');
  });
  it('another session has its own ceiling but shares the global cap', () => {
    const l = mk(1, 1.2);
    expect(l.charge('vultr', 1, { session_id: 'a' }).ok).toBe(true);
    const r = l.charge('vultr', 0.5, { session_id: 'b' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('global-cap-exceeded');
  });
  it('inference counts to the global cap only and settle adjusts resource spend', () => {
    const l = mk();
    const r = l.charge('vsi', 0.5, { session_id: 's' });
    expect(l.sessionSpend('s')).toBe(0);
    l.recordInference('s', 'qwen3.8-27b', 100, 50, 0.0002);
    expect(l.globalSpend()).toBeCloseTo(0.0002, 6);
    expect(r.ok).toBe(true);
    const v = l.charge('vultr', 0.1, { session_id: 's' });
    if (v.ok) v.receipt.settle(0.05);
    expect(l.sessionSpend('s')).toBeCloseTo(0.05, 6);
  });
  it('rejects negative or non-finite estimates', () => {
    const l = mk();
    expect(l.charge('vultr', -1, { session_id: 's' }).ok).toBe(false);
    expect(l.charge('vultr', Number.NaN, { session_id: 's' }).ok).toBe(false);
  });
  it('display is labelled BROKER ARITHMETIC', () => {
    expect(mk().display('s').basis).toBe('BROKER ARITHMETIC');
  });
});
