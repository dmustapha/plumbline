import { describe, expect, it } from 'vitest';
import { Ledger, openDb } from '@plumbline/ledger';
import { Firewalls, Instances, Registries, S3Store, Vpcs, VultrHttp } from '../src/index.ts';
import { createMockVultr } from './support/mock-vultr.ts';
import { allowFor, request } from './support/engine.ts';

const setup = () => {
  const mock = createMockVultr();
  const ledger = new Ledger(openDb(':memory:'), { session_ceiling_usd: 1.5, global_cap_usd: 10 });
  const http = new VultrHttp({ apiKey: 'k', gate: ledger, fetchImpl: mock.fetch, sleep: async () => {} });
  return { mock, ledger, instances: new Instances(http), firewalls: new Firewalls(http), vpcs: new Vpcs(http), registries: new Registries(http) };
};
const createReq = (plan: string, label = 'plumbline-wk-1') => request({ verb: 'create', class: 'instance', params: { plan, region: 'ewr', label } });
const deleteReq = (id: string) => request({ verb: 'delete', class: 'instance', target: { id, label: `plumbline-wk-${id}`, tags: ['plumbline'], resolved: true } });

describe('AG4-ADP-2 an ALLOW is bound to its call', () => {
  it('AG4-ADP-2 ALLOW for worker A cannot delete instance B', async () => {
    const { instances, mock } = setup();
    mock.state.instances.push({ id: 'A' }, { id: 'B' });
    const allowA = allowFor(deleteReq('A'));
    await expect(instances.delete(allowA, deleteReq('B'))).rejects.toThrow(/ALLOW_REQUEST_MISMATCH/);
    expect(mock.state.instances.map((i) => i.id)).toEqual(['A', 'B']);
  });
  it('AG4-ADP-2 the delete id comes from the bound request, so the ALLOW deletes exactly A', async () => {
    const { instances, mock } = setup();
    mock.state.instances.push({ id: 'A' }, { id: 'B' });
    const req = deleteReq('A');
    await instances.delete(allowFor(req), req);
    expect(mock.state.instances.map((i) => i.id)).toEqual(['B']);
  });
  it('AG4-ADP-2 ALLOW for plan X cannot create plan Y', async () => {
    const { instances, mock } = setup();
    const cheap = createReq('vc2-1c-1gb');
    const allow = allowFor(cheap);
    await expect(instances.create(allow, createReq('vc2-2c-4gb'))).rejects.toThrow(/ALLOW_REQUEST_MISMATCH/);
    expect(mock.state.instances).toHaveLength(0);
  });
  it('AG4-ADP-2 plan, region and cost come from the one bound request', async () => {
    const { instances, mock, ledger } = setup();
    const req = createReq('vc2-1c-1gb');
    const allow = allowFor(req);
    await instances.create(allow, req);
    expect(mock.state.instances[0]).toMatchObject({ plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-1' });
    expect(ledger.sessionSpend('s')).toBe(allow.projected_cost_usd);
  });
  it('AG4-ADP-2 a replayed ALLOW is refused', async () => {
    const { instances, mock } = setup();
    const req = createReq('vc2-1c-1gb');
    const allow = allowFor(req);
    await instances.create(allow, req);
    await expect(instances.create(allow, req)).rejects.toThrow('ALLOW_REPLAY');
    expect(mock.state.instances).toHaveLength(1);
  });
  it('AG4-ADP-2 a mismatched request does not burn the ALLOW', async () => {
    const { instances } = setup();
    const req = createReq('vc2-1c-1gb');
    const allow = allowFor(req);
    await expect(instances.create(allow, createReq('vc2-2c-4gb'))).rejects.toThrow();
    await expect(instances.create(allow, req)).resolves.toBeDefined();
  });
  it('AG4-ADP-2 a verb mismatch is refused (list ALLOW cannot delete)', async () => {
    const { instances } = setup();
    const list = request({ verb: 'list', class: 'instance' });
    await expect(instances.delete(allowFor(list), deleteReq('A'))).rejects.toThrow(/ALLOW_MISMATCH|ALLOW_REQUEST_MISMATCH/);
  });
  it('AG4-ADP-2 a forged plain object is refused', async () => {
    const { instances } = setup();
    await expect(instances.delete({ decision: 'ALLOW', verb: 'delete', class: 'instance' } as never, deleteReq('A'))).rejects.toThrow('NOT_AN_ENGINE_ALLOW');
  });
  it('AG4-ADP-2 firewall rule port is bound to the request params', async () => {
    const { firewalls, mock } = setup();
    const req = request({ verb: 'update', class: 'firewall_group', target: { id: 'fw-1', label: 'plumbline-s00000000-x', resolved: true }, params: { port: '22' } as never });
    const allow = allowFor(req);
    await expect(firewalls.addRule(allow, req, { port: '3306', notes: 'n' })).rejects.toThrow(/PORT/);
    await firewalls.addRule(allow, req, { port: '22', notes: 'n' });
    expect(mock.state.calls.some((c) => c.path === '/firewalls/fw-1/rules')).toBe(true);
  });
  it('AG4-ADP-2 vpc and registry creation take every field from the request', async () => {
    const { vpcs, registries, mock } = setup();
    const vreq = request({ verb: 'create', class: 'vpc', params: { region: 'ewr', label: 'plumbline-vpc-1', subnet: '10.9.0.0', subnet_size: 24 } });
    await vpcs.create(allowFor(vreq), vreq);
    expect(mock.state.vpcs[0]).toMatchObject({ region: 'ewr', description: 'plumbline-vpc-1', v4_subnet: '10.9.0.0', v4_subnet_mask: 24 });
    const rreq = request({ verb: 'create', class: 'registry', params: { region: 'ewr', name: 'plumblinereg', label: 'plumblinereg' } });
    await registries.create(allowFor(rreq), rreq);
    expect(mock.state.registries[0]).toMatchObject({ name: 'plumblinereg' });
  });
  it('AG4-ADP-2 S3 put is bound to the key and single use', async () => {
    const sent: unknown[] = [];
    const gate = new Ledger(openDb(':memory:'), { session_ceiling_usd: 1.5, global_cap_usd: 10 });
    const s3 = new S3Store({ host: 'h', accessKey: 'a', secretKey: 's', bucket: 'b' }, gate, { send: async (c) => { sent.push(c); return { VersionId: 'v1' }; } });
    const req = request({ verb: 'put', class: 'bucket_object', target: { id: 'orders.json', label: 'plumbline-orders-db', resolved: true }, params: { key: 'orders.json' } });
    const allow = allowFor(req, { object_versions: 3 });
    const other = request({ verb: 'put', class: 'bucket_object', target: { id: 'secrets.json', label: 'plumbline-orders-db', resolved: true }, params: { key: 'secrets.json' } });
    await expect(s3.putObject(allow, other, '{}')).rejects.toThrow(/ALLOW_REQUEST_MISMATCH/);
    await expect(s3.putObject(allow, req, '{}')).resolves.toBe('v1');
    await expect(s3.putObject(allow, req, '{}')).rejects.toThrow('ALLOW_REPLAY');
    expect(sent).toHaveLength(1);
  });
});
