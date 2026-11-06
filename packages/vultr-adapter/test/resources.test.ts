// File: packages/vultr-adapter/test/resources.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Ledger, openDb } from '@plumbline/ledger';
import { evaluate, parsePolicy, type CallRequest, type Decision, type EngineState } from '@plumbline/policy-engine';
import { Instances, Registries, VultrHttp } from '../src/index.ts';
import { createMockVultr } from './support/mock-vultr.ts';

const load = (f: string, l: 'session' | 'floor') => {
  const r = parsePolicy(readFileSync(fileURLToPath(new URL(`../../../policy/${f}`, import.meta.url)), 'utf8'), l);
  if (!r.ok) throw new Error('bad policy');
  return r.policy;
};
const st: EngineState = {
  now_ms: 1000, rate_card: { fetched_at_ms: 1000, hourly: { 'vc2-1c-1gb': 0.007 } }, session_spent_usd: 0, session_ceiling_usd: 1.5,
  global_spent_usd: 0, global_cap_usd: 10, live_worker_count: 0, max_instances: 4, kill_switch: false, session_tier: 'standard',
  tier_available: { observer: true, deployer: true, network: true, objstore: true, registry: true },
  object_versions: null, restorable: null, bond: { enabled: false, free_usd: 0 },
};
const decide = (r: Partial<CallRequest>): Decision =>
  evaluate({ request_id: 'r', task_id: 't', session_id: 's', verb: 'create', class: 'instance', target: {}, params: {}, ...r }, load('session-default.yaml', 'session'), load('floor.yaml', 'floor'), st);

describe('resources', () => {
  const setup = () => {
    const mock = createMockVultr();
    const http = new VultrHttp({ apiKey: 'k', gate: new Ledger(openDb(':memory:'), { session_ceiling_usd: 1.5, global_cap_usd: 10 }), fetchImpl: mock.fetch, sleep: async () => {} });
    return { mock, instances: new Instances(http), registries: new Registries(http) };
  };
  it('creates an instance with an engine ALLOW and never returns the password', async () => {
    const { instances, mock } = setup();
    const d = decide({ params: { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-1' } });
    expect(d.decision).toBe('ALLOW');
    if (d.decision !== 'ALLOW') return;
    const v = await instances.create(d, { session_id: 's' }, { region: 'ewr', plan: 'vc2-1c-1gb', label: 'plumbline-wk-1' });
    expect(v.status).toBe('pending');
    expect(JSON.stringify(v)).not.toContain('SECRET');
    expect((mock.state.instances[0] as unknown as { tags: string[] }).tags).toContain('plumbline');
  });
  it('rejects a decision for a different verb or a forged object', async () => {
    const { instances } = setup();
    const list = decide({ verb: 'list' });
    await expect(instances.delete(list as never, { session_id: 's' }, 'i-1')).rejects.toThrow(/ALLOW_MISMATCH|NOT_AN_ENGINE_ALLOW/);
    await expect(instances.delete({ decision: 'ALLOW' } as never, { session_id: 's' }, 'i-1')).rejects.toThrow('NOT_AN_ENGINE_ALLOW');
  });
  it('registry names are lowercase alphanumeric only', async () => {
    const { registries } = setup();
    const d = decide({ class: 'registry', params: { region: 'ewr', label: 'plumblinereg' } });
    if (d.decision !== 'ALLOW') throw new Error('expected allow');
    await expect(registries.create(d, { session_id: 's' }, { name: 'plumbline-reg', region: 'ewr' })).rejects.toThrow('lowercase alphanumeric');
  });
});
