// File: packages/vultr-adapter/test/http.test.ts
import { describe, expect, it } from 'vitest';
import { Ledger, openDb, type SpendGate } from '@plumbline/ledger';
import { SpendRefused, TierKeys, TierUnavailable, VultrError, VultrHttp, redact } from '../src/index.ts';
import { createMockVultr } from './support/mock-vultr.ts';

const ledger = (ceiling = 1.5) => new Ledger(openDb(':memory:'), { session_ceiling_usd: ceiling, global_cap_usd: 10 });

describe('VultrHttp', () => {
  it('asks the gate before any network I/O', async () => {
    const order: string[] = [];
    const gate: SpendGate = { charge: () => { order.push('charge'); return { ok: false, reason: 'session-cap-exceeded' }; } };
    const fetchImpl = (async () => { order.push('fetch'); return new Response('{}'); }) as typeof fetch;
    const http = new VultrHttp({ apiKey: 'k', gate, fetchImpl });
    await expect(http.request('GET', '/instances', { session_id: 's' })).rejects.toBeInstanceOf(SpendRefused);
    expect(order).toEqual(['charge']);
  });
  it('retries a 429 with backoff and then succeeds', async () => {
    const mock = createMockVultr({ rateLimitAfter: 0 });
    const sleeps: number[] = [];
    const http = new VultrHttp({ apiKey: 'k', gate: ledger(), fetchImpl: mock.fetch, sleep: async (ms) => { sleeps.push(ms); } });
    const res = await http.request<{ instances: unknown[] }>('GET', '/instances', { session_id: 's' });
    expect(res.instances).toEqual([]);
    expect(mock.state.calls.length).toBeGreaterThanOrEqual(2);
  });
  it('maps 403 to VultrError with the permission body', async () => {
    const mock = createMockVultr({ viewKeys: ['view'] });
    const http = new VultrHttp({ apiKey: 'view', gate: ledger(), fetchImpl: mock.fetch, sleep: async () => {} });
    const err = await http.request('POST', '/instances', { session_id: 's', body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VultrError);
    expect((err as VultrError).isPermission).toBe(true);
  });
  it('redacts secrets and never serialises the key', () => {
    expect(JSON.stringify(redact({ instance: { default_password: 'x', id: '1' } }))).not.toContain('"x"');
    const http = new VultrHttp({ apiKey: 'sk-live-123', gate: ledger() });
    expect(JSON.stringify(http)).not.toContain('sk-live-123');
  });
  it('a 401 marks the tier unavailable and there is no fallback to another key', async () => {
    const mock = createMockVultr();
    const tiers = new TierKeys({ observer: 'o', deployer: 'd', network: null, registry: null }, ledger(), mock.fetch);
    expect(tiers.availability()).toMatchObject({ observer: true, deployer: true, network: false });
    tiers.noteFailure('deployer', new VultrError(401, { error: 'Unauthorized IP address' }, null, '/instances'));
    expect(tiers.availability().deployer).toBe(false);
    expect(() => tiers.http('deployer')).toThrow(TierUnavailable);
    expect(() => tiers.http('network')).toThrow(TierUnavailable);
  });
  it('keeps requests under 20 per second', async () => {
    const mock = createMockVultr();
    const starts: number[] = [];
    const http = new VultrHttp({ apiKey: 'k', gate: ledger(), maxRps: 20, fetchImpl: (async (...a: Parameters<typeof fetch>) => { starts.push(Date.now()); return mock.fetch(...a); }) as typeof fetch });
    await Promise.all(Array.from({ length: 10 }, () => http.request('GET', '/instances', { session_id: 's' })));
    const span = (starts.at(-1) ?? 0) - (starts[0] ?? 0);
    expect(span).toBeGreaterThanOrEqual(9 * 45);
  });
});
