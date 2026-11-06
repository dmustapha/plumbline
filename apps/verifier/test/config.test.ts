import { describe, expect, it } from 'vitest';
import { loadVerifierConfig, loadWatchdogConfig } from '../src/config.ts';
import { assertViewOnlyKey, makeHttp, snapshot } from '../src/vultr-lite.ts';

const ENV = { PLUMBLINE_VERIFIER_KEY: 'view-key', PLUMBLINE_LEASE_SECRET: 's', PLUMBLINE_BROKER_PUBLIC_URL: 'https://broker.example/' };

describe('loadVerifierConfig', () => {
  it('loads defaults and trims a trailing slash', () => {
    expect(loadVerifierConfig(ENV)).toMatchObject({ pollGapMs: 3000, leaseMaxTtlS: 120, brokerPublicUrl: 'https://broker.example', ledgerExportPath: '/v1/ledger/export', watchdogUid: null, port: 8081 });
  });
  it('refuses the watchdog key and the owner key (D-R6a)', () => {
    expect(() => loadVerifierConfig({ ...ENV, PLUMBLINE_WATCHDOG_KEY: 'k' })).toThrow('BOOT_REFUSED');
    expect(() => loadVerifierConfig({ ...ENV, VULTR_API_KEY: 'k' })).toThrow('BOOT_REFUSED');
  });
  it('refuses a missing view key or lease secret', () => {
    expect(() => loadVerifierConfig({ ...ENV, PLUMBLINE_VERIFIER_KEY: undefined })).toThrow('missing PLUMBLINE_VERIFIER_KEY');
    expect(() => loadVerifierConfig({ ...ENV, PLUMBLINE_LEASE_SECRET: '' })).toThrow('missing PLUMBLINE_LEASE_SECRET');
  });
  it('never polls faster than 3000 ms (DT-8)', () => {
    expect(() => loadVerifierConfig({ ...ENV, PLUMBLINE_POLL_GAP_MS: '2999' })).toThrow('PLUMBLINE_POLL_GAP_MS');
    expect(() => loadVerifierConfig({ ...ENV, PLUMBLINE_POLL_GAP_MS: 'abc' })).toThrow('BOOT_REFUSED');
    expect(loadVerifierConfig({ ...ENV, PLUMBLINE_POLL_GAP_MS: '6000' }).pollGapMs).toBe(6000);
  });
  it('AG4-VER-2: the lease ttl bound cannot be configured above 120 s', () => {
    expect(() => loadVerifierConfig({ ...ENV, PLUMBLINE_LEASE_MAX_TTL_S: '3600' })).toThrow('PLUMBLINE_LEASE_MAX_TTL_S');
    expect(loadVerifierConfig({ ...ENV, PLUMBLINE_LEASE_MAX_TTL_S: '60' }).leaseMaxTtlS).toBe(60);
  });
  it('an unreplaced placeholder uid fails the boot', () => {
    expect(() => loadVerifierConfig({ ...ENV, PLUMBLINE_WATCHDOG_UID: '__SET_BY_BOOTSTRAP__' })).toThrow('BOOT_REFUSED');
    expect(loadVerifierConfig({ ...ENV, PLUMBLINE_WATCHDOG_UID: '998' }).watchdogUid).toBe(998);
  });
});

describe('loadWatchdogConfig (consumed by G1c)', () => {
  const W = { PLUMBLINE_WATCHDOG_KEY: 'k', PLUMBLINE_POLICY_PUBKEY: 'p' };
  it('loads, and refuses the verifier key, the lease secret and the owner key', () => {
    expect(loadWatchdogConfig(W)).toMatchObject({ deleteKey: 'k', verifierUid: null, leaseGraceMs: 120_000, dryRun: false });
    expect(() => loadWatchdogConfig({ ...W, PLUMBLINE_VERIFIER_KEY: 'x' })).toThrow('BOOT_REFUSED');
    expect(() => loadWatchdogConfig({ ...W, PLUMBLINE_LEASE_SECRET: 'x' })).toThrow('BOOT_REFUSED');
    expect(() => loadWatchdogConfig({ ...W, VULTR_API_KEY: 'x' })).toThrow('BOOT_REFUSED');
  });
});

const acctFetch = (status: number, body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
const withAcls = (acls: unknown) => makeHttp('k', acctFetch(200, { account: { acls } }));

describe('AG4-VER-7: assertViewOnlyKey reads the key ACLs and refuses over-scope', () => {
  it('accepts subscriptions_view, and billing at most', async () => {
    expect(await assertViewOnlyKey(withAcls(['subscriptions_view']))).toEqual(['subscriptions_view']);
    expect(await assertViewOnlyKey(withAcls(['subscriptions_view', 'billing']))).toEqual(['subscriptions_view', 'billing']);
  });
  it('refuses the watchdog key (provisioning, firewall) and an owner-style key', async () => {
    await expect(assertViewOnlyKey(withAcls(['provisioning', 'firewall']))).rejects.toThrow(/over-scoped.*provisioning,firewall/);
    await expect(assertViewOnlyKey(withAcls(['subscriptions_view', 'provisioning']))).rejects.toThrow('over-scoped');
    await expect(assertViewOnlyKey(withAcls(['manage_users', 'subscriptions', 'subscriptions_view']))).rejects.toThrow('manage_users');
  });
  it('refuses a key with no view ACL, no acls array, or an unreadable account (fail closed)', async () => {
    await expect(assertViewOnlyKey(withAcls(['billing']))).rejects.toThrow('lacks subscriptions_view');
    await expect(assertViewOnlyKey(withAcls([]))).rejects.toThrow('lacks subscriptions_view');
    await expect(assertViewOnlyKey(withAcls('all'))).rejects.toThrow('BOOT_REFUSED');
    await expect(assertViewOnlyKey(makeHttp('k', acctFetch(403, { error: 'forbidden' })))).rejects.toThrow('BOOT_REFUSED');
  });
  it('issues exactly one GET, never a write', async () => {
    const calls: string[] = [];
    const f = (async (u: string, init?: RequestInit) => { calls.push(`${init?.method} ${new URL(u).pathname}`); return new Response(JSON.stringify({ account: { acls: ['subscriptions_view'] } })); }) as unknown as typeof fetch;
    await assertViewOnlyKey(makeHttp('k', f));
    expect(calls).toEqual(['GET /v2/account']);
  });
});

describe('snapshot', () => {
  const route = (map: Record<string, unknown>): typeof fetch => (async (u: string) => {
    const path = new URL(u).pathname.replace('/v2', '');
    return path in map ? new Response(JSON.stringify(map[path])) : new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  const full = {
    '/instances': { instances: [{ id: 'i1', label: 'plumbline-prod-db', status: 'active', power_status: 'running', plan: 'vc2-1c-1gb', region: 'ewr', os: 'Debian 12 x64 (bookworm)' }] },
    '/vpcs': { vpcs: [{ id: 'v1', description: 'plumbline-s0a1b2c3d-play', region: 'ewr' }] },
    '/registries': { registries: [{ id: 'r1', name: 'plumblinereg', region: 'ewr' }] },
  };
  it('lists instances (with power_status and os), VPCs and registries; at is the poll start', async () => {
    const s = await snapshot(makeHttp('k', route(full)), () => 42);
    expect(s).toMatchObject({ ok: true, at: 42 });
    if (!s.ok) throw new Error('x');
    expect(s.live).toEqual([
      { id: 'i1', class: 'instance', label: 'plumbline-prod-db', status: 'active', power_status: 'running', plan: 'vc2-1c-1gb', region: 'ewr', os: 'Debian 12 x64 (bookworm)' },
      { id: 'v1', class: 'vpc', label: 'plumbline-s0a1b2c3d-play', status: 'active', power_status: '', plan: '', region: 'ewr', os: '' },
      { id: 'r1', class: 'registry', label: 'plumblinereg', status: 'active', power_status: '', plan: 'start_up', region: 'ewr', os: '' },
    ]);
  });
  it('an error on any list is a failed snapshot, not a short list', async () => {
    const s = await snapshot(makeHttp('k', route({ ...full, '/vpcs': undefined as never })), () => 1);
    expect(s.ok).toBe(false);
  });
  it('a second page of instances is an error (never a silently truncated list)', async () => {
    const s = await snapshot(makeHttp('k', route({ ...full, '/instances': { instances: [], meta: { links: { next: 'abc' } } } })), () => 1);
    expect(s).toMatchObject({ ok: false });
    if (s.ok) throw new Error('x');
    expect(s.error).toContain('LIST_TRUNCATED');
  });
});

// LIVE FINDING 2026-11-06: a view-only key answers 403 on GET /account, so the ACL list is unreadable; the check falls back to status codes.
const routed = (table: Record<string, number>): typeof fetch => (async (url: string | URL | Request) => {
  const path = new URL(String(url)).pathname.replace(/^\/v2/, '');
  return new Response(JSON.stringify({ instances: [], vpcs: [], meta: { links: { next: '' } } }), { status: table[path] ?? 403 });
}) as typeof fetch;
describe('LIVE: behavioral ACL check when /account is 403', () => {
  it('accepts a key that lists instances and VPCs but is forbidden everywhere else', async () => {
    await expect(assertViewOnlyKey(makeHttp('k', routed({ '/instances': 200, '/vpcs': 200 })))).resolves.toEqual(['subscriptions_view']);
  });
  it('refuses an over-scoped key (firewalls readable), and a key that cannot list instances', async () => {
    await expect(assertViewOnlyKey(makeHttp('k', routed({ '/instances': 200, '/vpcs': 200, '/firewalls': 200 })))).rejects.toThrow(/over-scoped: GET \/firewalls answered 200/);
    await expect(assertViewOnlyKey(makeHttp('k', routed({ '/vpcs': 200 })))).rejects.toThrow(/must be able to GET \/instances/);
  });
});
