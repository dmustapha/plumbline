// File: packages/ledger/test/decisions.test.ts
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluate, parsePolicy, type EngineState } from '@plumbline/policy-engine';
import { listDecisions, openDb, proofCounts, recordDecision } from '../src/index.ts';

const floorYaml = readFileSync(fileURLToPath(new URL('../../../policy/floor.yaml', import.meta.url)), 'utf8');
const sessYaml = readFileSync(fileURLToPath(new URL('../../../policy/session-default.yaml', import.meta.url)), 'utf8');
const p = (t: string, l: 'session' | 'floor') => { const r = parsePolicy(t, l); if (!r.ok) throw new Error('bad'); return r.policy; };
const st: EngineState = {
  now_ms: 1, rate_card: null, session_spent_usd: 0, session_ceiling_usd: 1.5, global_spent_usd: 0, global_cap_usd: 10,
  live_worker_count: 0, max_instances: 4, kill_switch: false, session_tier: 'standard',
  tier_available: { observer: true, deployer: true, network: true, objstore: true, registry: true },
  object_versions: null, restorable: null, bond: { enabled: false, free_usd: 0 },
};
const real = () => evaluate({ request_id: 'r', task_id: 't', session_id: 's', verb: 'list', class: 'instance', target: {}, params: {} }, p(sessYaml, 'session'), p(floorYaml, 'floor'), st);

describe('decision store', () => {
  it('records an engine decision and counts it', () => {
    const db = openDb(':memory:');
    const r = recordDecision(db, real(), { session_id: 's', task_id: 't', model: 'qwen3.8-27b', call: { verb: 'list' }, vultr_ids: [] });
    expect(r.id).toMatch(/^d-/);
    expect(proofCounts(db).attacks).toBe(1);
    expect(listDecisions(db)[0]?.model).toBe('qwen3.8-27b');
  });
  it('refuses a fabricated decision', () => {
    const db = openDb(':memory:');
    const forged = { decision: 'DENY', rule_id: 'x', layer: 'floor', request_id: 'r', verb: 'list', class: 'instance', reason: '', policy_version: '', layers: [], projected_cost_usd: 0 };
    expect(() => recordDecision(db, forged as never, { session_id: 's', task_id: 't', model: null, call: null, vultr_ids: [] })).toThrow('NOT_AN_ENGINE_DECISION');
    expect(proofCounts(db).attacks).toBe(0);
  });
  it('rows cannot be updated or deleted', () => {
    const db = openDb(':memory:');
    recordDecision(db, real(), { session_id: 's', task_id: 't', model: null, call: null, vultr_ids: [] });
    expect(() => db.prepare("UPDATE decisions SET decision='ALLOW'").run()).toThrow('append-only');
    expect(() => db.prepare('DELETE FROM decisions').run()).toThrow('append-only');
  });
  it('no source file other than decisions.ts inserts into decisions and none exports a seed function', () => {
    const dir = fileURLToPath(new URL('../src/', import.meta.url));
    for (const f of readdirSync(dir)) {
      const text = readFileSync(dir + f, 'utf8');
      if (f !== 'decisions.ts') expect(text).not.toMatch(/INSERT\s+(OR\s+\w+\s+)?INTO\s+decisions/i);
      expect(text).not.toMatch(/export\s+function\s+(seed|importDecisions|fakeDecision)/i);
    }
  });
});
