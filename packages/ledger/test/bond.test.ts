// File: packages/ledger/test/bond.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluate, parsePolicy, type EngineState } from '@plumbline/policy-engine';
import { Bond, openDb } from '../src/index.ts';

const S = 'aaaaaaaa';
const T = 'bbbbbbbb';
const load = (f: string, l: 'session' | 'floor') => {
  const r = parsePolicy(readFileSync(fileURLToPath(new URL(`../../../policy/${f}`, import.meta.url)), 'utf8'), l);
  if (!r.ok) throw new Error('bad');
  return r.policy;
};

describe('bond ledger rows', () => {
  it('bond $0.05 and burn $0.045 leave exactly $0.005 free and a burned action row', () => {
    const b = new Bond(openDb(':memory:'), 0.05);
    expect(b.hold(S, 'act-1', 0.045)).toBe(true);
    expect(b.snapshot(S)).toEqual({ free: 0.005, held: 0.045, burned: 0 });
    expect(b.burn('act-1')).toBe(true);
    expect(b.snapshot(S)).toEqual({ free: 0.005, held: 0, burned: 0.045 });
    expect(b.actions(S)).toEqual([{ action_id: 'act-1', amount: 0.045, state: 'burned' }]);
  });
  it('rejects a zero, negative or over-free hold and cannot release or burn what is not held', () => {
    const b = new Bond(openDb(':memory:'), 0.05);
    expect(b.hold(S, 'z', 0)).toBe(false);
    expect(b.hold(S, 'n', -1)).toBe(false);
    expect(b.hold(S, 'big', 0.06)).toBe(false);
    expect(b.release('missing')).toBe(false);
    expect(b.burn('missing')).toBe(false);
    b.hold(S, 'h', 0.01);
    b.burn('h');
    expect(b.release('h')).toBe(false);
    expect(b.snapshot(S)).toEqual({ free: 0.04, held: 0, burned: 0.01 });
  });
  it('the burn survives reopening the handle (state lives in the db, not the object)', () => {
    const db = openDb(':memory:');
    const first = new Bond(db, 0.05);
    first.hold(S, 'p', 0.045);
    first.burn('p');
    expect(new Bond(db, 0.05).snapshot(S)).toEqual({ free: 0.005, held: 0, burned: 0.045 });
  });
});

describe('bond', () => {
  it('hold then burn is idempotent per action id', () => {
    const b = new Bond(openDb(':memory:'), 5);
    expect(b.hold(S, 'a1', 1.5)).toBe(true);
    expect(b.hold(S, 'a1', 1.5)).toBe(false);
    expect(b.burn('a1')).toBe(true);
    expect(b.burn('a1')).toBe(false);
    expect(b.snapshot(S)).toEqual({ free: 3.5, held: 0, burned: 1.5 });
  });
  it('release returns the hold to free', () => {
    const b = new Bond(openDb(':memory:'), 5);
    b.hold(S, 'a2', 2);
    b.release('a2');
    expect(b.snapshot(S).free).toBe(5);
  });
  it('refuses_after_slash: the next provision is DENY bond-insufficient', () => {
    const b = new Bond(openDb(':memory:'), 0.01);
    b.hold(S, 'a3', 0.01);
    b.burn('a3');
    const st: EngineState = {
      now_ms: 1000, rate_card: { fetched_at_ms: 1000, hourly: { 'vc2-1c-1gb': 0.007 } }, session_spent_usd: 0, session_ceiling_usd: 1.5,
      global_spent_usd: 0, global_cap_usd: 10, live_worker_count: 0, max_instances: 4, kill_switch: false, session_tier: 'standard',
      tier_available: { observer: true, deployer: true, network: true, objstore: true, registry: true },
      object_versions: null, restorable: null, bond: { enabled: true, free_usd: b.freeUsd(S) },
    };
    const d = evaluate({ request_id: 'r', task_id: 't', session_id: 's', verb: 'create', class: 'instance', target: {}, params: { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-1' } }, load('session-default.yaml', 'session'), load('floor.yaml', 'floor'), st);
    expect(d.decision).toBe('DENY');
    expect(d.rule_id).toBe('bond-insufficient');
  });
});

const stateFor = (free: number): EngineState => ({
  now_ms: 1000, rate_card: { fetched_at_ms: 1000, hourly: { 'vc2-1c-1gb': 0.007 } }, session_spent_usd: 0, session_ceiling_usd: 1.5,
  global_spent_usd: 0, global_cap_usd: 10, live_worker_count: 0, max_instances: 4, kill_switch: false, session_tier: 'standard',
  tier_available: { observer: true, deployer: true, network: true, objstore: true, registry: true },
  object_versions: null, restorable: null, bond: { enabled: true, free_usd: free },
});
const provision = (free: number) => evaluate({ request_id: 'r', task_id: 't', session_id: 's', verb: 'create', class: 'instance', target: {}, params: { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-1' } }, load('session-default.yaml', 'session'), load('floor.yaml', 'floor'), stateFor(free));

describe('BOND-PER-SESSION', () => {
  it('BOND-PER-SESSION a burn in session A leaves session B at the full initial amount', () => {
    const b = new Bond(openDb(':memory:'), 0.05);
    b.hold(S, 'a-1', 0.045);
    b.burn('a-1');
    expect(b.snapshot(S)).toEqual({ free: 0.005, held: 0, burned: 0.045 });
    expect(b.snapshot(T)).toEqual({ free: 0.05, held: 0, burned: 0 });
    expect(b.actions(T)).toEqual([]);
    expect(b.actions()).toHaveLength(1);
  });
  it('BOND-PER-SESSION B can still provision (engine allows) while A is refused bond-insufficient', () => {
    const b = new Bond(openDb(':memory:'), 0.05);
    b.hold(S, 'a-2', 0.045);
    b.burn('a-2');
    expect(provision(b.freeUsd(S)).rule_id).toBe('bond-insufficient');
    expect(provision(b.freeUsd(T)).decision).toBe('ALLOW');
  });
  it('BOND-PER-SESSION a fresh session gets a fresh bond and the action id stays single-use across sessions', () => {
    const b = new Bond(openDb(':memory:'), 0.05);
    expect(b.hold(S, 'dup', 0.01)).toBe(true);
    expect(b.hold(T, 'dup', 0.01)).toBe(false);
    expect(b.snapshot(T)).toEqual({ free: 0.05, held: 0, burned: 0 });
    expect(b.snapshot('cccccccc')).toEqual({ free: 0.05, held: 0, burned: 0 });
    expect(b.release('dup')).toBe(true);
    expect(b.snapshot(S)).toEqual({ free: 0.05, held: 0, burned: 0 });
  });
  it('BOND-PER-SESSION the aggregate carries counts only, no free amount', () => {
    const b = new Bond(openDb(':memory:'), 0.05);
    b.hold(S, 'g-1', 0.045);
    b.burn('g-1');
    b.hold(T, 'g-2', 0.01);
    const agg = b.aggregate();
    expect(agg).toEqual({ sessions: 2, held_actions: 1, burned_actions: 1 });
    expect(Object.keys(agg)).not.toContain('free');
  });
  it('BOND-PER-SESSION migration opens an old database (global bond table, bond_actions without session_id)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bond-mig-'));
    const path = join(dir, 'old.db');
    try {
      const old = new Database(path);
      old.exec(`CREATE TABLE bond (id INTEGER PRIMARY KEY CHECK (id = 1), free REAL NOT NULL, held REAL NOT NULL, burned REAL NOT NULL);
        INSERT INTO bond VALUES (1, 0.005, 0, 0.045);
        CREATE TABLE bond_actions (action_id TEXT PRIMARY KEY, amount REAL NOT NULL, state TEXT NOT NULL CHECK (state IN ('held','released','burned')));
        INSERT INTO bond_actions VALUES ('old-1', 0.045, 'burned');`);
      old.close();
      const db = openDb(path);
      const b = new Bond(db, 0.05);
      expect(b.snapshot(S)).toEqual({ free: 0.05, held: 0, burned: 0 });
      expect(b.actions()).toEqual([{ action_id: 'old-1', amount: 0.045, state: 'burned' }]);
      expect(b.hold(S, 'new-1', 0.01)).toBe(true);
      expect(b.hold(S, 'old-1', 0.01)).toBe(false);
      expect(db.prepare('SELECT free FROM bond WHERE id = 1').get()).toEqual({ free: 0.005 });
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
