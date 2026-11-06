import { beforeEach, describe, expect, it } from 'vitest';
import { Ledger, openDb, type SpendGate } from '@plumbline/ledger';
import {
  OutcomeUnknown, TierKeys, VsiClient, VultrError, VultrHttp, mintOwnerAction, OwnerAdmin, resetSharedLimiter,
} from '../src/index.ts';
import { createMockVultr } from './support/mock-vultr.ts';

const ledger = (ceiling = 1.5) => new Ledger(openDb(':memory:'), { session_ceiling_usd: ceiling, global_cap_usd: 10 });
const owner = (op: Parameters<typeof mintOwnerAction>[0]) => mintOwnerAction(op, 'test', () => {});

beforeEach(() => resetSharedLimiter());

describe('AG4-ADP-1 secrets are redacted for logs and errors, never from the caller', () => {
  it.each(['top-level', 'nested'] as const)('AG4-ADP-1 issueKey returns a usable key (%s)', async (shape) => {
    const mock = createMockVultr({ apiKeyShape: shape });
    const http = new VultrHttp({ apiKey: 'owner', gate: ledger(), fetchImpl: mock.fetch, sleep: async () => {} });
    const key = await new OwnerAdmin(http).issueKey(owner('user.issue_key'), 'u-1', 'deployer', '2030-01-01T00:00:00Z');
    expect(key.api_key).toMatch(/^REAL-KEY-/);
    expect(key.api_key).not.toBe('[redacted]');
  });
  it('AG4-ADP-1 a VultrError body is still redacted', async () => {
    const f = (async () => new Response(JSON.stringify({ error: 'x', api_key: 'LEAK' }), { status: 400 })) as typeof fetch;
    const http = new VultrHttp({ apiKey: 'k', gate: ledger(), fetchImpl: f, sleep: async () => {} });
    const e = (await http.request('POST', '/x', { session_id: 's' }).catch((x: unknown) => x)) as VultrError;
    expect(JSON.stringify(e.body)).not.toContain('LEAK');
  });
});

describe('AG4-ADP-4 one process-wide limiter', () => {
  it('AG4-ADP-4 two instances share one 20 req/s budget', async () => {
    const mock = createMockVultr();
    const starts: number[] = [];
    const fetchImpl = (async (...a: Parameters<typeof fetch>) => { starts.push(Date.now()); return mock.fetch(...a); }) as typeof fetch;
    const a = new VultrHttp({ apiKey: 'a', gate: ledger(), fetchImpl });
    const b = new VultrHttp({ apiKey: 'b', gate: ledger(), fetchImpl });
    await Promise.all([
      ...Array.from({ length: 5 }, () => a.request('GET', '/instances', { session_id: 's' })),
      ...Array.from({ length: 5 }, () => b.request('GET', '/instances', { session_id: 's' })),
    ]);
    expect((starts.at(-1) ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(9 * 45);
  });
  it('AG4-ADP-4 a caller cannot raise the rate above 20 req/s', async () => {
    const mock = createMockVultr();
    const starts: number[] = [];
    const fetchImpl = (async (...a: Parameters<typeof fetch>) => { starts.push(Date.now()); return mock.fetch(...a); }) as typeof fetch;
    const h = new VultrHttp({ apiKey: 'a', gate: ledger(), fetchImpl, maxRps: 1000 });
    await Promise.all(Array.from({ length: 6 }, () => h.request('GET', '/instances', { session_id: 's' })));
    expect((starts.at(-1) ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(5 * 45);
  });
});

describe('AG4-ADP-5 reservations are always settled or released', () => {
  const abort = (): Error => Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  it('AG4-ADP-5 a GET that fails on the network releases its reservation', async () => {
    const l = ledger();
    const http = new VultrHttp({ apiKey: 'k', gate: l, fetchImpl: (async () => { throw abort(); }) as typeof fetch, sleep: async () => {} });
    await expect(http.request('GET', '/instances', { session_id: 's', costUsd: 0.5 })).rejects.toThrow();
    expect(l.sessionSpend('s')).toBe(0);
  });
  it('AG4-ADP-5 a body-read failure releases the reservation', async () => {
    const l = ledger();
    const f = (async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => { throw new Error('reset'); } })) as unknown as typeof fetch;
    const http = new VultrHttp({ apiKey: 'k', gate: l, fetchImpl: f, sleep: async () => {} });
    await expect(http.request('GET', '/instances', { session_id: 's', costUsd: 0.5 })).rejects.toThrow();
    expect(l.sessionSpend('s')).toBe(0);
  });
  it('AG4-ADP-5 a create that times out is an UNKNOWN outcome carrying request_id, cost stays reserved', async () => {
    const l = ledger();
    const seen: OutcomeUnknown[] = [];
    const http = new VultrHttp({
      apiKey: 'k', gate: l, fetchImpl: (async () => { throw abort(); }) as typeof fetch, sleep: async () => {}, onUnknown: (u) => seen.push(u),
    });
    const e = await http.request('POST', '/instances', { session_id: 's', request_id: 'req-9', costUsd: 0.007 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(OutcomeUnknown);
    expect((e as OutcomeUnknown).request_id).toBe('req-9');
    expect((e as OutcomeUnknown).method).toBe('POST');
    expect(seen).toHaveLength(1);
    expect(l.sessionSpend('s')).toBe(0.007);
  });
  it('AG4-ADP-5 a definite 4xx releases the reservation', async () => {
    const l = ledger();
    const http = new VultrHttp({ apiKey: 'k', gate: l, fetchImpl: (async () => new Response('{}', { status: 400 })) as typeof fetch, sleep: async () => {} });
    await expect(http.request('POST', '/instances', { session_id: 's', request_id: 'r', costUsd: 0.2 })).rejects.toBeInstanceOf(VultrError);
    expect(l.sessionSpend('s')).toBe(0);
  });
  const countingGate = () => {
    const settled: number[] = [];
    const gate: SpendGate = { charge: (kind, est) => ({ ok: true, receipt: { kind, estimate_usd: est, settle: (a) => { settled.push(a); } }, remaining_session: 9, remaining_global: 9 }) };
    return { gate, settled };
  };
  it.each([
    ['VSI_EMPTY', { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }],
    ['VSI_NO_USAGE', { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'x' } }] }],
  ])('AG4-ADP-5 VSI %s still settles the receipt', async (token, body) => {
    const { gate, settled } = countingGate();
    const vsi = new VsiClient('k', gate, (async () => new Response(JSON.stringify(body))) as typeof fetch);
    await expect(vsi.chat('s', { model: 'qwen3.8-27b', messages: [] })).rejects.toThrow(token);
    expect(settled).toHaveLength(1);
  });
  it('AG4-ADP-5 VSI network error settles the receipt', async () => {
    const { gate, settled } = countingGate();
    const vsi = new VsiClient('k', gate, (async () => { throw new Error('boom'); }) as typeof fetch);
    await expect(vsi.chat('s', { model: 'qwen3.8-27b', messages: [] })).rejects.toThrow('boom');
    expect(settled).toEqual([0]);
  });
});

describe('AG4-ADP-8 a 401 marks the tier down through the real request path', () => {
  it('AG4-ADP-8 request 401 -> availability false, no fallback', async () => {
    const mock = createMockVultr({ unauthorizedKeys: ['d'] });
    const tiers = new TierKeys({ observer: 'o', deployer: 'd', network: null, registry: null }, ledger(), mock.fetch);
    expect(tiers.availability().deployer).toBe(true);
    await expect(tiers.http('deployer').request('GET', '/instances', { session_id: 's' })).rejects.toBeInstanceOf(VultrError);
    expect(tiers.availability().deployer).toBe(false);
    expect(() => tiers.http('deployer')).toThrow('tier-key-unavailable');
    expect(tiers.availability().observer).toBe(true);
  });
  it('AG4-ADP-8 self-test passes with correctly scoped keys', async () => {
    const readOnly = (m: string) => m === 'GET';
    const mock = createMockVultr({
      acl: {
        o: readOnly,
        d: (m, p) => m === 'GET' ? !p.startsWith('/users') : p.startsWith('/instances'),
        n: (m, p) => m === 'GET' ? !p.startsWith('/users') : p.startsWith('/firewalls'),
        r: (m, p) => m === 'GET' ? !p.startsWith('/users') : p.startsWith('/registry'),
      },
    });
    const tiers = new TierKeys({ observer: 'o', deployer: 'd', network: 'n', registry: 'r' }, ledger(), mock.fetch);
    const res = await tiers.aclSelfTest('s');
    expect(res.filter((r) => !r.ok)).toEqual([]);
    expect(res.some((r) => r.tier === 'deployer' && r.call === 'POST /firewalls')).toBe(true);
    expect(res.some((r) => r.tier === 'deployer' && r.call === 'GET /users')).toBe(true);
    expect(res.some((r) => r.tier === 'network' && r.call === 'POST /instances')).toBe(true);
    expect(mock.state.instances).toHaveLength(0);
    expect(mock.state.firewall_groups).toHaveLength(0);
  });
  it('AG4-ADP-8 self-test flags an over-scoped deployer key', async () => {
    const mock = createMockVultr({ acl: { o: (m) => m === 'GET' } });
    const tiers = new TierKeys({ observer: 'o', deployer: 'd', network: null, registry: null }, ledger(), mock.fetch);
    const res = await tiers.aclSelfTest('s');
    const bad = res.filter((r) => !r.ok);
    expect(bad.some((r) => r.tier === 'deployer' && r.call === 'POST /firewalls')).toBe(true);
    expect(bad.some((r) => r.tier === 'deployer' && r.call === 'GET /users')).toBe(true);
  });
});

describe('AG4-ADP-7 objstore availability is real', () => {
  it('AG4-ADP-7 objstore is false without S3 credentials and follows S3 health', () => {
    const tiers = new TierKeys({ observer: 'o', deployer: null, network: null, registry: null }, ledger());
    expect(tiers.availability().objstore).toBe(false);
    let healthy = true;
    tiers.registerObjstore({ healthy: () => healthy });
    expect(tiers.availability().objstore).toBe(true);
    healthy = false;
    expect(tiers.availability().objstore).toBe(false);
    tiers.registerObjstore(null);
    expect(tiers.availability().objstore).toBe(false);
  });
});
