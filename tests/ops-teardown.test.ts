import { describe, expect, it } from 'vitest';
import { Ledger, openDb } from '@plumbline/ledger';
import { evaluate, parsePolicy, type CallRequest, type EngineState } from '@plumbline/policy-engine';
import { OwnerAdmin, VultrHttp, type OwnerActionRecord } from '@plumbline/vultr-adapter';
import { createMockVultr } from '../packages/vultr-adapter/test/support/mock-vultr.ts';
import { STATE } from '../packages/vultr-adapter/test/support/engine.ts';
import { makeOwnerPort, type Item, type OwnerCtx, type OwnerPort } from '../ops/scripts/owner-port.ts';
import type { OwnerContext } from '../ops/scripts/owner.ts';
import { exitCodeFor, orderItems, runTeardown } from '../ops/scripts/teardown.ts';

const items: Item[] = [
  { kind: 'object_storage', id: 'sub1', label: 'object-storage:sub1' }, { kind: 'user', id: 'u1', label: 'plumbline-observer' }, { kind: 'registry', id: 'r1', label: 'plumblinereg' },
  { kind: 'vpc', id: 'v1', label: 'plumbline-vpc' }, { kind: 'firewall_group', id: 'f1', label: 'plumbline-s00000000-vault' }, { kind: 'instance', id: 'i1', label: 'plumbline-prod-db' },
];

const fakePort = (failOn?: string): { port: OwnerPort; calls: string[] } => {
  const calls: string[] = [];
  return { calls, port: {
    inventory: async () => items, createInstance: async () => ({ id: 'x' }),
    remove: async (i, reason) => { if (i.id === failOn) throw new Error('boom'); calls.push(`${i.kind}:${i.id}:${reason}`); },
  } };
};

describe('teardown', () => {
  it('lists everything and deletes nothing without --yes', async () => {
    const { port, calls } = fakePort(); const log: string[] = [];
    const r = await runTeardown({ port, yes: false, log: (l) => log.push(l) });
    expect(calls).toEqual([]);
    expect(r.confirmed).toBe(false);
    expect(exitCodeFor(r)).toBe(3);
    expect(log.filter((l) => l.startsWith('  '))).toHaveLength(6);
    expect(log.join('\n')).toContain('NOT CONFIRMED');
  });
  it('with --yes deletes in dependency order, the paid storage subscription last, each with a reason', async () => {
    const { port, calls } = fakePort();
    const r = await runTeardown({ port, yes: true, log: () => {} });
    expect(calls.map((c) => c.split(':')[0])).toEqual(['instance', 'firewall_group', 'vpc', 'registry', 'user', 'object_storage']);
    expect(calls.every((c) => c.includes('teardown'))).toBe(true);
    expect(exitCodeFor(r)).toBe(0);
  });
  it('one failure is recorded, the rest still run, exit is non-zero', async () => {
    const { port, calls } = fakePort('v1');
    const r = await runTeardown({ port, yes: true, log: () => {} });
    expect(r.failed.map((f) => f.item.id)).toEqual(['v1']);
    expect(calls).toHaveLength(5);
    expect(exitCodeFor(r)).toBe(1);
  });
  it('warns when the Object Storage subscription is not in the plan', async () => {
    const log: string[] = [];
    await runTeardown({ port: { ...fakePort().port, inventory: async () => [] }, yes: false, log: (l) => log.push(l) });
    expect(log.join('\n')).toContain('VULTR_OBJSTORE_ID');
  });
  it('orderItems does not mutate its input', () => {
    const copy = [...items];
    orderItems(items);
    expect(items).toEqual(copy);
  });
});

describe('OPS-1 teardown goes through OwnerAction and the engine (mock Vultr)', () => {
  const OWNER = `version: 2
rules:
  - { id: custom-owner-delete, effect: allow, priority: 10, match: { verb: [delete], class: [instance, firewall_group, vpc, registry], label_prefix: [plumbline] }, reason: owner delete }
`;
  const FLOOR = `version: 2
rules:
  - { id: scope-label-prefix, effect: deny, priority: 90, match: { verb: [create, update, delete], class: [instance, firewall_group, vpc, registry], label_not_prefix: [plumbline] }, reason: owner scripts only touch plumbline resources }
`;
  function ctx(): { o: OwnerCtx; rec: OwnerActionRecord[]; mock: ReturnType<typeof createMockVultr>; evaluated: CallRequest[] } {
    const mock = createMockVultr(); const rec: OwnerActionRecord[] = []; const evaluated: CallRequest[] = [];
    const http = new VultrHttp({ apiKey: 'owner', gate: new Ledger(openDb(':memory:'), { session_ceiling_usd: 1e6, global_cap_usd: 1e6 }), fetchImpl: mock.fetch, sleep: async () => {} });
    const session = parsePolicy(OWNER, 'session'); const floor = parsePolicy(FLOOR, 'floor');
    if (!session.ok || !floor.ok) throw new Error(`policy ${JSON.stringify([session, floor])}`);
    const allow = (req: CallRequest) => {
      evaluated.push(req);
      const d = evaluate(req, session.policy, floor.policy, { ...STATE } as EngineState);
      if (d.decision !== 'ALLOW') throw new Error(`refused: ${d.rule_id}`);
      return d;
    };
    return { o: { http, admin: new OwnerAdmin(http), ctx: { session_id: 'owner' }, allow, record: (r) => rec.push(r) }, rec, mock, evaluated };
  }
  it('deletes an instance via an engine ALLOW and the storage subscription via a recorded OwnerAction', async () => {
    const { o, rec, mock, evaluated } = ctx();
    mock.state.instances.push({ id: 'i-1', label: 'plumbline-prod-db', status: 'active', power_status: 'running' });
    const port = makeOwnerPort(o, { VULTR_OBJSTORE_ID: 'sub-9' });
    const inv = await port.inventory();
    expect(inv.map((i) => i.kind).sort()).toEqual(['instance', 'object_storage']);
    const r = await runTeardown({ port, yes: true, log: () => {} });
    expect(r.failed).toEqual([]);
    expect(mock.state.instances).toHaveLength(0);
    expect(mock.state.calls.some((c) => c.method === 'DELETE' && c.path === '/object-storage/sub-9')).toBe(true);
    expect(rec.map((x) => x.op)).toEqual(['objstore.delete']);
    expect(evaluated[0]).toMatchObject({ verb: 'delete', class: 'instance', caller: 'owner', target: { id: 'i-1', resolved: true } });
  });
  it('a resource outside the plumbline scope is not in the inventory and so never deleted', async () => {
    const { o, mock } = ctx();
    mock.state.instances.push({ id: 'i-2', label: 'someone-elses-vm', status: 'active' });
    expect(await makeOwnerPort(o, {}).inventory()).toEqual([]);
  });
});

// Compile-time contract: G1d's ownerContext() return value must satisfy the OwnerCtx that owner-port.ts consumes.
export const ownerContextSatisfiesPort = (c: OwnerContext): OwnerCtx => c;
