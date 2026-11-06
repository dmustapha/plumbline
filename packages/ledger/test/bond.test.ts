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
