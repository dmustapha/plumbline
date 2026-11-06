// File: packages/ledger/test/bond.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluate, parsePolicy, type EngineState } from '@plumbline/policy-engine';
import { Bond, openDb } from '../src/index.ts';

const load = (f: string, l: 'session' | 'floor') => {
  const r = parsePolicy(readFileSync(fileURLToPath(new URL(`../../../policy/${f}`, import.meta.url)), 'utf8'), l);
  if (!r.ok) throw new Error('bad');
  return r.policy;
};

describe('bond ledger rows', () => {
  it('bond $0.05 and burn $0.045 leave exactly $0.005 free and a burned action row', () => {
    const b = new Bond(openDb(':memory:'), 0.05);
    expect(b.hold('act-1', 0.045)).toBe(true);
    expect(b.snapshot()).toEqual({ free: 0.005, held: 0.045, burned: 0 });
    expect(b.burn('act-1')).toBe(true);
    expect(b.snapshot()).toEqual({ free: 0.005, held: 0, burned: 0.045 });
    expect(b.actions()).toEqual([{ action_id: 'act-1', amount: 0.045, state: 'burned' }]);
  });
  it('rejects a zero, negative or over-free hold and cannot release or burn what is not held', () => {
    const b = new Bond(openDb(':memory:'), 0.05);
    expect(b.hold('z', 0)).toBe(false);
    expect(b.hold('n', -1)).toBe(false);
    expect(b.hold('big', 0.06)).toBe(false);
    expect(b.release('missing')).toBe(false);
    expect(b.burn('missing')).toBe(false);
    b.hold('h', 0.01);
    b.burn('h');
    expect(b.release('h')).toBe(false);
    expect(b.snapshot()).toEqual({ free: 0.04, held: 0, burned: 0.01 });
  });
  it('the burn survives reopening the handle (state lives in the db, not the object)', () => {
    const db = openDb(':memory:');
    const first = new Bond(db, 0.05);
    first.hold('p', 0.045);
    first.burn('p');
    expect(new Bond(db, 0.05).snapshot()).toEqual({ free: 0.005, held: 0, burned: 0.045 });
  });
});

describe('bond', () => {
  it('hold then burn is idempotent per action id', () => {
    const b = new Bond(openDb(':memory:'), 5);
    expect(b.hold('a1', 1.5)).toBe(true);
    expect(b.hold('a1', 1.5)).toBe(false);
    expect(b.burn('a1')).toBe(true);
    expect(b.burn('a1')).toBe(false);
    expect(b.snapshot()).toEqual({ free: 3.5, held: 0, burned: 1.5 });
  });
  it('release returns the hold to free', () => {
    const b = new Bond(openDb(':memory:'), 5);
    b.hold('a2', 2);
    b.release('a2');
    expect(b.snapshot().free).toBe(5);
  });
  it('refuses_after_slash: the next provision is DENY bond-insufficient', () => {
    const b = new Bond(openDb(':memory:'), 0.01);
    b.hold('a3', 0.01);
    b.burn('a3');
    const st: EngineState = {
      now_ms: 1000, rate_card: { fetched_at_ms: 1000, hourly: { 'vc2-1c-1gb': 0.007 } }, session_spent_usd: 0, session_ceiling_usd: 1.5,
      global_spent_usd: 0, global_cap_usd: 10, live_worker_count: 0, max_instances: 4, kill_switch: false, session_tier: 'standard',
      tier_available: { observer: true, deployer: true, network: true, objstore: true, registry: true },
      object_versions: null, restorable: null, bond: { enabled: true, free_usd: b.freeUsd() },
    };
    const d = evaluate({ request_id: 'r', task_id: 't', session_id: 's', verb: 'create', class: 'instance', target: {}, params: { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-1' } }, load('session-default.yaml', 'session'), load('floor.yaml', 'floor'), st);
    expect(d.decision).toBe('DENY');
    expect(d.rule_id).toBe('bond-insufficient');
  });
});
