import { describe, expect, it } from 'vitest';
import { Ledger, openDb } from '@plumbline/ledger';
import { Firewalls, Instances, Registries, Vpcs, VultrHttp } from '../src/index.ts';
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

describe('G1e breadth verbs: firewall group, VPC, registry (create and delete through the engine)', () => {
  const setup = () => {
    const mock = createMockVultr();
    const http = new VultrHttp({ apiKey: 'k', gate: new Ledger(openDb(':memory:'), { session_ceiling_usd: 1.5, global_cap_usd: 10 }), fetchImpl: mock.fetch, sleep: async () => {} });
    return { mock, firewalls: new Firewalls(http), vpcs: new Vpcs(http), registries: new Registries(http) };
  };
  const mutating = (mock: ReturnType<typeof createMockVultr>) => mock.state.calls.filter((c) => c.method !== 'GET');
  const forged = { decision: 'ALLOW' } as never;
  const del = (cls: 'firewall_group' | 'vpc' | 'registry', id: string, label: string) =>
    request({ verb: 'delete', class: cls, target: { id, label, tags: [], resolved: true } });

  it('firewall group: create then delete round-trips against the mock with the right paths', async () => {
    const { firewalls, mock } = setup();
    const c = request({ class: 'firewall_group', params: { label: 'plumbline-s1a2b3c4d-vault' } });
    const fw = await firewalls.create(allowFor(c), c);
    expect(mock.state.firewall_groups).toHaveLength(1);
    expect(mock.state.firewall_groups[0]).toMatchObject({ description: 'plumbline-s1a2b3c4d-vault' });
    const d = del('firewall_group', fw.id, 'plumbline-s1a2b3c4d-vault');
    await firewalls.delete(allowFor(d), d);
    expect(mock.state.firewall_groups).toHaveLength(0);
    expect(mutating(mock).map((x) => `${x.method} ${x.path}`)).toEqual(['POST /firewalls', `DELETE /firewalls/${fw.id}`]);
  });
  it('VPC: create then delete round-trips against the mock with the right paths', async () => {
    const { vpcs, mock } = setup();
    const c = request({ class: 'vpc', params: { region: 'ewr', label: 'plumbline-s1a2b3c4d-lab', subnet: '10.9.0.0', subnet_size: 24 } });
    const v = await vpcs.create(allowFor(c), c);
    expect(mock.state.vpcs[0]).toMatchObject({ region: 'ewr', description: 'plumbline-s1a2b3c4d-lab', v4_subnet: '10.9.0.0', v4_subnet_size: 24 });
    const d = del('vpc', v.id, 'plumbline-s1a2b3c4d-lab');
    await vpcs.delete(allowFor(d), d);
    expect(mock.state.vpcs).toHaveLength(0);
    expect(mutating(mock).map((x) => `${x.method} ${x.path}`)).toEqual(['POST /vpcs', `DELETE /vpcs/${v.id}`]);
  });
  it('registry: create then delete round-trips against the mock with the right paths', async () => {
    const { registries, mock } = setup();
    const c = request({ class: 'registry', params: { region: 'ewr', label: 'plumbline-s1a2b3c4d-reg', name: 'plumbliness1a2b3c4dreg' } });
    const r = await registries.create(allowFor(c), c);
    expect(mock.state.registries[0]).toMatchObject({ name: 'plumbliness1a2b3c4dreg', public: false, region: 'ewr' });
    const d = del('registry', r.id, 'plumbline-s1a2b3c4d-reg');
    await registries.delete(allowFor(d), d);
    expect(mock.state.registries).toHaveLength(0);
    expect(mutating(mock).map((x) => `${x.method} ${x.path}`)).toEqual(['POST /registry', `DELETE /registry/${r.id}`]);
  });
  it('every breadth mutator throws NOT_AN_ENGINE_ALLOW for a forged decision and never calls the mock', async () => {
    const { firewalls, vpcs, registries, mock } = setup();
    const fc = request({ class: 'firewall_group', params: { label: 'plumbline-s1a2b3c4d-vault' } });
    const vc = request({ class: 'vpc', params: { region: 'ewr', label: 'plumbline-s1a2b3c4d-lab', subnet: '10.9.0.0', subnet_size: 24 } });
    const rc = request({ class: 'registry', params: { region: 'ewr', label: 'plumbline-s1a2b3c4d-reg', name: 'plumbliness1a2b3c4dreg' } });
    const calls = [
      firewalls.create(forged, fc), vpcs.create(forged, vc), registries.create(forged, rc),
      firewalls.delete(forged, del('firewall_group', 'f', 'plumbline-s1a2b3c4d-vault')),
      vpcs.delete(forged, del('vpc', 'v', 'plumbline-s1a2b3c4d-lab')),
      registries.delete(forged, del('registry', 'r', 'plumbline-s1a2b3c4d-reg')),
    ];
    for (const p of calls) await expect(p).rejects.toThrow('NOT_AN_ENGINE_ALLOW');
    expect(mock.state.calls).toHaveLength(0);
  });
  it('VPC subnet is bound by the request hash: an ALLOW for 10.9.0.0 cannot create 10.0.0.0', async () => {
    const { vpcs, mock } = setup();
    const base = { class: 'vpc' as const, params: { region: 'ewr', label: 'plumbline-s1a2b3c4d-lab', subnet: '10.9.0.0', subnet_size: 24 } };
    const req = request(base);
    const allow = allowFor(req);
    const swapped = { ...req, params: { ...req.params, subnet: '10.0.0.0' } };
    await expect(vpcs.create(allow, swapped)).rejects.toThrow();
    expect(mock.state.vpcs).toHaveLength(0);
    await expect(vpcs.create(allow, req)).resolves.toMatchObject({ region: 'ewr' });
  });
  it('registry name is bound by the request hash: an ALLOW for one name cannot create another', async () => {
    const { registries, mock } = setup();
    const req = request({ class: 'registry', params: { region: 'ewr', label: 'plumbline-s1a2b3c4d-reg', name: 'plumbliness1a2b3c4dreg' } });
    const allow = allowFor(req);
    const swapped = { ...req, params: { ...req.params, name: 'plumblinereg' } };
    await expect(registries.create(allow, swapped)).rejects.toThrow();
    expect(mock.state.registries).toHaveLength(0);
  });
  it('firewall port is bound by the request hash: a swapped params.port is refused before any call', async () => {
    const { firewalls, mock } = setup();
    const req = request({ verb: 'update', class: 'firewall_group', target: { id: 'fw-1', label: 'plumbline-s1a2b3c4d-vault', resolved: true }, params: { port: '22' } as never });
    const allow = allowFor(req);
    const swapped = { ...req, params: { port: '3306' } as never };
    await expect(firewalls.addRule(allow, swapped, { port: '3306', notes: 'n' })).rejects.toThrow();
    expect(mutating(mock)).toHaveLength(0);
  });
  it('delete needs a target id: a resolved-less request with no id throws TARGET_ID_REQUIRED', async () => {
    const { vpcs } = setup();
    const req = request({ verb: 'delete', class: 'vpc', target: { label: 'plumbline-s1a2b3c4d-lab', tags: [], resolved: true } });
    await expect(vpcs.delete(allowFor(req), req)).rejects.toThrow('TARGET_ID_REQUIRED');
  });
  it('PARAM_REQUIRED: a VPC create without a subnet is refused', async () => {
    const { vpcs, mock } = setup();
    const req = request({ class: 'vpc', params: { region: 'ewr', label: 'plumbline-s1a2b3c4d-lab' } });
    await expect(vpcs.create(allowFor(req), req)).rejects.toThrow('PARAM_REQUIRED: subnet');
    expect(mock.state.calls).toHaveLength(0);
  });
  it('U-8: the adapter has no registry push code', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = new URL('../src/', import.meta.url);
    const hits = readdirSync(dir).flatMap((f) => readFileSync(new URL(f, dir), 'utf8').split('\n').filter((l) => /push/i.test(l) && /registry/i.test(l)));
    expect(hits).toEqual([]);
  });
});
