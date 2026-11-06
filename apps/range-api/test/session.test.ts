// File: apps/range-api/test/session.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cfg, fakeBroker, makeApi, openSession } from './support.ts';

const approve = (app: Awaited<ReturnType<typeof makeApi>>['app'], id: string, headers: Record<string, string>, body: object) =>
  app.inject({ method: 'POST', url: `/api/approval/${id}`, headers, payload: body });

describe('AG4-PRD-5: session creation is limited (each session creates a real playground)', () => {
  it('AG4-PRD-5 per-IP: the 4th session from one address in the window is RATE_LIMITED and never reaches the broker', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await app.inject({ method: 'POST', url: '/api/session', headers: { 'x-forwarded-for': '9.9.9.9' }, payload: {} })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    expect(f.state.created).toHaveLength(3);
  });

  it('AG4-PRD-5 per-IP: a client-forged left-hand X-Forwarded-For cannot dodge the limit (only the proxy-appended address counts)', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await app.inject({ method: 'POST', url: '/api/session', headers: { 'x-forwarded-for': `6.6.6.${i}, 9.9.9.9` }, payload: {} })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
  });

  it('AG4-PRD-5 per-IP: another address is not affected by the first one hitting its limit', async () => {
    const { app } = await makeApi(fakeBroker());
    for (let i = 0; i < 4; i++) await app.inject({ method: 'POST', url: '/api/session', headers: { 'x-forwarded-for': '9.9.9.9' }, payload: {} });
    const other = await app.inject({ method: 'POST', url: '/api/session', headers: { 'x-forwarded-for': '8.8.8.8' }, payload: {} });
    expect(other.statusCode).toBe(200);
  });

  it('AG4-PRD-5 global per-minute cap: many addresses cannot create more than the global allowance', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f, {}, { ...cfg, sessionsPerMinute: 2 });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await app.inject({ method: 'POST', url: '/api/session', headers: { 'x-forwarded-for': `7.7.7.${i}` }, payload: {} })).statusCode);
    expect(codes).toEqual([200, 200, 429, 429]);
    expect(f.state.created).toHaveLength(2);
  });

  it('AG4-PRD-5 session cap: no new playground while the broker already holds the maximum', async () => {
    const f = fakeBroker({ sessions: 20 });
    const { app } = await makeApi(f);
    const r = await app.inject({ method: 'POST', url: '/api/session', payload: {} });
    expect([r.statusCode, r.json().status]).toEqual([503, 'SESSION_CAP']);
    expect(f.state.created).toHaveLength(0);
  });

  it('AG4-PRD-5 a dead broker is a 502, not a session', async () => {
    const { app } = await makeApi(fakeBroker(), { broker: { call: async () => { throw new Error('ENOENT'); }, chat: async () => { throw new Error('x'); }, mint: async () => { throw new Error('x'); } } as never });
    expect((await app.inject({ method: 'POST', url: '/api/session', payload: {} })).statusCode).toBe(502);
  });

  it('AG4-PRD-5 per-IP spend: a new session does not reset the address allowance (about 7 fresh ceilings cannot drain the global cap)', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const s1 = await openSession(app, '5.5.5.5');
    f.state.spend[s1.sid] = 1.5;
    const attack = await app.inject({ method: 'POST', url: '/api/attack', headers: s1.headers, payload: { session_id: s1.sid, text: 'provision a 64 vCPU node' } });
    expect([attack.statusCode, attack.json().status]).toEqual([429, 'IP_SPEND_CAP']);
    const fresh = await app.inject({ method: 'POST', url: '/api/session', headers: { 'x-forwarded-for': '5.5.5.5' }, payload: {} });
    expect([fresh.statusCode, fresh.json().status]).toEqual([429, 'IP_SPEND_CAP']);
    expect(f.state.created).toHaveLength(1);
  });

  it('AG4-PRD-5 per-IP spend adds up across the address sessions, and other addresses keep their own allowance', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const a = await openSession(app, '5.5.5.5');
    const b = await openSession(app, '5.5.5.5');
    f.state.spend[a.sid] = 0.8;
    f.state.spend[b.sid] = 0.8;
    const blocked = await app.inject({ method: 'POST', url: '/api/attack', headers: b.headers, payload: { session_id: b.sid, text: 'delete prod-db' } });
    expect(blocked.json().status).toBe('IP_SPEND_CAP');
    const c = await openSession(app, '6.6.6.6');
    const fine = await app.inject({ method: 'POST', url: '/api/attack', headers: c.headers, payload: { session_id: c.sid, text: 'delete prod-db' } });
    expect(fine.statusCode).toBe(202);
  });

  it('AG4-PRD-5 an unreadable spend figure fails closed', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const s = await openSession(app);
    const real = f.broker.call;
    f.broker.call = async (m: string, p: string, b?: unknown) => (p.startsWith('/v1/spend/') ? { status: 200, json: { oops: true } } : real(m, p, b));
    const r = await app.inject({ method: 'POST', url: '/api/attack', headers: s.headers, payload: { session_id: s.sid, text: 'delete prod-db' } });
    expect(r.json().status).toBe('IP_SPEND_CAP');
  });
});

describe('AG4-PRD-6 / AG4-BRK-3: approvals and mutations belong to the session that made them', () => {
  const pending = (sid: string, call: { verb: string; class: string; id?: string }) => ({ [sid]: [{ decision_id: 'd-1', nonce: 'n1', call }] });
  const shared = { verb: 'delete', class: 'bucket_object' };

  it('AG4-PRD-6 the session id alone is not enough: no key is 401, a foreign key is 403, an unknown id is 403', async () => {
    const { app } = await makeApi(fakeBroker());
    const mine = await openSession(app, '1.1.1.1');
    const theirs = await openSession(app, '2.2.2.2');
    const body = { nonce: 'n', approve: false };
    expect((await approve(app, 'd-1', { 'x-plumbline-session-id': mine.sid }, body)).statusCode).toBe(401);
    const cross = await approve(app, 'd-1', { 'x-plumbline-session-id': mine.sid, 'x-plumbline-session-key': theirs.key }, body);
    expect([cross.statusCode, cross.json().status]).toEqual([403, 'SESSION_KEY_MISMATCH']);
    const unknown = await approve(app, 'd-1', { 'x-plumbline-session-id': 'deadbeef', 'x-plumbline-session-key': theirs.key }, body);
    expect([unknown.statusCode, unknown.json().status]).toEqual([403, 'SESSION_UNKNOWN']);
  });

  it('AG4-PRD-6 the approval sent to the broker carries the caller own session id, and a client-named one is ignored', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const mine = await openSession(app, '1.1.1.1');
    const theirs = await openSession(app, '2.2.2.2');
    await approve(app, 'd-7', mine.headers, { session_id: theirs.sid, nonce: 'n9', approve: true });
    const sent = f.calls.find((c) => c.path === '/v1/approval/d-7');
    expect(sent?.body).toEqual({ session_id: mine.sid, nonce: 'n9', approve: true });
  });

  it('AG4-PRD-6 the cookie issued at creation alone authorises the browser, no body session id needed', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const created = await app.inject({ method: 'POST', url: '/api/session', headers: { 'x-forwarded-for': '3.3.3.3' }, payload: {} });
    const cookie = String(created.headers['set-cookie']);
    expect(cookie).toMatch(/^plb_session=[0-9a-f]{8}\.[0-9a-f]{32}; Path=\/; HttpOnly; SameSite=Strict/);
    const sid = created.json().session_id as string;
    const r = await app.inject({ method: 'POST', url: '/api/approval/d-3', headers: { cookie: cookie.split(';')[0] as string }, payload: { nonce: 'n', approve: false } });
    expect(r.statusCode).toBe(200);
    expect(f.calls.find((c) => c.path === '/v1/approval/d-3')?.body).toEqual({ session_id: sid, nonce: 'n', approve: false });
  });

  it('AG4-PRD-6 a second POST /api/session with a live cookie reuses the session and creates no new playground', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const created = await app.inject({ method: 'POST', url: '/api/session', payload: {} });
    const cookie = String(created.headers['set-cookie']).split(';')[0] as string;
    const again = await app.inject({ method: 'POST', url: '/api/session', headers: { cookie }, payload: {} });
    expect(again.json()).toEqual({ session_id: created.json().session_id, reused: true });
    expect(again.json().session_key).toBeUndefined();
    expect(f.state.created).toHaveLength(1);
  });

  it('AG4-PRD-6 approving the delete of the shared canary orders.json is refused, nothing is forwarded', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const mine = await openSession(app);
    for (const call of [shared, { ...shared, id: 'orders.json' }]) {
      f.state.approvals = pending(mine.sid, call);
      const r = await approve(app, 'd-1', mine.headers, { nonce: 'n1', approve: true });
      expect([r.statusCode, r.json().status]).toEqual([409, 'SHARED_CANARY_APPROVAL_REFUSED']);
    }
    expect(f.calls.some((c) => c.path.startsWith('/v1/approval/'))).toBe(false);
  });

  it('AG4-PRD-6 the pending list tells the UI which approvals are allowed (shared canary: deny only)', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const mine = await openSession(app);
    f.state.approvals = { [mine.sid]: [
      { decision_id: 'd-a', nonce: 'a', call: shared },
      { decision_id: 'd-b', nonce: 'b', call: { ...shared, id: `sessions/${mine.sid}/orders.json` } },
    ] };
    const r = await app.inject({ method: 'GET', url: '/api/approvals', headers: mine.headers });
    expect(r.json().map((p: { decision_id: string; approve_allowed: boolean }) => [p.decision_id, p.approve_allowed])).toEqual([['d-a', false], ['d-b', true]]);
  });

  it('AG4-PRD-6 the pending list (with its nonces) is never readable by naming another session', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const mine = await openSession(app, '1.1.1.1');
    const theirs = await openSession(app, '2.2.2.2');
    f.state.approvals = pending(theirs.sid, shared);
    const r = await app.inject({ method: 'GET', url: `/api/approvals?session_id=${theirs.sid}`, headers: mine.headers });
    expect(r.json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/approvals' })).statusCode).toBe(401);
  });

  it('AG4-PRD-6 a per-session canary delete (sessions/<id>/orders.json) can be approved', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const mine = await openSession(app);
    f.state.approvals = pending(mine.sid, { ...shared, id: `sessions/${mine.sid}/orders.json` });
    const r = await approve(app, 'd-1', mine.headers, { nonce: 'n1', approve: true });
    expect([r.statusCode, r.json().status]).toEqual([200, 'DECIDED']);
  });

  it('AG4-PRD-6 denying the shared-canary escalation is still allowed and reaches the broker', async () => {
    const f = fakeBroker({ approvalStatus: 'DENIED' });
    const { app } = await makeApi(f);
    const mine = await openSession(app);
    f.state.approvals = pending(mine.sid, shared);
    const r = await approve(app, 'd-1', mine.headers, { nonce: 'n1', approve: false });
    expect([r.statusCode, r.json().status]).toEqual([200, 'DENIED']);
  });

  it('AG4-PRD-6 an approval whose pending list cannot be read fails closed (502)', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const mine = await openSession(app);
    const real = f.broker.call;
    f.broker.call = async (m: string, p: string, b?: unknown) => { if (p.startsWith('/v1/approvals')) throw new Error('down'); return real(m, p, b); };
    const r = await approve(app, 'd-1', mine.headers, { nonce: 'n1', approve: true });
    expect(r.statusCode).toBe(502);
    expect(f.calls.some((c) => c.path.startsWith('/v1/approval/'))).toBe(false);
  });

  it('AG4-PRD-6 a non-bucket escalation (an instance create) can still be approved', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const mine = await openSession(app);
    f.state.approvals = pending(mine.sid, { verb: 'create', class: 'instance' });
    const r = await approve(app, 'd-1', mine.headers, { nonce: 'n1', approve: true });
    expect([r.statusCode, r.json().status]).toEqual([200, 'DECIDED']);
  });

  it('AG4-BRK-5 STALE (the world changed since the escalation) is a 409 the UI can show', async () => {
    const { app } = await makeApi(fakeBroker({ approvalStatus: 'STALE' }));
    const mine = await openSession(app);
    const r = await approve(app, 'd-2', mine.headers, { nonce: 'n2', approve: true });
    expect([r.statusCode, r.json().status]).toEqual([409, 'STALE']);
  });

  it('AG4-BRK-3 NOT_FOUND (a decision of another session, expired, or used) is a 404, and BAD_NONCE a 403', async () => {
    const f = fakeBroker({ approvalStatus: 'NOT_FOUND' });
    const { app } = await makeApi(f);
    const mine = await openSession(app);
    const nf = await approve(app, 'd-other', mine.headers, { nonce: 'n', approve: true });
    expect([nf.statusCode, nf.json().status]).toEqual([404, 'NOT_FOUND']);
    f.state.approvalStatus = 'BAD_NONCE';
    const bn = await approve(app, 'd-other', mine.headers, { nonce: 'n', approve: true });
    expect([bn.statusCode, bn.json().status]).toEqual([403, 'BAD_NONCE']);
  });

  it('AG4-BRK-5 STALE is announced on the session stream; a decided approval publishes verdicts instead', async () => {
    const f = fakeBroker({ approvalStatus: 'STALE' });
    const { app, deps } = await makeApi(f);
    const mine = await openSession(app);
    await approve(app, 'd-2', mine.headers, { nonce: 'n2', approve: true });
    const seen: string[] = [];
    deps.hub.subscribe(mine.sid, (e) => seen.push(`${e.type}:${JSON.stringify(e.data)}`));
    expect(seen).toContain('approval:{"decision_id":"d-2","status":"STALE"}');
  });

  it('AG4-PRD-6 malformed approval bodies are ARGS_INVALID before any broker call', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const mine = await openSession(app);
    const before = f.calls.length;
    for (const body of [{}, { nonce: 'n', approve: 'yes' }, { nonce: 5, approve: true }]) {
      expect((await approve(app, 'd-1', mine.headers, body)).statusCode).toBe(400);
    }
    expect((await approve(app, 'bad id!', mine.headers, { nonce: 'n', approve: true })).statusCode).toBe(400);
    expect(f.calls.length).toBe(before);
  });

  it('AG4-BRK-3 an attack naming another session is refused (SESSION_MISMATCH) and nothing runs', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const mine = await openSession(app, '1.1.1.1');
    const theirs = await openSession(app, '2.2.2.2');
    const r = await app.inject({ method: 'POST', url: '/api/attack', headers: mine.headers, payload: { session_id: theirs.sid, text: 'delete prod-db' } });
    expect([r.statusCode, r.json().status]).toEqual([403, 'SESSION_MISMATCH']);
  });

  it('AG4-BRK-3 rewind, ACL self-test, tier and env-proof all need the caller own key', async () => {
    const f = fakeBroker();
    const runner = { run: async () => ({ state: 'EXITED', destroyed: true, stdout: '' }), containers: async () => [] };
    const { app } = await makeApi(f, { runner: runner as never });
    const mine = await openSession(app, '1.1.1.1');
    const other = await openSession(app, '2.2.2.2');
    const stolen = { 'x-plumbline-session-id': mine.sid, 'x-plumbline-session-key': other.key };
    const attempts: [string, object][] = [
      ['/api/rewind/act', { action: 'delete' }],
      ['/api/acl-self-test', { session_id: mine.sid }],
      [`/api/session/${mine.sid}/tier`, { tier: 'observer' }],
      ['/api/env-proof', { session_id: mine.sid }],
    ];
    for (const [url, payload] of attempts) {
      expect((await app.inject({ method: 'POST', url, payload })).statusCode, url).toBe(401);
      expect((await app.inject({ method: 'POST', url, headers: stolen, payload })).statusCode, url).toBe(403);
      expect((await app.inject({ method: 'POST', url, headers: mine.headers, payload })).statusCode, url).toBeLessThan(400);
    }
  });

  it('AG4-BRK-3 GET /api/rewind reads only the caller own canary and never falls back to system', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const mine = await openSession(app);
    expect((await app.inject({ method: 'GET', url: '/api/rewind' })).statusCode).toBe(401);
    await app.inject({ method: 'GET', url: '/api/rewind?session_id=system', headers: mine.headers });
    expect(f.calls.filter((c) => c.path.startsWith('/v1/rewind')).map((c) => c.path)).toEqual([`/v1/rewind?session_id=${mine.sid}`]);
  });

  it('AG4-BRK-3 rewind/act accepts only delete or restore and ignores a client-named session', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const mine = await openSession(app, '1.1.1.1');
    const theirs = await openSession(app, '2.2.2.2');
    expect((await app.inject({ method: 'POST', url: '/api/rewind/act', headers: mine.headers, payload: { action: 'wipe' } })).statusCode).toBe(400);
    await app.inject({ method: 'POST', url: '/api/rewind/act', headers: mine.headers, payload: { action: 'restore', session_id: theirs.sid } });
    expect(f.calls.find((c) => c.path === '/v1/rewind/act')?.body).toEqual({ session_id: mine.sid, action: 'restore' });
  });

  it('the session stream only opens for a known session id', async () => {
    const { app } = await makeApi(fakeBroker());
    expect((await app.inject({ method: 'GET', url: '/api/stream/not-a-session' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/stream/deadbeef' })).statusCode).toBe(404);
  });
});

describe('PLAYGROUND-CAP the capacity answer reaches the page unchanged', () => {
  const error = { code: 'PLAYGROUND_CAPACITY', detail: 'every playground region (ewr, ord) already holds 4 live playgrounds; no VPC was requested' };
  it('PLAYGROUND-CAP /api/session passes playground and playground_error through unchanged', async () => {
    const f = fakeBroker({ sessionExtra: { playground_error: error } });
    const { app } = await makeApi(f);
    const r = await app.inject({ method: 'POST', url: '/api/session', payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ playground: null, playground_error: error });
  });
  it('PLAYGROUND-CAP app.js shows a plain notice for PLAYGROUND_CAPACITY with textContent only and points at /replay', () => {
    const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    expect(js).toContain('PLAYGROUND_CAPACITY');
    expect(js).toMatch(/hot-edit playground is at capacity/);
    expect(js).toMatch(/attacks still run/);
    expect(js).toMatch(/\/replay/);
    expect(js).not.toMatch(/innerHTML/);
  });
});

describe('BOND-PER-SESSION range-api', () => {
  it('BOND-PER-SESSION GET /api/bond reads only the caller own session and ignores a client-named one', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const mine = await openSession(app, '1.1.1.1');
    const theirs = await openSession(app, '2.2.2.2');
    await app.inject({ method: 'GET', url: `/api/bond?session_id=${theirs.sid}`, headers: mine.headers });
    expect(f.calls.filter((c) => c.path.startsWith('/v1/bond')).map((c) => c.path)).toEqual([`/v1/bond?session_id=${mine.sid}`]);
  });
  it('BOND-PER-SESSION GET /api/bond without credentials asks the broker for the counts-only aggregate, with a wrong key it is refused', async () => {
    const f = fakeBroker();
    const { app } = await makeApi(f);
    const mine = await openSession(app, '1.1.1.1');
    const other = await openSession(app, '2.2.2.2');
    expect((await app.inject({ method: 'GET', url: `/api/bond?session_id=${mine.sid}` })).statusCode).toBe(200);
    expect(f.calls.filter((c) => c.path.startsWith('/v1/bond')).map((c) => c.path)).toEqual(['/v1/bond']);
    const stolen = { 'x-plumbline-session-id': mine.sid, 'x-plumbline-session-key': other.key };
    expect((await app.inject({ method: 'GET', url: '/api/bond', headers: stolen })).statusCode).toBe(403);
  });
});
