// File: apps/range-api/test/security-review.test.ts
// Independent security review (opus) findings H1, H3, M1, M2, M3, L1 for the public range API. Each test is named SEC-<id>.
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadApiConfig } from '../src/config.ts';
import { Coalescer, StreamGate } from '../src/rateLimit.ts';
import { SessionBook } from '../src/sessionBook.ts';
import { cfg, fakeBroker, makeApi, openSession } from './support.ts';

const two = { ...cfg, liveSessionsPerIp: 2 };
const createAs = (app: Awaited<ReturnType<typeof makeApi>>['app'], ip: string) =>
  app.inject({ method: 'POST', url: '/api/session', headers: { 'x-forwarded-for': ip }, payload: {} });

describe('SEC-H1 one address cannot hold the whole range', () => {
  it('SEC-H1 a third live session from one address is 429 SESSIONS_PER_IP_LIVE and never reaches the broker; another address is fine', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f, {}, two);
    expect((await createAs(app, '5.5.5.5')).statusCode).toBe(200);
    expect((await createAs(app, '5.5.5.5')).statusCode).toBe(200);
    const third = await createAs(app, '5.5.5.5');
    expect([third.statusCode, third.json().status]).toEqual([429, 'SESSIONS_PER_IP_LIVE']);
    expect(f.state.created).toHaveLength(2);
    expect((await createAs(app, '6.6.6.6')).statusCode).toBe(200);
  });
  it('SEC-H1 a session the broker no longer holds stops counting', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f, {}, two);
    await createAs(app, '5.5.5.5');
    await createAs(app, '5.5.5.5');
    f.state.dead.push(f.state.created[0] as string);
    expect((await createAs(app, '5.5.5.5')).statusCode).toBe(200);
  });
  it('SEC-H1 an idle session (no attack inside the idle window) stops counting, and env-proof does not keep one alive', async () => {
    let now = 1_000_000;
    const f = fakeBroker();
    const { app } = await makeApi(f, { book: new SessionBook(undefined, () => now), clock: () => now }, two);
    const a = await openSession(app, '5.5.5.5');
    await openSession(app, '5.5.5.5');
    now += 11 * 60_000;
    await app.inject({ method: 'POST', url: '/api/env-proof', headers: a.headers, payload: {} });
    expect((await createAs(app, '5.5.5.5')).statusCode).toBe(200);
  });
  it('SEC-H1 an attack keeps a session live inside the idle window', async () => {
    let now = 1_000_000;
    const f = fakeBroker();
    const { app } = await makeApi(f, { book: new SessionBook(undefined, () => now), clock: () => now }, two);
    const a = await openSession(app, '5.5.5.5');
    const b = await openSession(app, '5.5.5.5');
    now += 9 * 60_000;
    for (const who of [a, b]) {
      const atk = await app.inject({ method: 'POST', url: '/api/attack', headers: who.headers, payload: { text: 'list my instances' } });
      expect(atk.statusCode).toBe(202);
    }
    now += 5 * 60_000;
    const third = await createAs(app, '5.5.5.5');
    expect([third.statusCode, third.json().status]).toEqual([429, 'SESSIONS_PER_IP_LIVE']);
  });
  it('SEC-H1 a session is cut off after 60 minutes whatever it does, so it cannot be kept alive for ever', async () => {
    let now = 1_000_000;
    const { app } = await makeApi(fakeBroker(), { book: new SessionBook(undefined, () => now), clock: () => now }, two);
    const a = await openSession(app, '5.5.5.5');
    now += 61 * 60_000;
    const r = await app.inject({ method: 'POST', url: '/api/env-proof', headers: a.headers, payload: {} });
    expect(r.statusCode).toBe(403);
    expect(r.json().status).toBe('SESSION_UNKNOWN');
  });
  it('SEC-H1 PLUMBLINE_LIVE_SESSIONS_PER_IP defaults to 4 and is overridable', () => {
    const base = { PLUMBLINE_API_TOKEN: 'a', PLUMBLINE_RUNNER_TOKEN: 'b' };
    expect(loadApiConfig(base).liveSessionsPerIp).toBe(4);
    expect(loadApiConfig({ ...base, PLUMBLINE_LIVE_SESSIONS_PER_IP: '5' }).liveSessionsPerIp).toBe(5);
  });
});

describe('SEC-H3 /api/live-list cannot be turned into a Vultr flood', () => {
  const liveCalls = (f: ReturnType<typeof fakeBroker>) => f.calls.filter((c) => c.path.startsWith('/v1/live-list')).length;
  it('SEC-H3 an unknown or malformed session id is 404 and the broker is not asked; system and a real session are served', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    for (const sid of ['deadbeef', 'not-a-session', '%00']) expect((await app.inject({ method: 'GET', url: `/api/live-list?session_id=${sid}` })).statusCode).toBe(404);
    expect(liveCalls(f)).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/live-list?session_id=system' })).statusCode).toBe(200);
    const s = await openSession(app);
    expect((await app.inject({ method: 'GET', url: `/api/live-list?session_id=${s.sid}`, headers: s.headers })).statusCode).toBe(200); // DBG-W1: the owner presents its key
  });
  it('SEC-H3 twenty concurrent identical requests make one broker call, and a repeat inside 3 s makes none', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const all = await Promise.all(Array.from({ length: 20 }, () => app.inject({ method: 'GET', url: '/api/live-list?session_id=system', headers: { 'x-forwarded-for': '4.4.4.4' } })));
    expect(all.every((r) => r.statusCode === 200)).toBe(true);
    expect(liveCalls(f)).toBe(1);
    await app.inject({ method: 'GET', url: '/api/live-list?session_id=system', headers: { 'x-forwarded-for': '4.4.4.4' } });
    expect(liveCalls(f)).toBe(1);
  });
  it('SEC-H3 the cache expires after 3 s', async () => {
    let now = 10_000;
    const f = fakeBroker();
    const { app } = await makeApi(f, { clock: () => now });
    await app.inject({ method: 'GET', url: '/api/live-list?session_id=system' });
    now += 3_100;
    await app.inject({ method: 'GET', url: '/api/live-list?session_id=system' });
    expect(liveCalls(f)).toBe(2);
  });
  it('SEC-H3 one address gets 30 answers a minute, then 429', async () => {
    const { app } = await makeApi(fakeBroker());
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) codes.push((await app.inject({ method: 'GET', url: '/api/live-list?session_id=system', headers: { 'x-forwarded-for': '3.3.3.3' } })).statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(30);
    expect(codes.slice(30)).toEqual([429, 429]);
    expect((await app.inject({ method: 'GET', url: '/api/live-list?session_id=system', headers: { 'x-forwarded-for': '2.2.2.2' } })).statusCode).toBe(200);
  });
  it('SEC-H3 Coalescer shares one in-flight promise and forgets a rejection', async () => {
    let n = 0;
    const c = new Coalescer<number>(1000, () => 0);
    const [a, b] = await Promise.all([c.get('k', async () => ++n), c.get('k', async () => ++n)]);
    expect([a, b, n]).toEqual([1, 1, 1]);
    await expect(c.get('bad', () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await new Promise((r) => setTimeout(r, 0));
    expect(await c.get('bad', async () => 7)).toBe(7);
  });
});

describe('SEC-M1 /api/policy/:sid only for sessions that exist', () => {
  it('SEC-M1 GET and PUT for an unknown sid are 404 and never reach the broker; production stays readable', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    for (const sid of ['zzzzzzzz', 'a'.repeat(90), 'deadbeef']) {
      expect((await app.inject({ method: 'GET', url: `/api/policy/${sid}` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'PUT', url: `/api/policy/${sid}`, payload: { text: 'x' } })).statusCode).toBe(404);
    }
    expect(f.calls.filter((c) => c.path.startsWith('/v1/policy/'))).toHaveLength(0);
    expect((await app.inject({ method: 'GET', url: '/api/policy/production' })).statusCode).toBe(200);
    expect(f.calls.filter((c) => c.path === '/v1/policy/production')).toHaveLength(1);
  });
  it('SEC-M1 an existing session reads its policy', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const s = await openSession(app);
    expect((await app.inject({ method: 'GET', url: `/api/policy/${s.sid}`, headers: s.headers })).statusCode).toBe(200); // DBG-W1: the owner presents its key
  });
});

describe('SEC-M2 env-proof shares the operator gate', () => {
  it('SEC-M2 a full in-flight gate refuses env-proof with OPERATOR_BUSY and the runner is not called', async () => {
    let ran = 0;
    const f = fakeBroker();
    const { app, deps } = await makeApi(f, { runner: { run: async () => { ran += 1; return {}; }, containers: async () => [] } as never });
    const s = await openSession(app);
    while (deps.inFlight.tryEnter());
    const r = await app.inject({ method: 'POST', url: '/api/env-proof', headers: s.headers, payload: {} });
    expect([r.statusCode, r.json().status, ran]).toEqual([503, 'OPERATOR_BUSY', 0]);
  });
});

describe('SEC-M3 the session stream needs the session key and is capped', () => {
  const listen = async (f: ReturnType<typeof fakeBroker>, config = cfg) => {
    const built = await makeApi(f, {}, config);
    await built.app.listen({ host: '127.0.0.1', port: 0 });
    return { ...built, port: (built.app.server.address() as AddressInfo).port };
  };
  const open = (port: number, headers: Record<string, string>): Promise<{ status: number; res: http.IncomingMessage; req: http.ClientRequest }> =>
    new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: `/api/stream/${headers['x-plumbline-session-id']}`, headers }, (res) => resolve({ status: res.statusCode ?? 0, res, req }));
      req.on('error', reject);
    });
  const closeAll = (...opened: { req: http.ClientRequest; res: http.IncomingMessage }[]): void => opened.forEach((o) => { o.res.destroy(); o.req.destroy(); });
  const gone = (ms = 60) => new Promise((r) => setTimeout(r, ms));

  it('SEC-M3 without the session key the stream is refused before any header is written; with it the stream opens', async () => {
    const { app, port } = await listen(fakeBroker());
    try {
      const s = await openSession(app, '127.0.0.1');
      const noKey = await app.inject({ method: 'GET', url: `/api/stream/${s.sid}` });
      expect(noKey.statusCode).toBe(401);
      const wrong = await app.inject({ method: 'GET', url: `/api/stream/${s.sid}`, headers: { 'x-plumbline-session-id': s.sid, 'x-plumbline-session-key': 'nope' } });
      expect(wrong.statusCode).toBe(403);
      const o = await open(port, { 'x-plumbline-session-id': s.sid, 'x-plumbline-session-key': s.key });
      expect([o.status, o.res.headers['content-type']]).toEqual([200, 'text/event-stream']);
      closeAll(o);
    } finally { await app.close(); }
  });
  it('SEC-M3 a cookie (what the browser EventSource sends) opens the stream too', async () => {
    const { app, port } = await listen(fakeBroker());
    try {
      const s = await openSession(app, '127.0.0.1');
      const o = await new Promise<{ status: number; res: http.IncomingMessage; req: http.ClientRequest }>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: `/api/stream/${s.sid}`, headers: { cookie: `plb_session=${s.sid}.${s.key}` } }, (res) => resolve({ status: res.statusCode ?? 0, res, req }));
        req.on('error', reject);
      });
      expect(o.status).toBe(200);
      closeAll(o);
    } finally { await app.close(); }
  });
  it('SEC-M3 a second session cannot watch the first one\'s stream', async () => {
    const { app } = await listen(fakeBroker());
    try {
      const a = await openSession(app, '127.0.0.1');
      const b = await openSession(app, '127.0.0.1');
      const r = await app.inject({ method: 'GET', url: `/api/stream/${a.sid}`, headers: { 'x-plumbline-session-id': b.sid, 'x-plumbline-session-key': b.key } });
      expect(r.statusCode).toBe(403);
    } finally { await app.close(); }
  });
  it('SEC-M3 at most 3 open streams per address; closing one frees the slot', async () => {
    const { app, port } = await listen(fakeBroker());
    try {
      const s = await openSession(app, '127.0.0.1');
      const h = { 'x-plumbline-session-id': s.sid, 'x-plumbline-session-key': s.key };
      const opened = [await open(port, h), await open(port, h), await open(port, h)];
      expect(opened.map((o) => o.status)).toEqual([200, 200, 200]);
      const fourth = await open(port, h);
      expect(fourth.status).toBe(429);
      closeAll(fourth);
      closeAll(opened[0] as (typeof opened)[number]);
      await gone();
      const again = await open(port, h);
      expect(again.status).toBe(200);
      closeAll(again, opened[1] as (typeof opened)[number], opened[2] as (typeof opened)[number]);
    } finally { await app.close(); }
  });
  it('SEC-M3 the global cap holds across addresses', async () => {
    const { app, port } = await listen(fakeBroker(), { ...cfg, maxStreams: 2 });
    try {
      const a = await openSession(app, '127.0.0.1');
      const h = { 'x-plumbline-session-id': a.sid, 'x-plumbline-session-key': a.key };
      const o1 = await open(port, { ...h, 'x-forwarded-for': '1.1.1.1' });
      const o2 = await open(port, { ...h, 'x-forwarded-for': '2.2.2.2' });
      const o3 = await open(port, { ...h, 'x-forwarded-for': '3.3.3.3' });
      expect([o1.status, o2.status, o3.status]).toEqual([200, 200, 429]);
      closeAll(o1, o2, o3);
    } finally { await app.close(); }
  });
  it('SEC-M3 StreamGate counts open and close exactly once', () => {
    const g = new StreamGate(1, 5);
    const close = g.open('ip') as () => void;
    expect(g.open('ip')).toBeNull();
    close();
    close();
    expect(g.count).toBe(0);
    expect(g.open('ip')).not.toBeNull();
  });
  it('SEC-M3 the public /replay page does not use the session stream', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync(join(cfg.publicDir, 'replay.html'), 'utf8');
    expect(html).not.toContain('/api/stream');
    expect(html).not.toContain('EventSource');
  });
});

describe('SEC-L1 /api/proof reads the evidence directory at most once per 10 s unless a file is newer', () => {
  it('SEC-L1 a cached answer is served inside 10 s, a newer mtime invalidates it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plb-evi-'));
    const file = join(dir, 'a.json');
    writeFileSync(file, '{"v":1}');
    utimesSync(file, 1000, 1000);
    let now = 50_000;
    const f = fakeBroker();
    const orig = f.broker.call;
    f.broker.call = (async (m: string, p: string, b?: unknown) => (p === '/v1/proof' ? { status: 200, json: { counts: {} } } : orig(m, p, b))) as never;
    const { app } = await makeApi(f, { clock: () => now }, { ...cfg, evidenceDir: dir });
    const read = async () => ((await app.inject({ method: 'GET', url: '/api/proof' })).json() as { evidence: Record<string, { v: number }> }).evidence['a.json']?.v;
    expect(await read()).toBe(1);
    writeFileSync(file, '{"v":2}');
    utimesSync(file, 1000, 1000);
    expect(await read()).toBe(1);
    utimesSync(file, 2000, 2000);
    expect(await read()).toBe(2);
    writeFileSync(file, '{"v":3}');
    utimesSync(file, 2000, 2000);
    now += 11_000;
    expect(await read()).toBe(3);
  });
});
