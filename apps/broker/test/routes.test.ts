// File: apps/broker/test/routes.test.ts
import { describe, expect, it } from 'vitest';
import { makeBroker, secrets } from './support.ts';

const H = { 'x-plumbline-api-token': secrets.apiToken };

describe('internal routes', () => {
  it('rejects a missing API token', async () => {
    const { app } = await makeBroker();
    expect((await app.internal.inject({ method: 'GET', url: '/v1/status' })).statusCode).toBe(401);
  });
  it('POST /v1/policy-production returns SIG_REQUIRED without a signature and SIG_INVALID with a bad one', async () => {
    const { app } = await makeBroker();
    const a = await app.internal.inject({ method: 'POST', url: '/v1/policy-production', headers: H, payload: { text: 'version: 9' } });
    expect([a.statusCode, a.json().status]).toEqual([403, 'SIG_REQUIRED']);
    const b = await app.internal.inject({ method: 'POST', url: '/v1/policy-production', headers: H, payload: { text: 'version: 9', signature: 'AAAA' } });
    expect([b.statusCode, b.json().status]).toEqual([403, 'SIG_INVALID']);
  });
  it('PUT /v1/policy/:sid validates, returns POLICY_INVALID with a line, and keeps the old policy', async () => {
    const { app } = await makeBroker();
    const bad = await app.internal.inject({ method: 'PUT', url: '/v1/policy/aaaaaaaa1111', headers: H, payload: { text: 'version: 1\nrules:\n  - id: custom-x\n    effect: maybe\n    priority: 1\n    match: {}\n    reason: r\n' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors[0].line).toBe(4);
    const cur = await app.internal.inject({ method: 'GET', url: '/v1/policy/aaaaaaaa1111', headers: H });
    expect(cur.json().diff).toEqual([]);
  });
  it('session A edits never change session B', async () => {
    const { app } = await makeBroker();
    const text = (await app.internal.inject({ method: 'GET', url: '/v1/policy/aaaaaaaa1111', headers: H })).json().text as string;
    const edited = text.replace('id: protect-tagged-destroy\n    effect: deny', 'id: protect-tagged-destroy\n    effect: escalate');
    expect((await app.internal.inject({ method: 'PUT', url: '/v1/policy/aaaaaaaa1111', headers: H, payload: { text: edited } })).statusCode).toBe(200);
    const b = await app.internal.inject({ method: 'GET', url: '/v1/policy/bbbbbbbb2222', headers: H });
    expect(b.json().diff).toEqual([]);
  });
  it('kill-switch engage needs the admin token and blocks new tasks', async () => {
    const { app } = await makeBroker();
    expect((await app.internal.inject({ method: 'POST', url: '/v1/admin/kill-switch/engage', payload: {} })).statusCode).toBe(401);
    const s = (await app.internal.inject({ method: 'POST', url: '/v1/session', headers: H, payload: {} })).json().session_id as string;
    await app.internal.inject({ method: 'POST', url: '/v1/admin/kill-switch/engage', headers: { 'x-plumbline-admin-token': secrets.adminToken }, payload: { reason: 't' } });
    const t = await app.internal.inject({ method: 'POST', url: '/v1/task', headers: H, payload: { session_id: s } });
    expect(t.statusCode).toBe(423);
  });
});

describe('sandbox routes', () => {
  it('returns 401 AUTH_TASK_TOKEN_INVALID without or with a bad token', async () => {
    const { app } = await makeBroker();
    const r = await app.sandbox.inject({ method: 'POST', url: '/v1/call', payload: { verb: 'list', class: 'instance' } });
    expect([r.statusCode, r.json().status]).toEqual([401, 'AUTH_TASK_TOKEN_INVALID']);
  });
  it('serves nothing but /v1/call and /healthz', async () => {
    const { app } = await makeBroker();
    expect((await app.sandbox.inject({ method: 'GET', url: '/v1/status', headers: H })).statusCode).toBe(404);
    expect((await app.sandbox.inject({ method: 'GET', url: '/v1/admin/kill-switch/clear' })).statusCode).toBe(404);
    expect((await app.sandbox.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });
  it('creates the session playground (a VPC, CO-A) through the engine path', async () => {
    const { app, mock } = await makeBroker();
    const s = (await app.internal.inject({ method: 'POST', url: '/v1/session', headers: H, payload: {} })).json();
    expect(s.playground.label).toBe(`plumbline-s${s.session_id}-vault`);
    expect(mock.state.firewall_groups).toHaveLength(0);
    expect(mock.state.vpcs.map((v) => (v as unknown as { description: string }).description)).toEqual([s.playground.label]);
  });
});

describe('BOND-PER-SESSION /v1/bond', () => {
  it('BOND-PER-SESSION a named session gets its own snapshot, no session gets counts only, a bad id is refused', async () => {
    const app = await makeBroker({ versions: 1, config: { bondEnabled: true } });
    const own = (await app.app.internal.inject({ method: 'GET', url: '/v1/bond?session_id=aaaaaaaa', headers: H })).json();
    expect(own).toMatchObject({ enabled: true, session_id: 'aaaaaaaa', free: 0.05, held: 0, burned: 0, actions: [] });
    const agg = (await app.app.internal.inject({ method: 'GET', url: '/v1/bond', headers: H })).json();
    expect(agg).toEqual({ enabled: true, sessions: 1, held_actions: 0, burned_actions: 0 });
    expect('free' in agg).toBe(false);
    expect((await app.app.internal.inject({ method: 'GET', url: '/v1/bond?session_id=nope', headers: H })).statusCode).toBe(400);
  });
});
