// FALSIFY (d): stale or missing rate card fails closed; over-ceiling is DENY with the arithmetic reason; the ledger refuses over-cap spend.
import { describe, expect, it } from 'vitest';
import { evaluate, RATE_CARD_MAX_AGE_MS } from '../../packages/policy-engine/src/index.ts';
import { Ledger, openDb } from '../../packages/ledger/src/index.ts';
import { allowAllSession, floor, NOW, req, session, state } from '../../packages/policy-engine/test/fixtures.ts';

const create = (over: Record<string, unknown> = {}) =>
  req({ verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region: 'ewr', ttl_h: 1, label: 'plumbline-wk-1', ...over } });
const full = (r = create(), s = state()) => evaluate(r, session, floor, s);
const floorOnly = (r = create(), s = state()) => evaluate(r, allowAllSession, floor, s);

describe('FALSIFY (d) rate card and ceiling', () => {
  it('control: fresh card, in-budget create is ALLOW', () => {
    expect(full().decision).toBe('ALLOW');
  });
  it('missing rate card fails closed: DENY rate-card-unavailable (not cost 0)', () => {
    for (const run of [full, floorOnly]) {
      const d = run(create(), state({ rate_card: null }));
      expect([d.decision, d.rule_id]).toEqual(['DENY', 'rate-card-unavailable']);
    }
  });
  it('stale rate card fails closed one millisecond past the max age, and is still fresh at the boundary', () => {
    const hourly = { 'vc2-1c-1gb': 0.007 };
    const stale = state({ rate_card: { fetched_at_ms: NOW - RATE_CARD_MAX_AGE_MS - 1, hourly } });
    const edge = state({ rate_card: { fetched_at_ms: NOW - RATE_CARD_MAX_AGE_MS, hourly } });
    expect(full(create(), stale).rule_id).toBe('rate-card-unavailable');
    expect(floorOnly(create(), stale).rule_id).toBe('rate-card-unavailable');
    expect(full(create(), edge).decision).toBe('ALLOW');
  });
  it('a plan absent from the card is unpriced and DENY, not free', () => {
    const lean = state({ rate_card: { fetched_at_ms: NOW, hourly: { 'vc2-1c-0.5gb': 0.005 } } });
    expect(full(create(), lean).rule_id).toBe('rate-card-unavailable');
  });
  it('over-ceiling is DENY with the arithmetic in the reason: 0.007 x 3 h = 0.0210 > remaining 0.0200', () => {
    const d = full(create({ ttl_h: 3 }), state({ session_ceiling_usd: 0.02 }));
    expect([d.decision, d.rule_id]).toEqual(['DENY', 'ceiling-dollar-deny']);
    expect(d.reason).toContain('0.0070');
    expect(d.reason).toContain('0.0210');
    expect(d.reason).toContain('0.0200');
  });
  it('over-ceiling holds under an allow-all session (floor alone) and with partial spend counted', () => {
    expect(floorOnly(create({ ttl_h: 400 })).rule_id).toBe('ceiling-dollar-deny');
    const d = full(create({ ttl_h: 1 }), state({ session_ceiling_usd: 1.5, session_spent_usd: 1.495 }));
    expect(d.decision).toBe('DENY');
  });
  it('a NaN or negative ttl cannot dodge the ceiling', () => {
    expect(full(create({ ttl_h: Number.NaN })).decision).toBe('DENY');
    expect(full(create({ ttl_h: -5 })).decision).toBe('DENY');
  });
  it('ledger spend gate: an over-cap charge is refused, an in-cap charge is accepted, and refusal records no spend', () => {
    const db = openDb(':memory:');
    const l = new Ledger(db, { session_ceiling_usd: 1.5, global_cap_usd: 10 });
    expect(l.charge('vultr', 2, { session_id: 's1' })).toEqual({ ok: false, reason: 'session-cap-exceeded' });
    expect(l.sessionSpend('s1')).toBe(0);
    expect(l.charge('vultr', 1.0, { session_id: 's1' }).ok).toBe(true);
    expect(l.charge('vultr', 0.6, { session_id: 's1' })).toEqual({ ok: false, reason: 'session-cap-exceeded' });
    const g = new Ledger(openDb(':memory:'), { session_ceiling_usd: 50, global_cap_usd: 1 });
    expect(g.charge('vultr', 2, { session_id: 's2' })).toEqual({ ok: false, reason: 'global-cap-exceeded' });
  });
});
