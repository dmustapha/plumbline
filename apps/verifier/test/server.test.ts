import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyExportRequest } from '../../broker/src/ledgerExport.ts';
import { loadVerifierConfig } from '../src/config.ts';
import { leaseSignature } from '../src/lease.ts';
import { readPin } from '../src/sharedFiles.ts';
import { buildVerifier } from '../src/verifierServer.ts';
import { makeHttp, type LiveResource } from '../src/vultr-lite.ts';
import { BASELINE, FLOOR, Fixture, INFRA, T, healthy, live } from './support.ts';

const SECRET = 'lease-secret';

function raw(l: LiveResource): Record<string, unknown> {
  return l.class === 'instance'
    ? { id: l.id, label: l.label, status: l.status, power_status: l.power_status, plan: l.plan, region: l.region, os: l.os }
    : l.class === 'vpc' ? { id: l.id, description: l.label, region: l.region } : { id: l.id, name: l.label, region: l.region };
}

function harness(f: Fixture = healthy(), over: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'plb-ver-'));
  const baselinePath = join(dir, 'baseline.json');
  writeFileSync(baselinePath, JSON.stringify({ resources: BASELINE }));
  const config = loadVerifierConfig({
    PLUMBLINE_VERIFIER_KEY: 'view', PLUMBLINE_LEASE_SECRET: SECRET, PLUMBLINE_BROKER_PUBLIC_URL: 'https://broker.test',
    PLUMBLINE_SHARED_DIR: join(dir, 'shared'), PLUMBLINE_STATE_DIR: join(dir, 'state'), PLUMBLINE_BASELINE_PATH: baselinePath, ...over,
  });
  const h = {
    dir, config, fixture: f, now: T, live: [...INFRA] as LiveResource[], calls: [] as string[], sleeps: [] as number[], exportHeaders: [] as Record<string, string>[],
    brokerStatus: 200, brokerBody: null as unknown, release: null as (() => void) | null, gate: null as Promise<void> | null,
  };
  const vultr = (async (u: string) => {
    const path = new URL(u).pathname.replace('/v2', '');
    const key = path.slice(1) as 'instances' | 'vpcs' | 'registries';
    const cls = { instances: 'instance', vpcs: 'vpc', registries: 'registry' }[key];
    h.calls.push(`list:${key}`);
    return new Response(JSON.stringify({ [key]: h.live.filter((l) => l.class === cls).map(raw) }));
  }) as unknown as typeof fetch;
  const broker = (async (_u: string, init: RequestInit) => {
    h.calls.push('export');
    h.exportHeaders.push(init.headers as Record<string, string>);
    if (h.brokerStatus !== 200) return new Response('x', { status: h.brokerStatus });
    return new Response(JSON.stringify(h.brokerBody ?? h.fixture.export(h.now)));
  }) as unknown as typeof fetch;
  const sleep = async (ms: number): Promise<void> => {
    h.sleeps.push(ms);
    if (h.gate) await h.gate;
    h.now += ms;
  };
  const v = buildVerifier({ config, http: makeHttp('view', vultr), floor: { floor: FLOOR }, fetchImpl: broker, sleep, clock: () => h.now, host: 'vm2' });
  return Object.assign(h, v);
}
const run = (h: ReturnType<typeof harness>) => h.app.inject({ method: 'POST', url: '/api/verify/run' });

describe('verifier server', () => {
  it('GET /api/verify before any run is DEGRADED, with CORS for the verify page', async () => {
    const h = harness();
    const res = await h.app.inject({ url: '/api/verify' });
    expect(res.json()).toMatchObject({ status: 'DEGRADED', codes: ['RECONCILE_DEGRADED'], detail: 'no run yet; press Run verify' });
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('a run is GREEN, polls twice 3 s apart and fetches the export AFTER both live lists (AG4-PRD-7)', async () => {
    const h = harness();
    const res = await run(h);
    expect(res.json()).toMatchObject({ status: 'GREEN', polled_twice: true, verifier_host: 'vm2' });
    expect(h.sleeps).toEqual([3000]);
    expect(h.calls.filter((c) => c === 'export')).toHaveLength(1);
    expect(h.calls.indexOf('export')).toBe(h.calls.length - 1);
    expect(h.calls.slice(0, 3).sort()).toEqual(['list:instances', 'list:registries', 'list:vpcs']);
    expect((await h.app.inject({ url: '/api/verify' })).json()).toMatchObject({ status: 'GREEN' });
  });

  it('STRESS DH-8: a GREEN older than five minutes is served as STALE (last_status GREEN), a fresh one is GREEN with its age, and a new run restores GREEN', async () => {
    const h = harness();
    await run(h);
    const fresh = (await h.app.inject({ url: '/api/verify' })).json();
    expect(fresh).toMatchObject({ status: 'GREEN', age_s: 0 });
    h.now += 299_000;
    expect((await h.app.inject({ url: '/api/verify' })).json()).toMatchObject({ status: 'GREEN', age_s: 299 });
    h.now += 2_000;
    const old = (await h.app.inject({ url: '/api/verify' })).json();
    expect(old).toMatchObject({ status: 'STALE', last_status: 'GREEN', stale: true, age_s: 301 });
    expect(old.status).not.toBe('GREEN');
    const again = (await run(h)).json();
    expect(again.status).toBe('GREEN');
    expect((await h.app.inject({ url: '/api/verify' })).json()).toMatchObject({ status: 'GREEN', age_s: 0 });
  });

  it('STRESS DH-8: an old RED is never softened into STALE; it stays RED and is marked stale', async () => {
    const h = harness();
    h.live.push({ id: 'oob-1', class: 'instance', label: 'rogue-box', status: 'active', power_status: 'running', plan: 'vc2-1c-1gb', region: 'ewr', os: 'x' } as LiveResource);
    const red = (await run(h)).json();
    expect(red.status).toBe('RED');
    h.now += 600_000;
    expect((await h.app.inject({ url: '/api/verify' })).json()).toMatchObject({ status: 'RED', stale: true });
  });

  it('signs the export request exactly as the broker verifies it (F5 section 2)', async () => {
    const h = harness();
    await run(h);
    const hd = h.exportHeaders[0]!;
    expect(verifyExportRequest(SECRET, hd['x-plumbline-ts'], hd['x-plumbline-sig'], h.now)).toBe(true);
  });

  it('writes last-verify.json mode 0640 into the shared dir', async () => {
    const h = harness();
    await run(h);
    const f = join(h.config.sharedDir, 'last-verify.json');
    expect(JSON.parse(readFileSync(f, 'utf8')).status).toBe('GREEN');
    expect(statSync(f).mode & 0o777).toBe(0o640);
  });

  it('RED names the out-of-band instance; the card shows the host\'s own read of prod-db (E-2)', async () => {
    const h = harness();
    h.live.push(live({ id: 'i-rogue', label: 'oops' }), { ...INFRA[0]!, power_status: 'stopped' });
    h.live = h.live.filter((l, i) => !(l.id === 'i-prod' && i < 3));
    const body = (await run(h)).json();
    expect(body.status).toBe('RED');
    expect(body.codes).toEqual(expect.arrayContaining(['RECONCILE_RED_UNLOGGED', 'RECONCILE_RED_PROTECTED_CHANGED']));
    expect(body.findings.map((x: { resource_id: string }) => x.resource_id)).toContain('i-rogue');
    expect(body.prod_db).toMatchObject({ found: true, power_status: 'stopped', read_by: 'vm2' });
  });

  it('rate limits: 429 inside 5 s, 409 while a run is in flight', async () => {
    const h = harness();
    expect((await run(h)).statusCode).toBe(200);
    const again = await run(h);
    expect(again.statusCode).toBe(429);
    expect(again.headers['retry-after']).toBe('5');
    h.now += 6000;
    let open!: () => void;
    h.gate = new Promise<void>((r) => { open = r; });
    const first = run(h);
    await new Promise((r) => setTimeout(r, 400));
    expect((await run(h)).statusCode).toBe(409);
    h.gate = null;
    open();
    expect((await first).statusCode).toBe(200);
  });

  it('a broker error, a wrong schema or a missing baseline is DEGRADED, never GREEN', async () => {
    const h = harness();
    h.brokerStatus = 500;
    expect((await run(h)).json()).toMatchObject({ status: 'DEGRADED' });
    const h2 = harness();
    h2.brokerBody = { schema: 'other' };
    expect((await run(h2)).json().findings[0].detail).toContain('unexpected schema');
    const h3 = harness(undefined, { PLUMBLINE_BASELINE_PATH: '/nonexistent/baseline.json' });
    expect((await run(h3)).json()).toMatchObject({ status: 'DEGRADED' });
  });

  it('AG4-VER-1: persists the verified head; history that later changes is RED_LEDGER_TAMPERED, honest growth is GREEN', async () => {
    const h = harness();
    expect((await run(h)).json().status).toBe('GREEN');
    expect(readPin(h.config.stateDir)).toMatchObject({ seq: 1 });
    h.fixture.worker('i-wk');
    h.live.push(live({ id: 'i-wk', label: 'plumbline-wk-1' }));
    h.now += 10_000;
    h.fixture.clock = T - 100_000;
    expect((await run(h)).json().status).toBe('GREEN');
    expect(readPin(h.config.stateDir)?.seq).toBe(2);
    const rewritten = new Fixture();
    rewritten.clock = T - 400_000;
    rewritten.create('r-reg', 'registry', { label: 'plumblinereg', name: 'plumblinereg', region: 'ewr' }, { session: 'someone-else' });
    h.brokerBody = rewritten.export(h.now + 20_000);
    h.now += 20_000;
    const red = (await run(h)).json();
    expect(red).toMatchObject({ status: 'RED', codes: ['RECONCILE_RED_LEDGER_TAMPERED'] });
  });
});

describe('AG4-VER-4: the watchdog destroy log (server side)', () => {
  const gone = () => {
    const f = healthy();
    f.clock = T - 100_000;
    f.worker('i-gone');
    return harness(f);
  };
  const log = (h: ReturnType<typeof harness>, mode: number) => {
    const file = join(h.config.sharedDir, 'watchdog-actions.jsonl');
    writeFileSync(file, `${JSON.stringify({ act: 'destroyed', id: 'i-gone', ts: T - 50_000 })}\n`);
    chmodSync(file, mode);
  };
  it('an owned, non-world-writable log excuses the missing resource', async () => {
    const h = gone();
    log(h, 0o644);
    expect((await run(h)).json().status).toBe('GREEN');
  });
  it('a world-writable log is ignored wholesale, and the report says so', async () => {
    const h = gone();
    log(h, 0o666);
    const body = (await run(h)).json();
    expect(body.codes).toEqual(['RECONCILE_RED_MISSING']);
    expect(body.notes.join(' ')).toContain('world-writable');
  });
  it('a log owned by the wrong uid is ignored when the watchdog uid is configured', async () => {
    const f = healthy();
    f.clock = T - 100_000;
    f.worker('i-gone');
    const h = harness(f, { PLUMBLINE_WATCHDOG_UID: String(process.getuid!() + 1) });
    log(h, 0o644);
    expect((await run(h)).json().notes.join(' ')).toContain('expected the watchdog uid');
  });
});

describe('POST /lease/renew (F5 section 1)', () => {
  const post = (h: ReturnType<typeof harness>, ts: number, nonce: string, ttl: number, sig?: string) =>
    h.app.inject({ method: 'POST', url: '/lease/renew', payload: { ts, nonce, ttl_s: ttl }, headers: { 'x-plumbline-sig': sig ?? leaseSignature(SECRET, ts, nonce, ttl) } });

  it('accepts a signed heartbeat; /healthz then reports the lease ALIVE and lease.json exists', async () => {
    const h = harness();
    expect((await post(h, h.now, 'nonce0001', 120)).json()).toEqual({ ok: true });
    expect(existsSync(join(h.config.sharedDir, 'lease.json'))).toBe(true);
    expect((await h.app.inject({ url: '/healthz' })).json()).toEqual({ ok: true, lease: 'ALIVE' });
  });
  it('401 for a bad signature or replay, 400 for an oversized ttl or a malformed body', async () => {
    const h = harness();
    expect((await post(h, h.now, 'nonce0002', 5, 'bad')).statusCode).toBe(401);
    expect((await post(h, h.now, 'nonce0003', 3_000_000)).json()).toEqual({ ok: false, why: 'ttl-too-large' });
    expect((await post(h, h.now, 'nonce0004', 5)).statusCode).toBe(200);
    expect((await post(h, h.now + 1, 'nonce0004', 5)).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'POST', url: '/lease/renew', payload: { ts: 'x' }, headers: { 'x-plumbline-sig': 'a' } })).statusCode).toBe(400);
  });
  it('/healthz before any heartbeat is NEVER inside the grace and LAPSED after it (AG4-VER-3)', async () => {
    const h = harness();
    expect((await h.app.inject({ url: '/healthz' })).json().lease).toBe('NEVER');
    h.now += 121_000;
    expect((await h.app.inject({ url: '/healthz' })).json().lease).toBe('LAPSED');
  });
  it('serves /api/watchdog from the shared status file, UNKNOWN when absent', async () => {
    const h = harness();
    expect((await h.app.inject({ url: '/api/watchdog' })).json()).toEqual({ status: 'UNKNOWN' });
    writeFileSync(join(h.config.sharedDir, 'watchdog-status.json'), JSON.stringify({ status: 'ARMED' }));
    expect((await h.app.inject({ url: '/api/watchdog' })).json()).toEqual({ status: 'ARMED' });
  });
});
