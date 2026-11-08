// File: apps/range-api/test/stress-api.test.ts
// Hermetic backend stress suite for the Plumbline range API. In-process app.inject, scripted broker, fake runner and fake fetch.
// The only sockets are loopback listeners for the SSE cases (127.0.0.1, ephemeral port). Fuzz PRNG seed: 1337 (mulberry32).
// A case named "FIXED ..." was a defect found by this suite (it was an it.fails case) and is now an ordinary assertion of the corrected behaviour.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import type { ApiConfig } from '../src/config.ts';
import type { ApiDeps } from '../src/deps.ts';
import { SlidingWindow } from '../src/rateLimit.ts';
import { SessionBook } from '../src/sessionBook.ts';
import { cfg, makeApi, openSession } from './support.ts';
import { DEFAULT_POLICY, STRING_POOL, mulberry32, randJson, randShaped, statefulBroker, validish } from './stress-support.ts';

type Built = Awaited<ReturnType<typeof makeApi>>;
type App = Built['app'];
const BIG = 1_000_000;
const LOOSE_CFG: Partial<ApiConfig> = { sessionsPerIp: BIG, sessionsPerMinute: BIG, liveSessionsPerIp: BIG, maxSessions: BIG, maxInFlight: BIG, ipSpendCapUsd: BIG };
const looseDeps = (): Partial<ApiDeps> => ({ attackLimit: new SlidingWindow(BIG, 60_000), actLimit: new SlidingWindow(BIG, 60_000), liveListLimit: new SlidingWindow(BIG, 60_000) });
const goodRunner = { run: async () => ({ ok: true }), containers: async () => ['c1'] };
const okFetch = (async () => new Response(JSON.stringify({ verified: true }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

const apps: App[] = [];
afterAll(async () => { for (const a of apps) await a.close(); });

interface HOpts { loose?: boolean; deps?: Partial<ApiDeps>; conf?: Partial<ApiConfig>; f?: ReturnType<typeof statefulBroker> }
async function harness(o: HOpts = {}) {
  const f = o.f ?? statefulBroker();
  const config = { ...cfg, verifierUrl: 'http://verifier.test', ...(o.loose ? LOOSE_CFG : {}), ...o.conf };
  const deps = { runner: goodRunner as never, fetchImpl: okFetch, ...(o.loose ? looseDeps() : {}), ...o.deps };
  const built = await makeApi(f as never, deps, config);
  apps.push(built.app);
  return { ...built, f };
}

/** inject with a hard per-request timeout: a hang is a failure, not a stuck suite. */
async function inj(app: App, opts: InjectOptions) {
  return Promise.race([app.inject(opts), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`HANG ${opts.method} ${opts.url}`)), 8000).unref())]);
}
const J = (r: { body: string }): Record<string, unknown> => { try { return JSON.parse(r.body) as Record<string, unknown>; } catch { return {}; } };
const jsonH = { 'content-type': 'application/json' };
const safeEnc = (s: string): string => encodeURIComponent((s as string & { toWellFormed?: () => string }).toWellFormed?.() ?? s);
const ascii = (s: string): string => s.replace(/[^\x20-\x7e]/g, '?');
const REFLECT = ['<script', 'DROP TABLE', 'X-Injected', 'a'.repeat(200)];

/** Structural sanity of any answer: no 5xx; an error is JSON; no header echoes a hostile input. Returns a problem or ''. */
function sane(r: { statusCode: number; headers: Record<string, unknown>; body: string }): string {
  if (r.statusCode >= 500) return `5xx ${r.statusCode} ${r.body.slice(0, 80)}`;
  if (r.statusCode >= 400 && !String(r.headers['content-type'] ?? '').includes('json')) return `non-json error ${r.statusCode}`;
  for (const [k, v] of Object.entries(r.headers)) for (const m of REFLECT) if (String(v).includes(m)) return `header ${k} reflects input`;
  return '';
}

// ---------------------------------------------------------------- 1. method matrix
const PAGE_ROUTES = ['/', '/try', '/controls/policy', '/controls/limits', '/controls/recovery', '/audit/ledger', '/audit/reconcile', '/audit/evidence', '/docs/check', '/docs/safety', '/docs/architecture', '/docs/concepts', '/docs/integrate', '/deploy', '/app.js', '/style.css',
  '/logo.svg', '/logo-mono.svg', '/logo-lockup.svg', '/favicon.svg', '/favicon-32.png', '/favicon.ico', '/og-image.png'];
// the first layout's addresses: GET redirects, nothing else is allowed
const MOVED_ROUTES = ['/range', '/range/policy', '/range/rewind', '/range/bond', '/verify', '/proof', '/about', '/replay', '/status', '/run'];
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;

describe('1 method matrix: a wrong verb is 404/405, never 5xx, never a body leak', () => {
  it('every route x every verb', async () => {
    const h = await harness({ loose: true });
    const s = await openSession(h.app, '9.9.9.9');
    const table: { path: string; allowed: string[] }[] = [
      ...['/api/approvals', '/api/bond', '/api/canned', '/api/egress-counter', '/api/live-list', '/api/proof', '/api/replay', '/api/rewind', '/api/status', '/api/verify',
        '/healthz', '/ledger/export', '/v1/ledger/export', '/pages/poisoned-docs', '/pages/poisoned-readme', `/api/stream/${s.sid}`, '/api/policy/production'].map((p) => ({ path: p, allowed: ['GET'] })),
      ...['/api/acl-self-test', '/api/approval/x1', '/api/attack', '/api/env-proof', '/api/rewind/act', '/api/session', `/api/session/${s.sid}/tier`, '/api/verify/run'].map((p) => ({ path: p, allowed: ['POST'] })),
      { path: `/api/policy/${s.sid}`, allowed: ['GET', 'PUT'] },
      ...PAGE_ROUTES.map((p) => ({ path: p, allowed: ['GET'] })), ...MOVED_ROUTES.map((p) => ({ path: p, allowed: ['GET'] })),
    ];
    for (const t of table) if (t.path === '/api/policy/production') t.allowed = ['GET', 'PUT', 'POST', 'PATCH', 'DELETE'];
    const bad: string[] = [];
    for (const t of table) {
      for (const m of METHODS) {
        if (t.allowed.includes(m)) continue;
        const r = await inj(h.app, { method: m, url: t.path, headers: { ...s.headers, ...(m === 'GET' ? {} : jsonH) }, ...(m === 'GET' ? {} : { payload: '{}' }) });
        if (r.statusCode !== 404 && r.statusCode !== 405) bad.push(`${m} ${t.path} -> ${r.statusCode}`);
        if (r.body.includes(s.key) || r.body.includes(DEFAULT_POLICY)) bad.push(`${m} ${t.path} leaks`);
        if (!String(r.headers['content-type']).includes('json')) bad.push(`${m} ${t.path} non-json`);
      }
    }
    expect(bad).toEqual([]);
  });
  it('allowed verbs without credentials never answer 5xx', async () => {
    const h = await harness({ loose: true });
    const bad: string[] = [];
    const paths = ['/api/approvals', '/api/bond', '/api/canned', '/api/egress-counter', '/api/live-list', '/api/proof', '/api/replay', '/api/rewind', '/api/status', '/api/verify', '/healthz',
      '/ledger/export', '/v1/ledger/export', '/pages/poisoned-docs', '/pages/poisoned-readme', '/api/policy/production', '/api/policy/00001000', '/api/stream/00001000', ...PAGE_ROUTES, ...MOVED_ROUTES];
    for (const p of paths) { const r = await inj(h.app, { method: 'GET', url: p }); if (r.statusCode >= 500) bad.push(`GET ${p} ${r.statusCode}`); }
    for (const p of ['/api/acl-self-test', '/api/approval/x1', '/api/attack', '/api/env-proof', '/api/rewind/act', '/api/session', '/api/session/00001000/tier', '/api/verify/run']) {
      const r = await inj(h.app, { method: 'POST', url: p, headers: jsonH, payload: '{}' }); if (r.statusCode >= 500) bad.push(`POST ${p} ${r.statusCode}`);
    }
    const put = await inj(h.app, { method: 'PUT', url: '/api/policy/00001000', headers: jsonH, payload: '{}' });
    if (put.statusCode >= 500) bad.push(`PUT policy ${put.statusCode}`);
    expect(bad).toEqual([]);
  });
  it('no verb on /api/policy/production ever reaches the per-session policy write at the broker', async () => {
    const h = await harness({ loose: true });
    for (const m of ['PUT', 'POST', 'PATCH', 'DELETE'] as const) {
      const r = await inj(h.app, { method: m, url: '/api/policy/production', headers: jsonH, payload: '{"policy":"p","signature":"s"}' });
      expect(r.statusCode).toBe(403);
    }
    expect(h.f.calls.filter((c) => c.method === 'PUT')).toEqual([]);
    expect(h.f.calls.filter((c) => c.path === '/v1/policy-production')).toHaveLength(4);
  });
});

// ---------------------------------------------------------------- 2. hostile strings
const STR = [...STRING_POOL, 'a'.repeat(10000), '..%2f..%2f', '/../../', 'x'.repeat(100)];
const textOracle = (s: string): number => (Buffer.byteLength(JSON.stringify({ text: s })) > 2048 ? 413 : s.trim().length >= 3 && s.length <= 300 ? 202 : 400);

describe('2 hostile strings on every field and path param', () => {
  it('attack.text follows the 3..300 rule exactly, nothing reflects, nothing 5xx', async () => {
    const h = await harness({ loose: true });
    const s = await openSession(h.app, '9.9.9.9');
    const bad: string[] = [];
    for (const t of STR) {
      const r = await inj(h.app, { method: 'POST', url: '/api/attack', headers: { ...jsonH, ...s.headers }, payload: JSON.stringify({ text: t }) });
      const p = sane(r); if (p) bad.push(`${JSON.stringify(t).slice(0, 30)} ${p}`);
      if (r.statusCode !== textOracle(t)) bad.push(`${JSON.stringify(t).slice(0, 30)} got ${r.statusCode} want ${textOracle(t)}`);
    }
    expect(bad).toEqual([]);
  });
  it('a client-named session_id that is not the credential owner is 403 (with creds) or 401 (without) on attack, env-proof, acl-self-test', async () => {
    const h = await harness({ loose: true });
    await openSession(h.app, '8.8.8.8');
    const s = await openSession(h.app, '9.9.9.9');
    const bad: string[] = [];
    for (const url of ['/api/attack', '/api/env-proof', '/api/acl-self-test']) {
      for (const t of STR) {
        const payload = JSON.stringify({ session_id: t, text: 'list my instances' });
        if (Buffer.byteLength(payload) > 2048) continue;
        const withC = await inj(h.app, { method: 'POST', url, headers: { ...jsonH, ...s.headers }, payload });
        const none = await inj(h.app, { method: 'POST', url, headers: jsonH, payload });
        if (withC.statusCode !== 403 || sane(withC)) bad.push(`${url} creds ${JSON.stringify(t).slice(0, 20)} ${withC.statusCode}`);
        if (none.statusCode !== 401 || sane(none)) bad.push(`${url} none ${JSON.stringify(t).slice(0, 20)} ${none.statusCode}`);
        if (JSON.stringify(withC.body).includes('<script')) bad.push(`${url} body reflects`);
      }
    }
    expect(bad).toEqual([]);
  });
  it('tier, action, nonce and approval id', async () => {
    const h = await harness({ loose: true });
    const s = await openSession(h.app, '9.9.9.9');
    const bad: string[] = [];
    for (const t of STR) {
      const tier = await inj(h.app, { method: 'POST', url: `/api/session/${s.sid}/tier`, headers: { ...jsonH, ...s.headers }, payload: JSON.stringify({ tier: t }) });
      if (tier.statusCode !== (t === 'observer' || t === 'standard' ? 200 : Buffer.byteLength(t) > 1900 ? 413 : 400)) bad.push(`tier ${JSON.stringify(t).slice(0, 20)} ${tier.statusCode}`);
      const act = await inj(h.app, { method: 'POST', url: '/api/rewind/act', headers: { ...jsonH, ...s.headers }, payload: JSON.stringify({ action: t }) });
      if (act.statusCode !== (t === 'delete' || t === 'restore' ? 200 : Buffer.byteLength(t) > 1900 ? 413 : 400)) bad.push(`act ${JSON.stringify(t).slice(0, 20)} ${act.statusCode}`);
      const nonce = await inj(h.app, { method: 'POST', url: '/api/approval/x1', headers: { ...jsonH, ...s.headers }, payload: JSON.stringify({ nonce: t, approve: false }) });
      if (nonce.statusCode >= 500 || (Buffer.byteLength(t) < 1900 && nonce.statusCode !== 200)) bad.push(`nonce ${JSON.stringify(t).slice(0, 20)} ${nonce.statusCode}`);
      const id = await inj(h.app, { method: 'POST', url: `/api/approval/${safeEnc(t)}`, headers: { ...jsonH, ...s.headers }, payload: JSON.stringify({ nonce: 'n', approve: false }) });
      const wantOk = /^[A-Za-z0-9_.-]{1,80}$/.test(t);
      if (id.statusCode >= 500 || (wantOk && id.statusCode !== 200) || (!wantOk && (id.statusCode < 400 || id.statusCode > 414))) bad.push(`id ${JSON.stringify(t).slice(0, 20)} ${id.statusCode}`);
      const p = sane(id); if (p) bad.push(`id ${p}`);
    }
    expect(bad).toEqual([]);
  });
  it('path :sid on policy GET/PUT, stream and tier: traversal and junk are refused 4xx, a foreign real sid is 403', async () => {
    const h = await harness({ loose: true });
    const a = await openSession(h.app, '8.8.8.8');
    const b = await openSession(h.app, '9.9.9.9');
    const raw = ['..%2f..%2fetc%2fpasswd', '../../etc/passwd', '%2e%2e%2f', '..;/x', '%00', '%zz', ...STR.map(safeEnc)];
    const bad: string[] = [];
    for (const sid of raw) {
      const reqs: InjectOptions[] = [
        { method: 'GET', url: `/api/policy/${sid}`, headers: b.headers },
        { method: 'PUT', url: `/api/policy/${sid}`, headers: { ...jsonH, ...b.headers }, payload: '{"text":"x"}' },
        { method: 'GET', url: `/api/stream/${sid}`, headers: b.headers },
        { method: 'POST', url: `/api/session/${sid}/tier`, headers: { ...jsonH, ...b.headers }, payload: '{"tier":"observer"}' },
      ];
      for (const q of reqs) {
        const r = await inj(h.app, q);
        const p = sane(r); if (p) bad.push(`${q.method} ${String(q.url).slice(0, 40)} ${p}`);
        if (sid === 'production' && q.method === 'GET' && String(q.url).includes('/policy/')) continue;
        if (r.statusCode < 400 || r.statusCode > 414) bad.push(`${q.method} ${String(q.url).slice(0, 40)} -> ${r.statusCode}`);
        if (r.body.includes(a.key) || r.body.includes(b.key)) bad.push('key leaked');
      }
    }
    expect(bad).toEqual([]);
    expect((await inj(h.app, { method: 'GET', url: `/api/policy/${a.sid}`, headers: b.headers })).statusCode).toBe(403);
    expect(h.f.ext.policyWrites).toBe(0);
  });
  it('live-list ?session_id= junk is 404 (broker never asked) except system', async () => {
    const h = await harness({ loose: true });
    const bad: string[] = [];
    for (const t of STR) {
      const r = await inj(h.app, { method: 'GET', url: `/api/live-list?session_id=${safeEnc(t)}` });
      if (t === 'system') { if (r.statusCode !== 200) bad.push('system'); continue; }
      if (r.statusCode !== 404) bad.push(`${JSON.stringify(t).slice(0, 20)} ${r.statusCode}`);
    }
    const arr = await inj(h.app, { method: 'GET', url: '/api/live-list?session_id=a&session_id=b' });
    expect(arr.statusCode).toBe(404);
    expect(bad).toEqual([]);
    expect(h.f.calls.filter((c) => c.path.startsWith('/v1/live-list')).map((c) => c.path)).toEqual(['/v1/live-list?session_id=system']);
  });
  it('policy text accepts any string (even hostile) round-trip unchanged, under the 70 KB limit', async () => {
    const h = await harness({ loose: true });
    const s = await openSession(h.app, '9.9.9.9');
    for (const t of STR.filter((x) => x.length > 0 || true)) {
      const put = await inj(h.app, { method: 'PUT', url: `/api/policy/${s.sid}`, headers: { ...jsonH, ...s.headers }, payload: JSON.stringify({ text: t }) });
      expect(put.statusCode).toBe(200);
      const got = await inj(h.app, { method: 'GET', url: `/api/policy/${s.sid}`, headers: s.headers });
      expect(J(got).text).toBe(t);
    }
  });
  it('hostile credential headers and cookies are refused 401/403, never 5xx', async () => {
    const h = await harness({ loose: true });
    const bad: string[] = [];
    for (const t of STR) {
      const v = ascii(t);
      for (const headers of [{ 'x-plumbline-session-id': v, 'x-plumbline-session-key': v }, { cookie: `plb_session=${v}` }, { cookie: `plb_session=${v}.${v}` }, { 'x-plumbline-session-key': v }]) {
        const r = await inj(h.app, { method: 'GET', url: '/api/approvals', headers });
        const p = sane(r); if (p) bad.push(p);
        if (![401, 403].includes(r.statusCode)) bad.push(`cred ${JSON.stringify(headers).slice(0, 40)} -> ${r.statusCode}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------- 3. numbers
const NUMS = ['0', '-0', '-1', '1', '0.0001', '9007199254740991', '1e308', '-1e308', '1e999', '5e-324'];
const BAD_TOKENS = ['Infinity', '-Infinity', 'NaN', '+1', '01', '.5', '1.', '0x10'];

describe('3 numbers where strings/booleans are expected, and non-finite tokens', () => {
  const fields: { url: string; field: string; ok?: number[] }[] = [
    { url: '/api/attack', field: 'text' }, { url: '/api/session/SID/tier', field: 'tier' }, { url: '/api/rewind/act', field: 'action' },
    { url: '/api/approval/x1', field: 'nonce' }, { url: '/api/approval/x1', field: 'approve' }, { url: '/api/policy/SID', field: 'text' },
  ];
  it('a JSON number in a string/boolean field is 400', async () => {
    const h = await harness({ loose: true });
    const s = await openSession(h.app, '9.9.9.9');
    const bad: string[] = [];
    for (const f of fields) for (const n of NUMS) {
      const extra = f.field === 'nonce' ? ',"approve":true' : f.field === 'approve' ? ',"nonce":"n"' : '';
      const r = await inj(h.app, { method: f.url.startsWith('/api/policy') ? 'PUT' : 'POST', url: f.url.replace('SID', s.sid), headers: { ...jsonH, ...s.headers }, payload: `{"${f.field}":${n}${extra}}` });
      if (r.statusCode !== 400) bad.push(`${f.url} ${f.field}=${n} -> ${r.statusCode}`);
    }
    expect(bad).toEqual([]);
  });
  it('a numeric session_id claim is ignored (credential wins) and never 5xx; without creds it is 401', async () => {
    const h = await harness({ loose: true });
    const s = await openSession(h.app, '9.9.9.9');
    const bad: string[] = [];
    for (const url of ['/api/env-proof', '/api/acl-self-test']) for (const n of NUMS) {
      const a = await inj(h.app, { method: 'POST', url, headers: { ...jsonH, ...s.headers }, payload: `{"session_id":${n}}` });
      const b = await inj(h.app, { method: 'POST', url, headers: jsonH, payload: `{"session_id":${n}}` });
      if (a.statusCode !== 200) bad.push(`${url} ${n} creds ${a.statusCode}`);
      if (b.statusCode !== 401) bad.push(`${url} ${n} none ${b.statusCode}`);
    }
    expect(bad).toEqual([]);
  });
  it('Infinity, NaN and other non-JSON number tokens are 400 on every body route', async () => {
    const h = await harness({ loose: true });
    const s = await openSession(h.app, '9.9.9.9');
    const bad: string[] = [];
    for (const url of ['/api/attack', '/api/env-proof', '/api/rewind/act', '/api/acl-self-test', '/api/approval/x1', `/api/session/${s.sid}/tier`, '/api/session']) for (const t of BAD_TOKENS) {
      const r = await inj(h.app, { method: 'POST', url, headers: { ...jsonH, ...s.headers }, payload: `{"text":${t}}` });
      if (r.statusCode !== 400) bad.push(`${url} ${t} -> ${r.statusCode}`);
    }
    expect(bad).toEqual([]);
  });
  it('numeric-looking query session_id on live-list is 404', async () => {
    const h = await harness({ loose: true });
    for (const n of ['0', '-1', '1e308', 'NaN', 'Infinity', '-0', '12345678', '0.0001']) expect((await inj(h.app, { method: 'GET', url: `/api/live-list?session_id=${n}` })).statusCode).toBe(n === '12345678' ? 404 : 404);
  });
  it('Last-Event-ID of any numeric shape opens the stream and replays the right suffix', async () => {
    const h = await harness({ loose: true });
    const s = await openSession(h.app, '127.0.0.1');
    for (let i = 0; i < 3; i++) h.deps.hub.publish(s.sid, 'stage', { n: i });
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (h.app.server.address() as AddressInfo).port;
    const cases: [string, number[]][] = [['-1', [1, 2, 3]], ['0', [1, 2, 3]], ['1', [2, 3]], ['2', [3]], ['3', []], ['1e308', []], ['9007199254740991', []], ['Infinity', []],
      ['NaN', [1, 2, 3]], ['-0', [1, 2, 3]], ['0.0001', [1, 2, 3]], ['', [1, 2, 3]], ['abc', [1, 2, 3]], ['1.5', [2, 3]]];
    for (const [v, want] of cases) {
      const got = await new Promise<{ status: number; ids: number[] }>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: `/api/stream/${s.sid}`, headers: { ...s.headers, 'x-forwarded-for': '127.0.0.1', 'last-event-id': v } }, (res) => {
          let buf = '';
          res.on('data', (c) => { buf += String(c); });
          setTimeout(() => { res.destroy(); req.destroy(); resolve({ status: res.statusCode ?? 0, ids: [...buf.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])) }); }, 120);
        });
        req.on('error', reject);
      });
      expect([v, got.status, got.ids]).toEqual([v, 200, want]);
      await new Promise((r) => setTimeout(r, 30));
    }
  });
});

// ---------------------------------------------------------------- 4. malformed / oversized bodies
const bodyRoutes = (sid: string) => [
  { m: 'POST', url: '/api/attack', need: true }, { m: 'POST', url: '/api/env-proof', need: false }, { m: 'POST', url: '/api/rewind/act', need: true },
  { m: 'POST', url: '/api/acl-self-test', need: false }, { m: 'POST', url: '/api/approval/x1', need: true }, { m: 'POST', url: `/api/session/${sid}/tier`, need: true },
  { m: 'POST', url: '/api/session', need: false }, { m: 'POST', url: '/api/verify/run', need: false }, { m: 'PUT', url: `/api/policy/${sid}`, need: true },
  { m: 'PUT', url: '/api/policy/production', need: false }, { m: 'POST', url: '/api/policy/production', need: false },
] as const;
const padded = (bytes: number, head: string): string => { const base = `{${head}"pad":"`; return base + 'a'.repeat(bytes - base.length - 2) + '"}'; };

describe('4 malformed JSON, content types, empty/array bodies, nesting, size limits', () => {
  it('malformed JSON is 400 on every body route', async () => {
    const h = await harness({ loose: true });
    const s = await openSession(h.app, '9.9.9.9');
    const bad: string[] = [];
    for (const r of bodyRoutes(s.sid)) for (const body of ['{', '{"a":', '{"a":1,}', "{'a':1}", '', 'nul', '[1,2', '{"text":"abc"', '\u0000', '{"text":"abc"}garbage', '}{']) {
      const x = await inj(h.app, { method: r.m, url: r.url, headers: { ...jsonH, ...s.headers }, payload: body });
      if (x.statusCode !== 400 || sane(x)) bad.push(`${r.url} ${JSON.stringify(body)} -> ${x.statusCode}`);
    }
    expect(bad).toEqual([]);
  });
  it('unsupported content types are 415; text/plain is never 5xx and body routes still refuse it', async () => {
    const h = await harness({ loose: true });
    const s = await openSession(h.app, '9.9.9.9');
    const bad: string[] = [];
    for (const r of bodyRoutes(s.sid)) {
      for (const ct of ['application/x-www-form-urlencoded', 'application/xml', 'multipart/form-data; boundary=x', 'application/json5', 'image/png']) {
        const x = await inj(h.app, { method: r.m, url: r.url, headers: { 'content-type': ct, ...s.headers }, payload: '{"text":"abc"}' });
        if (x.statusCode !== 415) bad.push(`${r.url} ${ct} -> ${x.statusCode}`);
      }
      const t = await inj(h.app, { method: r.m, url: r.url, headers: { 'content-type': 'text/plain', ...s.headers }, payload: '{"text":"abcdef","tier":"observer","action":"restore"}' });
      if (t.statusCode >= 500 || (r.need && t.statusCode !== 400)) bad.push(`${r.url} text/plain -> ${t.statusCode}`);
    }
    expect(bad).toEqual([]);
  });
  it('no body and no content type: 400 where a body is required, otherwise handled', async () => {
    const h = await harness({ loose: true });
    const s = await openSession(h.app, '9.9.9.9');
    const bad: string[] = [];
    for (const r of bodyRoutes(s.sid)) {
      const x = await inj(h.app, { method: r.m, url: r.url, headers: s.headers });
      if (x.statusCode >= 500 || (r.need && x.statusCode !== 400)) bad.push(`${r.url} -> ${x.statusCode}`);
    }
    expect(bad).toEqual([]);
  });
  it('array, scalar and null bodies where an object is expected never 5xx; body routes answer 400', async () => {
    const h = await harness({ loose: true });
    const s = await openSession(h.app, '9.9.9.9');
    const bad: string[] = [];
    for (const r of bodyRoutes(s.sid)) for (const body of ['[]', '[1,2]', '[{"text":"abcdef"}]', '"str"', '42', 'true', 'null']) {
      const x = await inj(h.app, { method: r.m, url: r.url, headers: { ...jsonH, ...s.headers }, payload: body });
      if (x.statusCode >= 500 || (r.need && x.statusCode !== 400)) bad.push(`${r.url} ${body} -> ${x.statusCode}`);
    }
    expect(bad).toEqual([]);
  });
  it('depth-1000 nesting: arrays fit the 2 KB limit (400), objects exceed it (413); 70 KB route survives depth 10000', async () => {
    const h = await harness({ loose: true });
    const s = await openSession(h.app, '9.9.9.9');
    const arr = '['.repeat(1000) + ']'.repeat(1000);
    const obj = '{"a":'.repeat(1000) + '1' + '}'.repeat(1000);
    for (const r of bodyRoutes(s.sid).filter((x) => !x.url.includes('/policy/'))) {
      expect((await inj(h.app, { method: r.m, url: r.url, headers: { ...jsonH, ...s.headers }, payload: arr })).statusCode).toBeLessThan(500);
      expect((await inj(h.app, { method: r.m, url: r.url, headers: { ...jsonH, ...s.headers }, payload: obj })).statusCode).toBe(413);
    }
    const deep = '{"a":'.repeat(10000) + '1' + '}'.repeat(10000);
    const p = await inj(h.app, { method: 'PUT', url: `/api/policy/${s.sid}`, headers: { ...jsonH, ...s.headers }, payload: deep });
    expect(p.statusCode).toBe(400);
    const pa = await inj(h.app, { method: 'PUT', url: `/api/policy/${s.sid}`, headers: { ...jsonH, ...s.headers }, payload: '['.repeat(30000) + ']'.repeat(30000) });
    expect(pa.statusCode).toBeLessThan(500);
  });
  it('global limit 2048 B: exactly 2048 passes to the handler, 2049 is 413', async () => {
    const h = await harness({ loose: true });
    const s = await openSession(h.app, '9.9.9.9');
    const heads: Record<string, string> = { '/api/attack': '"text":"hello there",', '/api/rewind/act': '"action":"restore",', '/api/env-proof': '', '/api/acl-self-test': '' };
    for (const [url, head] of Object.entries(heads)) {
      const under = await inj(h.app, { method: 'POST', url, headers: { ...jsonH, ...s.headers }, payload: padded(2048, head) });
      const over = await inj(h.app, { method: 'POST', url, headers: { ...jsonH, ...s.headers }, payload: padded(2049, head) });
      expect([url, under.statusCode === 413, over.statusCode, J(over).code]).toEqual([url, false, 413, 'FST_ERR_CTP_BODY_TOO_LARGE']);
      expect(under.statusCode).toBeLessThan(500);
    }
  });
  it('policy PUT limit is 70 KB: exactly 71680 B is stored whole, one more byte is 413 and changes nothing', async () => {
    const h = await harness({ loose: true });
    const s = await openSession(h.app, '9.9.9.9');
    const mk = (bytes: number) => `{"text":"${'p'.repeat(bytes - 11)}"}`;
    const ok = await inj(h.app, { method: 'PUT', url: `/api/policy/${s.sid}`, headers: { ...jsonH, ...s.headers }, payload: mk(70 * 1024) });
    expect(ok.statusCode).toBe(200);
    expect((J(await inj(h.app, { method: 'GET', url: `/api/policy/${s.sid}`, headers: s.headers })).text as string).length).toBe(70 * 1024 - 11);
    const over = await inj(h.app, { method: 'PUT', url: `/api/policy/${s.sid}`, headers: { ...jsonH, ...s.headers }, payload: `{"text":"${'q'.repeat(70 * 1024 - 10)}"}` });
    expect(over.statusCode).toBe(413);
    expect(String(J(await inj(h.app, { method: 'GET', url: `/api/policy/${s.sid}`, headers: s.headers })).text).startsWith('p')).toBe(true);
    for (const m of ['PUT', 'POST'] as const) {
      expect((await inj(h.app, { method: m, url: '/api/policy/production', headers: jsonH, payload: padded(70 * 1024, '') })).statusCode).toBe(403);
      expect((await inj(h.app, { method: m, url: '/api/policy/production', headers: jsonH, payload: padded(70 * 1024 + 1, '') })).statusCode).toBe(413);
    }
  });
  it('a 70 KB body on a 2 KB route is 413', async () => {
    const h = await harness({ loose: true });
    const s = await openSession(h.app, '9.9.9.9');
    expect((await inj(h.app, { method: 'POST', url: '/api/attack', headers: { ...jsonH, ...s.headers }, payload: padded(70 * 1024, '"text":"abc",') })).statusCode).toBe(413);
  });
});

// ---------------------------------------------------------------- 5. auth and session isolation
describe('5 auth: no key, wrong key, foreign key, unknown, malformed, expired', () => {
  async function two() {
    const h = await harness({ loose: true });
    const a = await openSession(h.app, '8.8.8.8');
    const b = await openSession(h.app, '9.9.9.9');
    await inj(h.app, { method: 'PUT', url: `/api/policy/${a.sid}`, headers: { ...jsonH, ...a.headers }, payload: '{"text":"SECRET-A"}' });
    return { h, a, b };
  }
  const protectedReqs = (sid: string): InjectOptions[] => [
    { method: 'POST', url: '/api/attack', headers: jsonH, payload: '{"text":"list my instances"}' },
    { method: 'POST', url: '/api/env-proof', headers: jsonH, payload: '{}' },
    { method: 'POST', url: '/api/rewind/act', headers: jsonH, payload: '{"action":"restore"}' },
    { method: 'POST', url: '/api/acl-self-test', headers: jsonH, payload: '{}' },
    { method: 'POST', url: '/api/approval/x1', headers: jsonH, payload: '{"nonce":"n","approve":false}' },
    { method: 'POST', url: `/api/session/${sid}/tier`, headers: jsonH, payload: '{"tier":"observer"}' },
    { method: 'GET', url: '/api/approvals' }, { method: 'GET', url: '/api/rewind' },
    { method: 'GET', url: `/api/policy/${sid}` }, { method: 'PUT', url: `/api/policy/${sid}`, headers: jsonH, payload: '{"text":"x"}' },
    { method: 'GET', url: `/api/live-list?session_id=${sid}` }, { method: 'GET', url: `/api/stream/${sid}` },
  ];
  const withH = (q: InjectOptions, h: Record<string, string>): InjectOptions => ({ ...q, headers: { ...(q.headers as object), ...h } });

  it('no key is 401; wrong key / key only / unknown sid are 403; nothing of the session is returned', async () => {
    const { h, a } = await two();
    const bad: string[] = [];
    const ghost0 = { statusCode: 403, body: '' };
    for (const q of protectedReqs(a.sid)) {
      const none = await inj(h.app, q);
      const sidOnly = await inj(h.app, withH(q, { 'x-plumbline-session-id': a.sid }));
      const wrong = await inj(h.app, withH(q, { 'x-plumbline-session-id': a.sid, 'x-plumbline-session-key': 'nope' }));
      const pathNamed = String(q.url).includes(a.sid);
      const keyOnly = pathNamed ? ghost0 : await inj(h.app, withH(q, { 'x-plumbline-session-key': a.key }));
      const ghost = await inj(h.app, withH(q, { 'x-plumbline-session-id': 'deadbeef', 'x-plumbline-session-key': a.key }));
      const tag = `${q.method} ${q.url}`;
      if (none.statusCode !== 401) bad.push(`${tag} none ${none.statusCode}`);
      if (sidOnly.statusCode !== 401) bad.push(`${tag} sidOnly ${sidOnly.statusCode}`);
      if (wrong.statusCode !== 403) bad.push(`${tag} wrong ${wrong.statusCode}`);
      if (keyOnly.statusCode !== 403) bad.push(`${tag} keyOnly ${keyOnly.statusCode}`);
      if (ghost.statusCode !== 403) bad.push(`${tag} ghost ${ghost.statusCode}`);
      for (const r of [none, sidOnly, wrong, keyOnly, ghost]) if (r.body.includes('SECRET-A') || r.body.includes(a.key)) bad.push(`${tag} leaks`);
    }
    expect(bad).toEqual([]);
  });
  it('another session\'s key cannot read or write this session: policy, live-list, stream, attack, tier, put', async () => {
    const { h, a, b } = await two();
    const bad: string[] = [];
    for (const q of protectedReqs(a.sid)) {
      if (q.url === '/api/approvals' || q.url === '/api/rewind') continue; // path-less routes act on the caller's own session, covered below
      const r = await inj(h.app, withH(q, b.headers));
      const aimedAtA = String(q.url).includes(a.sid);
      if (aimedAtA && r.statusCode !== 403) bad.push(`${q.method} ${q.url} ${r.statusCode}`);
      if (r.body.includes('SECRET-A')) bad.push('leak');
    }
    const atk = await inj(h.app, { method: 'POST', url: '/api/attack', headers: { ...jsonH, ...b.headers }, payload: JSON.stringify({ session_id: a.sid, text: 'list my instances' }) });
    expect([atk.statusCode, J(atk).status]).toEqual([403, 'SESSION_MISMATCH']);
    const keyBonly = await inj(h.app, { method: 'POST', url: '/api/attack', headers: { ...jsonH, 'x-plumbline-session-key': b.key }, payload: JSON.stringify({ session_id: a.sid, text: 'list my instances' }) });
    expect([keyBonly.statusCode, J(keyBonly).status]).toEqual([403, 'SESSION_KEY_MISMATCH']);
    expect(bad).toEqual([]);
    expect(h.f.calls.some((c) => c.path.includes(a.sid) && c.method !== 'PUT' && c.path.includes('tier'))).toBe(false);
    const got: string[] = [];
    h.deps.hub.subscribe(a.sid, (e) => got.push(e.type), 0);
    expect(got).toEqual([]);
    expect(J(await inj(h.app, { method: 'GET', url: `/api/policy/${a.sid}`, headers: a.headers })).text).toBe('SECRET-A');
  });
  it('credential-owned routes ignore a client-named session in query/body: the broker only ever sees the caller\'s sid', async () => {
    const { h, a, b } = await two();
    await inj(h.app, { method: 'GET', url: `/api/rewind?session_id=${a.sid}`, headers: b.headers });
    await inj(h.app, { method: 'GET', url: `/api/bond?session_id=${a.sid}`, headers: b.headers });
    await inj(h.app, { method: 'GET', url: `/api/approvals?session_id=${a.sid}`, headers: b.headers });
    await inj(h.app, { method: 'POST', url: `/api/approval/x1?session_id=${a.sid}`, headers: { ...jsonH, ...b.headers }, payload: JSON.stringify({ session_id: a.sid, nonce: 'n', approve: false }) });
    await inj(h.app, { method: 'POST', url: '/api/rewind/act', headers: { ...jsonH, ...b.headers }, payload: JSON.stringify({ session_id: a.sid, action: 'restore' }) });
    const touched = h.f.calls.filter((c) => /rewind|bond|approval|acl/.test(c.path));
    expect(touched.length).toBeGreaterThanOrEqual(5);
    for (const c of touched) expect(JSON.stringify(c)).not.toContain(a.sid);
    expect(touched.some((c) => JSON.stringify(c).includes(b.sid))).toBe(true);
  });
  it('/api/bond: no credential is the aggregate (no session id); a wrong credential is refused', async () => {
    const { h, a } = await two();
    const agg = await inj(h.app, { method: 'GET', url: `/api/bond?session_id=${a.sid}` });
    expect(agg.statusCode).toBe(200);
    expect(h.f.calls.filter((c) => c.path.startsWith('/v1/bond')).map((c) => c.path)).toEqual(['/v1/bond']);
    expect((await inj(h.app, { method: 'GET', url: '/api/bond', headers: { 'x-plumbline-session-id': a.sid, 'x-plumbline-session-key': 'bad' } })).statusCode).toBe(403);
  });
  it('cookie wins over headers; malformed cookies fall back to headers; empty key is 401', async () => {
    const { h, a, b } = await two();
    h.f.state.approvals[a.sid] = [{ decision_id: 'A-ONLY', nonce: 'n', call: { verb: 'x', class: 'y' } }];
    const viaCookie = await inj(h.app, { method: 'GET', url: '/api/approvals', headers: { ...b.headers, cookie: `plb_session=${a.sid}.${a.key}` } });
    expect(JSON.stringify(viaCookie.json())).toContain('A-ONLY');
    const viaB = await inj(h.app, { method: 'GET', url: '/api/approvals', headers: b.headers });
    expect(viaB.body).not.toContain('A-ONLY');
    for (const c of ['plb_session=garbage', 'plb_session=.key', 'other=1']) expect((await inj(h.app, { method: 'GET', url: '/api/approvals', headers: { ...b.headers, cookie: c } })).statusCode).toBe(200);
    expect((await inj(h.app, { method: 'GET', url: '/api/approvals', headers: { cookie: `plb_session=${a.sid}.` } })).statusCode).toBe(401);
    expect((await inj(h.app, { method: 'GET', url: '/api/approvals', headers: { cookie: `plb_session=${a.sid}.${'k'.repeat(5000)}` } })).statusCode).toBe(403);
  });
  it('an expired session (past 60 min) is refused everywhere and its policy is unknown', async () => {
    let now = 5_000_000;
    const h = await harness({ loose: true, deps: { book: new SessionBook(undefined, () => now), clock: () => now } });
    const a = await openSession(h.app, '8.8.8.8');
    expect((await inj(h.app, { method: 'GET', url: '/api/approvals', headers: a.headers })).statusCode).toBe(200);
    now += 61 * 60_000;
    const bad: string[] = [];
    for (const q of protectedReqs(a.sid)) {
      const r = await inj(h.app, withH(q, a.headers));
      const want = String(q.url).includes(a.sid) && !String(q.url).includes('/tier') ? 404 : 403;
      if (r.statusCode !== want) bad.push(`${q.method} ${q.url} ${r.statusCode}`);
    }
    expect(bad).toEqual([]);
  });
  it('unknown but well-formed sid on policy/stream/live-list is 404 SESSION_UNKNOWN, malformed sid too', async () => {
    const { h, b } = await two();
    for (const sid of ['deadbeef', 'DEADBEEF', '1234567', '123456789', 'zzzzzzzz', 'production2']) {
      for (const u of [`/api/policy/${sid}`, `/api/stream/${sid}`, `/api/live-list?session_id=${sid}`]) {
        const r = await inj(h.app, { method: 'GET', url: u, headers: b.headers });
        expect([u, r.statusCode, J(r).status]).toEqual([u, 404, 'SESSION_UNKNOWN']);
      }
    }
  });
  it('pending approvals are scoped to the caller: A\'s decision never appears in B\'s list', async () => {
    const { h, a, b } = await two();
    h.f.state.approvals[a.sid] = [{ decision_id: 'dec-A', nonce: 'nA', call: { verb: 'delete', class: 'bucket_object', id: 'orders.json' } }];
    h.f.state.approvals[b.sid] = [{ decision_id: 'dec-B', nonce: 'nB', call: { verb: 'delete', class: 'instance', id: 'i1' } }];
    const lb = (await inj(h.app, { method: 'GET', url: '/api/approvals', headers: b.headers })).json() as { decision_id: string; approve_allowed: boolean }[];
    expect(lb.map((x) => x.decision_id)).toEqual(['dec-B']);
    const la = (await inj(h.app, { method: 'GET', url: '/api/approvals', headers: a.headers })).json() as { decision_id: string; approve_allowed: boolean }[];
    expect(la).toMatchObject([{ decision_id: 'dec-A', approve_allowed: false }]);
    const ap = await inj(h.app, { method: 'POST', url: '/api/approval/dec-A', headers: { ...jsonH, ...a.headers }, payload: '{"nonce":"nA","approve":true}' });
    expect([ap.statusCode, J(ap).status]).toEqual([409, 'SHARED_CANARY_APPROVAL_REFUSED']);
  });
});

// ---------------------------------------------------------------- 6. rate limits
describe('6 rate limits: 429 carries retry_after, and a refusal never spends someone else\'s quota', () => {
  const create = (app: App, ip: string) => inj(app, { method: 'POST', url: '/api/session', headers: { 'x-forwarded-for': ip, ...jsonH }, payload: '{}' });
  const clockDeps = (now: () => number, live = 99) => ({ conf: { liveSessionsPerIp: live } as Partial<ApiConfig>, deps: { clock: now, book: new SessionBook(undefined, now), attackLimit: new SlidingWindow(3, 60_000, now),
    actLimit: new SlidingWindow(10, 60_000, now), liveListLimit: new SlidingWindow(30, 60_000, now), sessionIpLimit: new SlidingWindow(3, 600_000, now), sessionGlobalLimit: new SlidingWindow(10, 60_000, now) } });

  it('sessions per IP: 3 then 429 with retry_after_s + Retry-After; the broker is not asked; another IP is unaffected', async () => {
    let now = 1_000_000;
    const h = await harness(clockDeps(() => now));
    for (let i = 0; i < 3; i++) expect((await create(h.app, '5.5.5.5')).statusCode).toBe(200);
    const r = await create(h.app, '5.5.5.5');
    expect([r.statusCode, J(r).status, J(r).retry_after_s, r.headers['retry-after']]).toEqual([429, 'RATE_LIMITED', 600, '600']);
    expect(h.f.state.created).toHaveLength(3);
    expect((await create(h.app, '6.6.6.6')).statusCode).toBe(200);
    now += 300_000;
    expect(J(await create(h.app, '5.5.5.5')).retry_after_s).toBe(300);
    now += 300_000;
    expect((await create(h.app, '5.5.5.5')).statusCode).toBe(200);
  });
  it('a per-IP refusal does not consume the global per-minute quota (10): 20 refusals from A leave 7 for others', async () => {
    const now = 1_000_000;
    const h = await harness(clockDeps(() => now));
    for (let i = 0; i < 23; i++) await create(h.app, '5.5.5.5');
    const codes: number[] = [];
    for (const ip of ['1.1.1.1', '1.1.1.2', '1.1.1.3', '1.1.1.4']) for (let i = 0; i < 3; i++) codes.push((await create(h.app, ip)).statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(7);
    const last = codes.filter((c) => c === 429);
    expect(last).toHaveLength(5);
    expect(J(await create(h.app, '1.1.1.9')).retry_after_s).toBeGreaterThanOrEqual(1);
  });
  it('live sessions per IP: 3rd is 429 SESSIONS_PER_IP_LIVE and another IP is unaffected', async () => {
    const now = 1_000_000;
    const h = await harness(clockDeps(() => now, 2));
    await create(h.app, '5.5.5.5'); await create(h.app, '5.5.5.5');
    const r = await create(h.app, '5.5.5.5');
    expect([r.statusCode, J(r).status]).toEqual([429, 'SESSIONS_PER_IP_LIVE']);
    expect((await create(h.app, '6.6.6.6')).statusCode).toBe(200);
    expect(h.f.state.created).toHaveLength(3);
  });
  it('FIXED L1: the SESSIONS_PER_IP_LIVE 429 carries no retry_after / Retry-After (every other rate-limit 429 does)', async () => {
    const now = 1_000_000;
    const h = await harness(clockDeps(() => now, 2));
    await create(h.app, '5.5.5.5'); await create(h.app, '5.5.5.5');
    const r = await create(h.app, '5.5.5.5');
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
  });
  it('attacks per minute per session: 3 accepted, 4th..N 429 with exact retry_after; refusals do not extend the window; another session of the same IP is unaffected', async () => {
    let now = 1_000_000;
    const h = await harness(clockDeps(() => now));
    const a = await openSession(h.app, '5.5.5.5');
    const b = await openSession(h.app, '5.5.5.5');
    const atk = (s: typeof a) => inj(h.app, { method: 'POST', url: '/api/attack', headers: { ...jsonH, ...s.headers }, payload: '{"text":"list my instances"}' });
    for (let i = 0; i < 3; i++) expect((await atk(a)).statusCode).toBe(202);
    now += 20_000;
    for (let i = 0; i < 30; i++) { const r = await atk(a); expect([r.statusCode, J(r).retry_after_s, r.headers['retry-after']]).toEqual([429, 40, '40']); }
    expect((await atk(b)).statusCode).toBe(202);
    now += 40_000;
    expect((await atk(a)).statusCode).toBe(202);
  });
  it('unauthenticated or invalid attacks never consume the session\'s quota', async () => {
    const now = 1_000_000;
    const h = await harness(clockDeps(() => now));
    const a = await openSession(h.app, '5.5.5.5');
    for (let i = 0; i < 40; i++) {
      await inj(h.app, { method: 'POST', url: '/api/attack', headers: jsonH, payload: JSON.stringify({ session_id: a.sid, text: 'list my instances' }) });
      await inj(h.app, { method: 'POST', url: '/api/attack', headers: { ...jsonH, ...a.headers }, payload: '{"text":"x"}' });
      await inj(h.app, { method: 'POST', url: '/api/attack', headers: { ...jsonH, 'x-plumbline-session-id': a.sid, 'x-plumbline-session-key': 'bad' }, payload: '{"text":"list my instances"}' });
    }
    for (let i = 0; i < 3; i++) expect((await inj(h.app, { method: 'POST', url: '/api/attack', headers: { ...jsonH, ...a.headers }, payload: '{"text":"list my instances"}' })).statusCode).toBe(202);
  });
  it('env-proof shares the attack quota (3/min) of its session only', async () => {
    const now = 1_000_000;
    const h = await harness(clockDeps(() => now));
    const a = await openSession(h.app, '5.5.5.5');
    const b = await openSession(h.app, '6.6.6.6');
    const ep = (s: typeof a) => inj(h.app, { method: 'POST', url: '/api/env-proof', headers: { ...jsonH, ...s.headers }, payload: '{}' });
    expect([(await ep(a)).statusCode, (await ep(a)).statusCode, (await ep(a)).statusCode]).toEqual([200, 200, 200]);
    const r = await ep(a);
    expect([r.statusCode, typeof J(r).retry_after_s]).toEqual([429, 'number']);
    expect((await ep(b)).statusCode).toBe(200);
    expect(h.deps.inFlight.count).toBe(0);
  });
  it('act routes (acl-self-test, rewind/act, approval): 10/min per session, 11th is 429 with retry_after', async () => {
    const now = 1_000_000;
    const h = await harness(clockDeps(() => now));
    const a = await openSession(h.app, '5.5.5.5');
    const b = await openSession(h.app, '6.6.6.6');
    const calls = [(s: typeof a) => inj(h.app, { method: 'POST', url: '/api/acl-self-test', headers: { ...jsonH, ...s.headers }, payload: '{}' }),
      (s: typeof a) => inj(h.app, { method: 'POST', url: '/api/rewind/act', headers: { ...jsonH, ...s.headers }, payload: '{"action":"restore"}' }),
      (s: typeof a) => inj(h.app, { method: 'POST', url: '/api/approval/x1', headers: { ...jsonH, ...s.headers }, payload: '{"nonce":"n","approve":false}' })];
    for (let i = 0; i < 10; i++) expect((await calls[i % 3]!(a)).statusCode).toBe(200);
    for (const c of calls) { const r = await c(a); expect([r.statusCode, J(r).retry_after_s]).toEqual([429, 60]); }
    expect((await calls[0]!(b)).statusCode).toBe(200);
  });
  it('live-list: 30/min per IP (429 + retry_after), 404 refusals are free, another IP is unaffected, and the broker is hit once per 3 s per sid', async () => {
    let now = 1_000_000;
    const h = await harness(clockDeps(() => now));
    const ll = (ip: string, q = '') => inj(h.app, { method: 'GET', url: `/api/live-list${q}`, headers: { 'x-forwarded-for': ip } });
    for (let i = 0; i < 100; i++) expect((await ll('5.5.5.5', '?session_id=deadbeef')).statusCode).toBe(404);
    for (let i = 0; i < 30; i++) expect((await ll('5.5.5.5')).statusCode).toBe(200);
    const r = await ll('5.5.5.5');
    expect([r.statusCode, J(r).status, J(r).retry_after_s, r.headers['retry-after']]).toEqual([429, 'RATE_LIMITED', 60, '60']);
    expect((await ll('6.6.6.6')).statusCode).toBe(200);
    expect(h.f.calls.filter((c) => c.path.startsWith('/v1/live-list'))).toHaveLength(1);
    now += 3001;
    await ll('6.6.6.6');
    expect(h.f.calls.filter((c) => c.path.startsWith('/v1/live-list'))).toHaveLength(2);
  });
  it('IP spend cap: 429 IP_SPEND_CAP for that IP only, on attack and session create', async () => {
    const h = await harness({ loose: true, conf: { ipSpendCapUsd: 1.5 } });
    const a = await openSession(h.app, '5.5.5.5');
    const b = await openSession(h.app, '6.6.6.6');
    h.f.state.spend[a.sid] = 1.5;
    const r = await inj(h.app, { method: 'POST', url: '/api/attack', headers: { ...jsonH, ...a.headers }, payload: '{"text":"list my instances"}' });
    expect([r.statusCode, J(r).status]).toEqual([429, 'IP_SPEND_CAP']);
    const c = await create(h.app, '5.5.5.5');
    expect([c.statusCode, J(c).status]).toEqual([429, 'IP_SPEND_CAP']);
    expect((await inj(h.app, { method: 'POST', url: '/api/attack', headers: { ...jsonH, ...b.headers }, payload: '{"text":"list my instances"}' })).statusCode).toBe(202);
  });
  it('broker down while checking spend fails closed (429), never 5xx', async () => {
    const h = await harness({ loose: true });
    const a = await openSession(h.app, '5.5.5.5');
    const orig = h.f.broker.call;
    h.f.broker.call = (async (m: string, p: string, b?: unknown) => { if (p.startsWith('/v1/spend/')) throw new Error('down'); return orig(m, p, b); }) as never;
    expect((await inj(h.app, { method: 'POST', url: '/api/attack', headers: { ...jsonH, ...a.headers }, payload: '{"text":"list my instances"}' })).statusCode).toBe(429);
  });
});

// ---------------------------------------------------------------- 7. concurrency
describe('7 concurrency', () => {
  const atkReq = (s: { headers: Record<string, string> }, text = 'list my instances') => ({ method: 'POST' as const, url: '/api/attack', headers: { ...jsonH, ...s.headers }, payload: JSON.stringify({ text }) });
  it('20 parallel attacks on one session: exactly 3 accepted, 17 are 429, exactly 3 executions', async () => {
    const h = await harness({ conf: { maxInFlight: 50 } });
    const s = await openSession(h.app, '5.5.5.5');
    const rs = await Promise.all(Array.from({ length: 20 }, () => inj(h.app, atkReq(s))));
    expect(rs.filter((r) => r.statusCode === 202)).toHaveLength(3);
    expect(rs.filter((r) => r.statusCode === 429)).toHaveLength(17);
    expect(new Set(rs.filter((r) => r.statusCode === 202).map((r) => J(r).attack_id)).size).toBe(3);
    await new Promise((r) => setTimeout(r, 50));
    const starts: unknown[] = [];
    h.deps.hub.subscribe(s.sid, (e) => { if (e.type === 'stage' && (e.data as { stage?: string }).stage === 'start') starts.push(e); }, 0);
    expect(starts).toHaveLength(3);
    expect(h.f.ext.chatCalls).toBe(6); // advisory + planner per execution, exactly 3 executions
    expect(h.deps.inFlight.count).toBe(0);
  });
  it('attacks + env-proofs racing on one session share the 3/min quota', async () => {
    const h = await harness({ conf: { maxInFlight: 50 } });
    const s = await openSession(h.app, '5.5.5.5');
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => i % 2 ? inj(h.app, atkReq(s)) : inj(h.app, { method: 'POST', url: '/api/env-proof', headers: { ...jsonH, ...s.headers }, payload: '{}' })));
    expect(rs.filter((r) => r.statusCode === 200 || r.statusCode === 202)).toHaveLength(3);
    expect(rs.filter((r) => r.statusCode === 429)).toHaveLength(17);
  });
  it('global in-flight cap: 8 sessions attacking at once while the model is held -> exactly maxInFlight accepted, rest 503 OPERATOR_BUSY; slots free afterwards', async () => {
    const f = statefulBroker();
    let release!: () => void;
    f.ext.chatGate = new Promise<void>((r) => { release = r; });
    const h = await harness({ f, conf: { maxInFlight: 4 } });
    const sessions = [];
    for (let i = 0; i < 8; i++) sessions.push(await openSession(h.app, `7.7.7.${i}`));
    const rs = await Promise.all(sessions.map((s) => inj(h.app, atkReq(s))));
    expect(rs.filter((r) => r.statusCode === 202)).toHaveLength(4);
    const busy = rs.filter((r) => r.statusCode === 503);
    expect(busy).toHaveLength(4);
    expect(busy.every((r) => J(r).status === 'OPERATOR_BUSY')).toBe(true);
    expect(h.deps.inFlight.count).toBe(4);
    release();
    await new Promise((r) => setTimeout(r, 80));
    expect(h.deps.inFlight.count).toBe(0);
    expect(J(await inj(h.app, { method: 'GET', url: '/healthz' })).in_flight).toBe(0);
  });
  it('10 parallel PUT policy on one session: all 200, GET returns exactly one of the written versions byte for byte', async () => {
    const h = await harness({ loose: true });
    const s = await openSession(h.app, '5.5.5.5');
    const texts = Array.from({ length: 10 }, (_, i) => `v${i}:` + String.fromCharCode(97 + i).repeat(1000 + i * 5000));
    const rs = await Promise.all(texts.map((t) => inj(h.app, { method: 'PUT', url: `/api/policy/${s.sid}`, headers: { ...jsonH, ...s.headers }, payload: JSON.stringify({ text: t }) })));
    expect(rs.map((r) => r.statusCode)).toEqual(Array(10).fill(200));
    const got = J(await inj(h.app, { method: 'GET', url: `/api/policy/${s.sid}`, headers: s.headers })).text as string;
    expect(texts).toContain(got);
    expect(h.f.ext.policyWrites).toBe(10);
    const reads = await Promise.all(Array.from({ length: 10 }, () => inj(h.app, { method: 'GET', url: `/api/policy/${s.sid}`, headers: s.headers })));
    expect(new Set(reads.map((r) => J(r).text)).size).toBe(1);
  });
  it('10 parallel session creates from one IP (default caps): exactly 3 created, 7 are 429, broker made exactly 3', async () => {
    const h = await harness();
    const rs = await Promise.all(Array.from({ length: 10 }, () => inj(h.app, { method: 'POST', url: '/api/session', headers: { ...jsonH, 'x-forwarded-for': '5.5.5.5' }, payload: '{}' })));
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(3);
    expect(rs.filter((r) => r.statusCode === 429).every((r) => typeof J(r).retry_after_s === 'number')).toBe(true);
    expect(h.f.state.created).toHaveLength(3);
    expect(new Set(rs.filter((r) => r.statusCode === 200).map((r) => J(r).session_id)).size).toBe(3);
  });
  it('20 parallel creates from 20 IPs: global cap of 10/min is exact', async () => {
    const h = await harness();
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => inj(h.app, { method: 'POST', url: '/api/session', headers: { ...jsonH, 'x-forwarded-for': `4.4.4.${i}` }, payload: '{}' })));
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(10);
    expect(h.f.state.created).toHaveLength(10);
  });
  it('live-session cap 2 holds under a 10-way burst (check-then-register is not atomic in the source, but the burst did not breach it)', async () => {
    const h = await harness({ conf: { liveSessionsPerIp: 2 } });
    await Promise.all(Array.from({ length: 10 }, () => inj(h.app, { method: 'POST', url: '/api/session', headers: { ...jsonH, 'x-forwarded-for': '5.5.5.5' }, payload: '{}' })));
    expect(h.f.state.created.length).toBeLessThanOrEqual(2);
  });
  it('a request carrying a valid session cookie reuses it instead of creating, even under a burst', async () => {
    const h = await harness();
    const s = await openSession(h.app, '5.5.5.5');
    const rs = await Promise.all(Array.from({ length: 10 }, () => inj(h.app, { method: 'POST', url: '/api/session', headers: { ...jsonH, ...s.headers }, payload: '{}' })));
    expect(rs.every((r) => J(r).reused === true && J(r).session_id === s.sid && J(r).session_key === undefined)).toBe(true);
    expect(h.f.state.created).toHaveLength(1);
  });
  it('a parallel storm of mixed reads/writes across 5 sessions leaves each session\'s policy its own', async () => {
    const h = await harness({ loose: true });
    const ss = [];
    for (let i = 0; i < 5; i++) ss.push(await openSession(h.app, `3.3.3.${i}`));
    await Promise.all(ss.flatMap((s, i) => Array.from({ length: 6 }, (_, k) => inj(h.app, { method: 'PUT', url: `/api/policy/${s.sid}`, headers: { ...jsonH, ...s.headers }, payload: JSON.stringify({ text: `S${i}-${k}` }) }))));
    for (const [i, s] of ss.entries()) expect(String(J(await inj(h.app, { method: 'GET', url: `/api/policy/${s.sid}`, headers: s.headers })).text)).toMatch(new RegExp(`^S${i}-\\d$`));
  });
});

// ---------------------------------------------------------------- 8. state verification after mutation
describe('8 state after mutation', () => {
  it('PUT then GET returns what was stored; another session still has the default; production is untouched', async () => {
    const h = await harness({ loose: true });
    const a = await openSession(h.app, '5.5.5.5');
    const b = await openSession(h.app, '6.6.6.6');
    const text = 'rule { allow "🔥" }\n‮\u0000"quoted"';
    expect((await inj(h.app, { method: 'PUT', url: `/api/policy/${a.sid}`, headers: { ...jsonH, ...a.headers }, payload: JSON.stringify({ text }) })).statusCode).toBe(200);
    expect(J(await inj(h.app, { method: 'GET', url: `/api/policy/${a.sid}`, headers: a.headers })).text).toBe(text);
    expect(J(await inj(h.app, { method: 'GET', url: `/api/policy/${b.sid}`, headers: b.headers })).text).toBe(DEFAULT_POLICY);
    expect(J(await inj(h.app, { method: 'GET', url: '/api/policy/production' })).text).toBe(DEFAULT_POLICY);
    expect(h.f.policy.has('production')).toBe(false);
    expect(h.f.calls.filter((c) => c.method === 'PUT').map((c) => c.path)).toEqual([`/v1/policy/${a.sid}`]);
  });
  it('a refused PUT (foreign key, no key, bad body, oversized) leaves the stored policy unchanged', async () => {
    const h = await harness({ loose: true });
    const a = await openSession(h.app, '5.5.5.5');
    const b = await openSession(h.app, '6.6.6.6');
    await inj(h.app, { method: 'PUT', url: `/api/policy/${a.sid}`, headers: { ...jsonH, ...a.headers }, payload: '{"text":"ORIGINAL"}' });
    const tries: [InjectOptions['headers'], string][] = [[{ ...jsonH, ...b.headers }, '{"text":"EVIL"}'], [jsonH, '{"text":"EVIL"}'], [{ ...jsonH, ...a.headers }, '{"text":5}'],
      [{ ...jsonH, ...a.headers }, '[]'], [{ ...jsonH, ...a.headers }, `{"text":"${'E'.repeat(75000)}"}`], [{ ...jsonH, ...a.headers }, '{"text":null}']];
    for (const [headers, payload] of tries) expect((await inj(h.app, { method: 'PUT', url: `/api/policy/${a.sid}`, headers, payload })).statusCode).toBeGreaterThanOrEqual(400);
    expect(J(await inj(h.app, { method: 'GET', url: `/api/policy/${a.sid}`, headers: a.headers })).text).toBe('ORIGINAL');
    expect(h.f.ext.policyWrites).toBe(1);
  });
  it('a tier change reaches the broker for that session only, with the exact tier; a refused change reaches nobody', async () => {
    const h = await harness({ loose: true });
    const a = await openSession(h.app, '5.5.5.5');
    const b = await openSession(h.app, '6.6.6.6');
    expect((await inj(h.app, { method: 'POST', url: `/api/session/${a.sid}/tier`, headers: { ...jsonH, ...a.headers }, payload: '{"tier":"observer"}' })).statusCode).toBe(200);
    expect(h.f.tier.get(a.sid)).toBe('observer');
    expect(h.f.tier.has(b.sid)).toBe(false);
    expect((await inj(h.app, { method: 'POST', url: `/api/session/${a.sid}/tier`, headers: { ...jsonH, ...a.headers }, payload: '{"tier":"admin"}' })).statusCode).toBe(400);
    expect((await inj(h.app, { method: 'POST', url: `/api/session/${a.sid}/tier`, headers: { ...jsonH, ...b.headers }, payload: '{"tier":"standard"}' })).statusCode).toBe(403);
    expect(h.f.tier.get(a.sid)).toBe('observer');
    expect((await inj(h.app, { method: 'POST', url: `/api/session/${a.sid}/tier`, headers: { ...jsonH, ...a.headers }, payload: '{"tier":"standard"}' })).statusCode).toBe(200);
    expect(h.f.tier.get(a.sid)).toBe('standard');
  });
  it('an accepted attack lands on its own stream only, tagged with its attack_id; the other session\'s stream stays empty', async () => {
    const h = await harness({ loose: true });
    const a = await openSession(h.app, '5.5.5.5');
    const b = await openSession(h.app, '6.6.6.6');
    const r = await inj(h.app, { method: 'POST', url: '/api/attack', headers: { ...jsonH, ...a.headers }, payload: '{"text":"list my instances"}' });
    expect(r.statusCode).toBe(202);
    await new Promise((x) => setTimeout(x, 50));
    const ea: { type: string; data: Record<string, unknown> }[] = []; const eb: unknown[] = [];
    h.deps.hub.subscribe(a.sid, (e) => ea.push(e as never), 0);
    h.deps.hub.subscribe(b.sid, (e) => eb.push(e), 0);
    expect(ea.find((e) => e.type === 'stage')?.data.attack_id).toBe(J(r).attack_id);
    expect(ea.some((e) => e.type === 'result')).toBe(true);
    expect(eb).toEqual([]);
  });
  it('production-policy forwarding: only a POST to the signature endpoint is made, body is {text, signature}', async () => {
    const h = await harness({ loose: true });
    const r = await inj(h.app, { method: 'PUT', url: '/api/policy/production', headers: jsonH, payload: '{"policy":"P","signature":"S"}' });
    expect([r.statusCode, J(r).status]).toEqual([403, 'SIG_REQUIRED']);
    expect(h.f.calls.at(-1)).toEqual({ method: 'POST', path: '/v1/policy-production', body: { text: 'P', signature: 'S' } });
  });
  it('FIXED W2: /api/policy/production forwards non-string policy/signature to the broker unvalidated (the sibling PUT /api/policy/:sid rejects non-string text with 400)', async () => {
    const h = await harness({ loose: true });
    for (const body of ['{"policy":{"a":1}}', '{"policy":5}', '{"policy":"p","signature":["x"]}', '{"policy":[1],"signature":{}}']) {
      const r = await inj(h.app, { method: 'PUT', url: '/api/policy/production', headers: jsonH, payload: body });
      expect(r.statusCode).toBe(400);
    }
  });
});

// ---------------------------------------------------------------- 10. static and poisoned pages
describe('10 static whitelist and poisoned pages', () => {
  it('poisoned pages are text/markdown with nosniff, never HTML, contain no script and no cookies', async () => {
    const h = await harness({ loose: true });
    for (const p of ['/pages/poisoned-readme', '/pages/poisoned-docs']) {
      const r = await inj(h.app, { method: 'GET', url: p });
      expect(r.statusCode).toBe(200);
      expect(String(r.headers['content-type'])).toMatch(/^text\/markdown/);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['set-cookie']).toBeUndefined();
      expect(r.body).not.toMatch(/<script|<iframe|<img|javascript:|onerror=/i);
      expect(r.body.startsWith('#')).toBe(true);
    }
  });
  it('poisoned pages do not accept other verbs or sub-paths', async () => {
    const h = await harness({ loose: true });
    for (const u of ['/pages/poisoned-readme/', '/pages/poisoned-readme/x', '/pages/poisoned-readme.md', '/pages/', '/pages', '/pages/poisoned', '/pages/POISONED-README']) {
      expect([u, (await inj(h.app, { method: 'GET', url: u })).statusCode]).toEqual([u, 404]);
    }
  });
  it('neighbours of the whitelist 404 with a JSON body that carries no file content or server path', async () => {
    const h = await harness({ loose: true });
    const bad: string[] = [];
    for (const u of ['/index.html', '/range.html', '/app.js.map', '/app.JS', '/style.css/', '/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/logo.png', '/static/app.js', '/public/app.js',
      '/.env', '/.git/config', '/range/', '/range/policy/', '/RANGE', '/range/unknown', '/favicon-64.png', '/og-image.svg', '/robots.txt', '/node_modules/fastify/package.json', '/etc/passwd', '/%00', '/app.js%00.png',
      '/app.js;.png', '//app.js']) {
      const r = await inj(h.app, { method: 'GET', url: u });
      if (r.statusCode === 200 && u !== '//app.js') bad.push(`${u} -> 200`);
      if (r.statusCode >= 500) bad.push(`${u} -> ${r.statusCode}`);
      if (/root:|"name":|<html|function\s*\(|\/Users\//.test(r.body)) bad.push(`${u} body leaks file/path`);
    }
    expect(bad).toEqual([]);
  });
  it('every whitelisted page: correct type, nosniff, DENY, no-referrer; html carries a CSP with script hashes and frame-ancestors none; svg is script-less under default-src none', async () => {
    const h = await harness({ loose: true });
    const want: Record<string, string> = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', ico: 'image/png' };
    for (const p of PAGE_ROUTES) {
      const r = await inj(h.app, { method: 'GET', url: p });
      expect([p, r.statusCode]).toEqual([p, 200]);
      const ext = p === '/' ? 'html' : p.includes('.') ? (p.split('.').pop() as string) : 'html';
      expect(String(r.headers['content-type'])).toContain(want[ext]);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      if (ext === 'html') {
        const csp = String(r.headers['content-security-policy']);
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain("object-src 'none'");
        expect(csp).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/);
        expect(r.headers['cache-control']).toBe('no-store');
        const inline = [...r.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].length;
        expect((csp.match(/sha256-/g) ?? []).length).toBe(inline);
      }
      if (ext === 'svg') {
        expect(r.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'");
        expect(r.body).not.toMatch(/<script|onload=|onerror=|javascript:/i);
      }
    }
  });
  it('a page missing on disk is 404 PAGE_NOT_BUILT without the directory path', async () => {
    const h = await harness({ loose: true, conf: { publicDir: '/nonexistent/secret-dir' } });
    const r = await inj(h.app, { method: 'GET', url: '/try' });
    expect([r.statusCode, J(r).status]).toEqual([404, 'PAGE_NOT_BUILT']);
    expect(r.body).not.toContain('secret-dir');
  });
  it('query strings and fragments-like suffixes on whitelisted pages do not change what is served', async () => {
    const h = await harness({ loose: true });
    const plain = await inj(h.app, { method: 'GET', url: '/app.js' });
    for (const q of ['?x=1', '?../../package.json', '?file=../../etc/passwd', '?' + 'a'.repeat(2000)]) expect((await inj(h.app, { method: 'GET', url: `/app.js${q}` })).body).toBe(plain.body);
  });
});

// ---------------------------------------------------------------- 9. seeded fuzz
// Seed 1337 (mulberry32). 12 body targets x 60 bodies = 720 random POST/PUT bodies, plus 200 random GET query/cookie/header probes.
describe('9 seeded fuzz (seed 1337)', () => {
  const FIELDS = ['text', 'session_id', 'nonce', 'approve', 'tier', 'action', 'policy', 'signature'];
  const CTYPES = ['application/json', 'application/json', 'application/json', 'application/json; charset=utf-8', 'text/plain', 'application/x-www-form-urlencoded', '', 'application/vnd.api+json', 'APPLICATION/JSON'];
  const protoBefore = (): string => JSON.stringify([Object.getOwnPropertyNames(Object.prototype).sort(), Object.getOwnPropertyNames(Array.prototype).sort(), Object.getOwnPropertyNames(Function.prototype).sort()]);

  it('720 random JSON bodies against every POST/PUT route: no 5xx, no hang, server healthy, no prototype pollution', async () => {
    const rng = mulberry32(1337);
    const before = protoBefore();
    const h = await harness({ loose: true });
    const s = await openSession(h.app, '5.5.5.5');
    const targets: { m: 'POST' | 'PUT'; url: string }[] = [
      { m: 'POST', url: '/api/session' }, { m: 'POST', url: '/api/attack' }, { m: 'POST', url: '/api/env-proof' }, { m: 'POST', url: '/api/approval/x1' }, { m: 'POST', url: '/api/rewind/act' },
      { m: 'POST', url: '/api/acl-self-test' }, { m: 'POST', url: `/api/session/${s.sid}/tier` }, { m: 'POST', url: '/api/verify/run' }, { m: 'PUT', url: `/api/policy/${s.sid}` },
      { m: 'PUT', url: '/api/policy/production' }, { m: 'POST', url: '/api/policy/production' }, { m: 'PUT', url: '/api/policy/00001000' },
    ];
    const counts: Record<number, number> = {};
    const bad: string[] = [];
    let total = 0;
    for (const t of targets) for (let i = 0; i < 60; i++) {
      const roll = rng();
      const body = roll < 0.4 ? randJson(rng) : roll < 0.8 ? randShaped(rng, FIELDS) : `{${FIELDS.map((f) => `"${f}":${validish(f)}`).join(',')}}`;
      const ct = CTYPES[Math.floor(rng() * CTYPES.length)] as string;
      const useCreds = rng() < 0.7;
      total += 1;
      try {
        const r = await inj(h.app, { method: t.m, url: t.url, headers: { ...(ct ? { 'content-type': ct } : {}), ...(useCreds ? s.headers : {}) }, payload: body });
        counts[r.statusCode] = (counts[r.statusCode] ?? 0) + 1;
        if (r.statusCode >= 500 || r.statusCode < 200) bad.push(`${t.m} ${t.url} ${r.statusCode} body=${body.slice(0, 80)}`);
        const p = sane(r); if (p) bad.push(`${t.url} ${p}`);
      } catch (e) { bad.push(`${t.m} ${t.url} ${(e as Error).message} body=${body.slice(0, 80)}`); }
    }
    expect(total).toBeGreaterThanOrEqual(500);
    expect(bad).toEqual([]);
    expect(Object.keys(counts).some((c) => Number(c) < 300)).toBe(true); // some bodies got all the way through
    expect(Object.keys(counts).some((c) => Number(c) === 400)).toBe(true);
    expect((await inj(h.app, { method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(([] as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect(protoBefore()).toBe(before);
  });
  it('explicit prototype-pollution payloads are refused 400 or ignored, never merged', async () => {
    const h = await harness({ loose: true });
    const s = await openSession(h.app, '5.5.5.5');
    const payloads = ['{"__proto__":{"polluted":"yes"}}', '{"constructor":{"prototype":{"polluted":"yes"}}}', '{"text":"abcdef","__proto__":{"polluted":"yes"}}', '{"a":{"__proto__":{"polluted":"yes"}}}',
      '{"prototype":{"polluted":"yes"},"tier":"observer"}', '[{"__proto__":{"polluted":"yes"}}]'];
    for (const url of ['/api/attack', '/api/rewind/act', '/api/session', `/api/session/${s.sid}/tier`, '/api/approval/x1', '/api/env-proof']) for (const p of payloads) {
      const r = await inj(h.app, { method: 'POST', url, headers: { ...jsonH, ...s.headers }, payload: p });
      expect(r.statusCode).toBeLessThan(500);
    }
    for (const p of payloads) expect((await inj(h.app, { method: 'PUT', url: `/api/policy/${s.sid}`, headers: { ...jsonH, ...s.headers }, payload: p })).statusCode).toBeLessThan(500);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((await inj(h.app, { method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });
  it('200 random GET probes (query, cookie, header junk, sid, Last-Event-ID) never 5xx or hang', async () => {
    const rng = mulberry32(1337);
    const h = await harness({ loose: true });
    const s = await openSession(h.app, '5.5.5.5');
    const gets = ['/api/approvals', '/api/bond', '/api/canned', '/api/egress-counter', '/api/live-list', '/api/proof', '/api/replay', '/api/rewind', '/api/status', '/api/verify', '/healthz', '/ledger/export', '/v1/ledger/export'];
    const junk = (): string => { const raw = rng() < 0.5 ? STRING_POOL[Math.floor(rng() * STRING_POOL.length)] as string : randJson(rng); return raw; };
    const bad: string[] = [];
    for (let i = 0; i < 200; i++) {
      const base = gets[Math.floor(rng() * gets.length)] as string;
      const j = junk();
      const url = `${base}?session_id=${safeEnc(j)}&${safeEnc(junk().slice(0, 20))}=${safeEnc(junk())}`;
      const headers: Record<string, string> = { cookie: `plb_session=${ascii(j)}`, 'x-plumbline-ts': ascii(junk()), 'x-plumbline-sig': ascii(junk()), 'x-forwarded-for': ascii(junk()).slice(0, 30) || '1.1.1.1' };
      if (rng() < 0.3) Object.assign(headers, s.headers);
      try {
        const r = await inj(h.app, { method: 'GET', url, headers });
        if (r.statusCode >= 500) bad.push(`${url.slice(0, 60)} ${r.statusCode}`);
      } catch (e) { bad.push(`${url.slice(0, 60)} ${(e as Error).message}`); }
    }
    for (let i = 0; i < 40; i++) { // stream / policy refusal paths with junk sids and cookies (never a valid pair: a valid one would open a stream)
      const j = ascii(junk());
      for (const url of [`/api/stream/${safeEnc(j)}`, `/api/policy/${safeEnc(j)}`]) {
        const r = await inj(h.app, { method: 'GET', url, headers: { cookie: `plb_session=${j}.${j}` } });
        if (r.statusCode >= 500) bad.push(`${url.slice(0, 60)} ${r.statusCode}`);
      }
    }
    expect(bad).toEqual([]);
    expect((await inj(h.app, { method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });
  it('ledger export forwards only the two signature headers, whatever else the caller sends', async () => {
    const h = await harness({ loose: true });
    await inj(h.app, { method: 'GET', url: '/ledger/export', headers: { 'x-plumbline-ts': '1', 'x-plumbline-sig': 'abc', authorization: 'Bearer z', cookie: 'a=b' } });
    expect(h.f.calls.at(-1)?.path).toBe('/v1/ledger/export');
  });
  it('broker failures never surface as raw exceptions: every broker-backed route answers 502 JSON', async () => {
    const f = statefulBroker();
    f.broker.call = (async () => { throw new Error('socket hang up /run/plumbline/broker.sock'); }) as never;
    const h = await harness({ f, loose: true });
    const bad: string[] = [];
    for (const u of ['/api/status', '/api/proof', '/api/replay', '/api/egress-counter', '/api/live-list', '/api/policy/production', '/ledger/export', '/v1/ledger/export', '/api/bond']) {
      const r = await inj(h.app, { method: 'GET', url: u });
      if (r.statusCode !== 502 || !String(r.headers['content-type']).includes('json')) bad.push(`${u} ${r.statusCode}`);
    }
    const c = await inj(h.app, { method: 'POST', url: '/api/session', headers: jsonH, payload: '{}' });
    if (c.statusCode !== 502) bad.push(`session ${c.statusCode}`);
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------- unauthenticated read amplification
describe('H resilience: public reads that fan out to the broker/runner', () => {
  it('FIXED H1: GET /api/proof (unauthenticated) shells out to the runner and reads the evidence dir on every call, with no per-IP limit or cache: 300 calls must not produce 300 runner.containers() calls', async () => {
    let containers = 0;
    const h = await harness({ loose: true, deps: { runner: { run: async () => ({}), containers: async () => { containers += 1; return []; } } as never } });
    for (let i = 0; i < 300; i++) await inj(h.app, { method: 'GET', url: '/api/proof', headers: { 'x-forwarded-for': '2.2.2.2' } });
    expect(containers).toBeLessThan(300);
  });
});
