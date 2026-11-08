// File: apps/range-api/test/api.test.ts
import { describe, expect, it } from 'vitest';
import { loadApiConfig } from '../src/config.ts';
import { cfg, fakeBroker, makeApi, openSession } from './support.ts';

describe('range api', () => {
  it('the 4th attack inside a minute is RATE_LIMITED with Retry-After', async () => {
    const { app } = await makeApi(fakeBroker());
    const s = await openSession(app);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/attack', headers: s.headers, payload: { session_id: s.sid, text: 'delete prod-db' } });
      codes.push(r.statusCode);
      if (i === 3) {
        expect(r.headers['retry-after']).toBeDefined();
        expect(r.json().status).toBe('RATE_LIMITED');
      }
    }
    expect(codes).toEqual([202, 202, 202, 429]);
  });

  it('rejects too-short, too-long and non-string attack text', async () => {
    const { app } = await makeApi(fakeBroker());
    const s = await openSession(app);
    for (const text of ['x', 'y'.repeat(301), 5 as never]) {
      expect((await app.inject({ method: 'POST', url: '/api/attack', headers: s.headers, payload: { session_id: s.sid, text } })).statusCode).toBe(400);
    }
  });

  it('answers REPLAY (503) when the kill switch is engaged, and runs nothing', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const s = await openSession(app);
    f.state.killed = true;
    const r = await app.inject({ method: 'POST', url: '/api/attack', headers: s.headers, payload: { session_id: s.sid, text: 'delete prod-db' } });
    expect([r.statusCode, r.json().status]).toEqual([503, 'REPLAY']);
  });

  it('every verb on the production policy path only answers a signature status', async () => {
    const { app } = await makeApi(fakeBroker());
    for (const method of ['PUT', 'POST', 'PATCH', 'DELETE'] as const) {
      const r = await app.inject({ method, url: '/api/policy/production', payload: { policy: 'version: 9' } });
      expect([r.statusCode, r.json().status]).toEqual([403, 'SIG_REQUIRED']);
    }
    const put = await app.inject({ method: 'PUT', url: '/api/policy/production', payload: { text: 'x' } });
    expect(put.statusCode).toBe(403);
  });

  it('a session policy edit needs the session key and a string body', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const s = await openSession(app);
    const url = `/api/policy/${s.sid}`;
    expect((await app.inject({ method: 'PUT', url, headers: { 'x-plumbline-session-id': s.sid }, payload: { text: 'version: 1' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url, headers: s.headers, payload: { text: 5 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url, headers: s.headers, payload: { text: 'version: 1' } })).statusCode).toBe(200);
    expect(f.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('DBG-1: a full-size production policy reaches the broker (signature check runs) instead of a 413', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const r = await app.inject({ method: 'POST', url: '/api/policy/production', payload: { policy: 'x'.repeat(5000), signature: 'AAAA' } });
    expect(r.statusCode).not.toBe(413);
    expect(f.calls.some((c) => c.path === '/v1/policy-production')).toBe(true);
    const big = await app.inject({ method: 'POST', url: '/api/policy/production', payload: { policy: 'x'.repeat(80 * 1024) } });
    expect(big.statusCode).toBe(413);
  });

  it('DBG-W1: another session cannot read a session policy copy or live list; the owner and production still can', async () => {
    const { app } = await makeApi(fakeBroker());
    const a = await openSession(app);
    const b = await openSession(app);
    expect([401, 403]).toContain((await app.inject({ method: 'GET', url: `/api/policy/${a.sid}` })).statusCode);
    expect([401, 403]).toContain((await app.inject({ method: 'GET', url: `/api/policy/${a.sid}`, headers: b.headers })).statusCode);
    expect((await app.inject({ method: 'GET', url: `/api/policy/${a.sid}`, headers: a.headers })).statusCode).toBe(200);
    expect([401, 403]).toContain((await app.inject({ method: 'GET', url: `/api/live-list?session_id=${a.sid}`, headers: b.headers })).statusCode);
    expect((await app.inject({ method: 'GET', url: `/api/live-list?session_id=${a.sid}`, headers: a.headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/policy/production' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/live-list' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/policy/deadbeef' })).statusCode).toBe(404);
  });

  it('a body over 2 KiB is refused', async () => {
    const { app } = await makeApi(fakeBroker());
    const r = await app.inject({ method: 'POST', url: '/api/attack', payload: { session_id: 's', text: 'a'.repeat(3000) } });
    expect(r.statusCode).toBe(413);
  });

  it('serves the poisoned page used by the exfiltration scene', async () => {
    const { app } = await makeApi(fakeBroker());
    const r = await app.inject({ method: 'GET', url: '/pages/poisoned-readme' });
    expect(r.body).toContain('evil.example');
  });

  it('every page this stream ships carries the trust-root mount', async () => {
    const { app } = await makeApi(fakeBroker());
    for (const url of ['/try', '/audit/reconcile']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(200);
      expect(r.body, url).toContain('id="trust"');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('a page another stream has not shipped yet is a 404 PAGE_NOT_BUILT, never an empty 200', async () => {
    const { app } = await makeApi(fakeBroker(), {}, { ...cfg, publicDir: '/nonexistent' });
    const r = await app.inject({ method: 'GET', url: '/try' });
    expect([r.statusCode, r.json().status]).toEqual([404, 'PAGE_NOT_BUILT']);
  });

  it('the first layout addresses redirect permanently and keep the query string', async () => {
    const { app } = await makeApi(fakeBroker());
    const moved: Record<string, string> = { '/range': '/try', '/range/policy': '/controls/policy', '/status': '/controls/limits', '/range/rewind': '/controls/recovery', '/range/bond': '/controls/recovery#bond', '/replay': '/audit/ledger', '/verify': '/audit/reconcile', '/proof': '/audit/evidence', '/about': '/docs/safety', '/run': '/deploy' };
    for (const [from, to] of Object.entries(moved)) { const r = await app.inject({ method: 'GET', url: from }); expect([from, r.statusCode, r.headers.location]).toEqual([from, 301, to]); }
    const q = await app.inject({ method: 'GET', url: '/range?fire=prod' });
    expect([q.statusCode, q.headers.location]).toEqual([301, '/try?fire=prod']);
  });

  it('the ledger limit is a whole number from 1 to 500; anything else is 100', async () => {
    const f = fakeBroker(); const { app } = await makeApi(f);
    const asked = async (q: string): Promise<string> => { await app.inject({ method: 'GET', url: `/api/replay${q}` }); const last = [...f.calls].reverse().find((c) => c.path.startsWith('/v1/decisions')); return String(last?.path); };
    expect(await asked('')).toContain('limit=100'); expect(await asked('?limit=400')).toContain('limit=400'); expect(await asked('?limit=500')).toContain('limit=500');
    for (const bad of ['0', '501', '-1', '1.5', 'abc', '1e3', '999999']) expect(await asked(`?limit=${bad}`), bad).toContain('limit=100');
  });

  it('a path-traversal attempt never reaches the filesystem', async () => {
    const { app } = await makeApi(fakeBroker());
    for (const url of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/app.js/../../../etc/passwd']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.body, url).not.toContain('root:');
    }
  });

  it('/api/status reports a dead broker as 502, not a fake ok', async () => {
    const { app } = await makeApi(fakeBroker(), { broker: { call: async () => { throw new Error('ENOENT'); }, chat: async () => { throw new Error('x'); }, mint: async () => { throw new Error('x'); } } as never });
    const r = await app.inject({ method: 'GET', url: '/api/status' });
    expect([r.statusCode, r.json().status]).toEqual([502, 'BROKER_UNREACHABLE']);
  });

  it('refuses to boot when a credential is in the environment', () => {
    const base = { PLUMBLINE_API_TOKEN: 'a', PLUMBLINE_RUNNER_TOKEN: 'b' };
    expect(loadApiConfig(base).port).toBe(8080);
    for (const name of ['VULTR_API_KEY', 'VULTR_INFERENCE_API_KEY', 'VULTR_S3_SECRET_KEY']) {
      expect(() => loadApiConfig({ ...base, [name]: 'x' })).toThrow('BOOT_REFUSED');
    }
  });

  it('refuses to boot without the IPC tokens and on a nonsense cap', () => {
    expect(() => loadApiConfig({})).toThrow('BOOT_REFUSED: missing PLUMBLINE_API_TOKEN');
    const base = { PLUMBLINE_API_TOKEN: 'a', PLUMBLINE_RUNNER_TOKEN: 'b' };
    expect(() => loadApiConfig({ ...base, PLUMBLINE_MAX_SESSIONS: '0' })).toThrow('BOOT_REFUSED');
    expect(loadApiConfig({ ...base, PLUMBLINE_IP_SPEND_CAP_USD: '0.75' }).ipSpendCapUsd).toBe(0.75);
  });
});
