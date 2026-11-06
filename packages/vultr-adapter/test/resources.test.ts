import { describe, expect, it } from 'vitest';
import { Ledger, openDb } from '@plumbline/ledger';
import { Instances, Registries, VultrHttp } from '../src/index.ts';
import { createMockVultr } from './support/mock-vultr.ts';
import { allowFor, request } from './support/engine.ts';

describe('resources', () => {
  const setup = () => {
    const mock = createMockVultr();
    const http = new VultrHttp({ apiKey: 'k', gate: new Ledger(openDb(':memory:'), { session_ceiling_usd: 1.5, global_cap_usd: 10 }), fetchImpl: mock.fetch, sleep: async () => {} });
    return { mock, instances: new Instances(http), registries: new Registries(http) };
  };
  it('creates an instance with an engine ALLOW and never returns the password', async () => {
    const { instances, mock } = setup();
    const req = request({ params: { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-1' } });
    const v = await instances.create(allowFor(req), req);
    expect(v.status).toBe('pending');
    expect(JSON.stringify(v)).not.toContain('SECRET');
    expect((mock.state.instances[0] as unknown as { tags: string[] }).tags).toContain('plumbline');
  });
  it('rejects a decision for a different verb or a forged object', async () => {
    const { instances } = setup();
    const del = request({ verb: 'delete', target: { id: 'i-1', label: 'plumbline-wk-1', tags: ['plumbline'], resolved: true } });
    const list = allowFor(request({ verb: 'list' }));
    await expect(instances.delete(list, del)).rejects.toThrow(/ALLOW_MISMATCH|ALLOW_REQUEST_MISMATCH/);
    await expect(instances.delete({ decision: 'ALLOW' } as never, del)).rejects.toThrow('NOT_AN_ENGINE_ALLOW');
  });
  it('registry names are lowercase alphanumeric only', async () => {
    const { registries } = setup();
    const req = request({ class: 'registry', params: { region: 'ewr', label: 'plumblinereg', name: 'plumbline-reg' } });
    await expect(registries.create(allowFor(req), req)).rejects.toThrow('lowercase alphanumeric');
  });
});
