// File: apps/broker/test/security-review.test.ts
// Independent security review (opus) findings F1..F5 for the broker. Each test is named SEC-<id>.
import { describe, expect, it } from 'vitest';
import { makeBroker, secrets } from './support.ts';

const H = { 'x-plumbline-api-token': secrets.apiToken };
type Built = Awaited<ReturnType<typeof makeBroker>>;
type Created = { session_id: string; playground: { id: string } | null };
const newSession = async (app: Built['app']): Promise<Created> => (await app.internal.inject({ method: 'POST', url: '/v1/session', headers: H, payload: {} })).json();
const vpcs = (mock: Built['mock']) => mock.state.vpcs as unknown as { id: string; description: string }[];
const fws = (mock: Built['mock']) => mock.state.firewall_groups as unknown as { id: string; description: string }[];
const call = (verb: string, cls: string, id?: string, params: Record<string, unknown> = {}) => ({ verb, class: cls, target: id ? { id } : {}, params });
const vpcParams = (label: string, n = 1) => ({ label, region: 'ewr', subnet: `10.50.${n}.0`, subnet_size: 24 });
const ruleOf = (o: { status: string }): string | undefined => (o.status === 'DECIDED' ? (o as unknown as { decision: { rule_id: string } }).decision.rule_id : undefined);
const dec = (o: { status: string }): string | undefined => (o.status === 'DECIDED' ? (o as unknown as { decision: { decision: string } }).decision.decision : o.status);

describe('SEC-F1 sessions that own a playground still expire', () => {
  it('SEC-F1 reap() every simulated minute lets an idle session expire at the idle limit and frees its playground', async () => {
    let now = 1_000_000;
    const { app, mock } = await makeBroker({ clock: () => now, config: { sessionIdleMs: 600_000 } });
    const s = await newSession(app);
    expect(vpcs(mock)).toHaveLength(1);
    for (let m = 1; m <= 9; m++) { now += 60_000; await app.reap(); }
    expect(app.sessions.count()).toBe(1);
    for (let m = 10; m <= 12; m++) { now += 60_000; await app.reap(); }
    expect(app.sessions.count()).toBe(0);
    expect(vpcs(mock)).toHaveLength(0);
    expect(s.playground).not.toBeNull();
  });
  it('SEC-F1 has() answers existence and never refreshes last_seen', async () => {
    let now = 5_000;
    const { app } = await makeBroker({ clock: () => now });
    const s = app.sessions.create();
    now += 100;
    expect(app.sessions.has(s.id)).toBe(true);
    expect(app.sessions.has('deadbeef')).toBe(false);
    expect(app.sessions.expired(50).map((x) => x.id)).toEqual([s.id]);
  });
});

describe('SEC-F2 judge-created networks are scoped, floor-guarded and cleaned up', () => {
  const sidA = 'a1b2c3d4';
  const claimsA = { task_id: 't1', session_id: sidA };
  it('SEC-F2a a sandbox VPC or firewall create with a label outside plumbline-s<own sid>-<name> is ARGS_INVALID and reaches nothing', async () => {
    const { app, mock } = await makeBroker();
    for (const label of ['plumbline-prod-a', 'plumbline-infra-x', 'plumbline-a', 'plumbline-sdeadbeef-x']) {
      const v = await app.pipeline.handleCall(claimsA, call('create', 'vpc', undefined, vpcParams(label)));
      const f = await app.pipeline.handleCall(claimsA, call('create', 'firewall_group', undefined, { label }));
      expect([label, v.status, f.status]).toEqual([label, 'ARGS_INVALID', 'ARGS_INVALID']);
    }
    expect(mock.state.calls.some((c) => c.method === 'POST')).toBe(false);
  });
  it('SEC-F2a a missing label is ARGS_INVALID too, and the own-sid label is still allowed (L5 gate labels)', async () => {
    const { app } = await makeBroker();
    expect((await app.pipeline.handleCall(claimsA, call('create', 'vpc', undefined, { region: 'ewr', subnet: '10.50.1.0', subnet_size: 24 }))).status).toBe('ARGS_INVALID');
    const ok = await app.pipeline.handleCall(claimsA, call('create', 'vpc', undefined, vpcParams(`plumbline-s${sidA}-l5vpc`)));
    expect(dec(ok)).toBe('ALLOW');
    const fw = await app.pipeline.handleCall(claimsA, call('create', 'firewall_group', undefined, { label: `plumbline-s${sidA}-l5fw` }));
    expect(dec(fw)).toBe('ALLOW');
  });
  it('SEC-F2b the floor denies create of plumbline-prod-* and plumbline-infra-* for every class and every caller', async () => {
    const { app, mock } = await makeBroker();
    const system = (cls: 'vpc' | 'firewall_group', label: string) =>
      app.pipeline.runSystem(sidA, { verb: 'create', class: cls, params: cls === 'vpc' ? vpcParams(label) : { label }, extra: {} });
    for (const label of ['plumbline-prod-z', 'plumbline-infra-z']) {
      for (const cls of ['vpc', 'firewall_group'] as const) {
        const out = await system(cls, label);
        expect([label, cls, dec(out), ruleOf(out)]).toEqual([label, cls, 'DENY', 'floor-prod-no-create']);
      }
    }
    expect(vpcs(mock)).toHaveLength(0);
    expect(fws(mock)).toHaveLength(0);
  });
  it('SEC-F2b a hot-edited session policy cannot create plumbline-prod-* either', async () => {
    const { app } = await makeBroker();
    app.policies.put(sidA, 'version: 2\nrules:\n  - {id: x, effect: allow, priority: 10, match: {verb: [create], class: [vpc, firewall_group, registry, instance], label_prefix: [plumbline]}, reason: hot-edit}\n');
    const out = await app.pipeline.runSystem(sidA, { verb: 'create', class: 'firewall_group', params: { label: 'plumbline-infra-x' }, extra: {} });
    expect(dec(out)).toBe('DENY');
  });
  it('SEC-F2c session expiry deletes every unprotected playground-labelled VPC and firewall group the session owns, through the audited path', async () => {
    let now = 1_000_000;
    const { app, mock } = await makeBroker({ clock: () => now, config: { sessionIdleMs: 600_000 } });
    const s = await newSession(app);
    const claims = { task_id: 't1', session_id: s.session_id };
    const extraV = await app.pipeline.handleCall(claims, call('create', 'vpc', undefined, vpcParams(`plumbline-s${s.session_id}-extra`, 7)));
    const extraF = await app.pipeline.handleCall(claims, call('create', 'firewall_group', undefined, { label: `plumbline-s${s.session_id}-fwx` }));
    expect([dec(extraV), dec(extraF)]).toEqual(['ALLOW', 'ALLOW']);
    expect(vpcs(mock)).toHaveLength(2);
    expect(fws(mock)).toHaveLength(1);
    now += 700_000;
    await app.reap();
    expect(vpcs(mock)).toHaveLength(0);
    expect(fws(mock)).toHaveLength(0);
    const open = app.db.prepare('SELECT COUNT(*) n FROM resources WHERE destroyed_at_ms IS NULL AND class IN (\'vpc\', \'firewall_group\')').get() as { n: number };
    expect(open.n).toBe(0);
    const audited = app.db.prepare("SELECT COUNT(*) n FROM decisions WHERE verb='delete' AND decision='ALLOW'").get() as { n: number };
    expect(audited.n).toBe(3);
  });
});

describe('SEC-F3 ownership is judged on the ledger owner, whatever the label', () => {
  it('SEC-F3 session B cannot delete a registry or firewall group owned by session A when the label is outside the scoped prefixes', async () => {
    const { app, mock } = await makeBroker();
    const a = { task_id: 'ta', session_id: 'a1b2c3d4' };
    const b = { task_id: 'tb', session_id: 'b2c3d4e5' };
    const made = await app.pipeline.handleCall(a, call('create', 'registry', undefined, { name: 'plumblinemyreg', region: 'ewr' }));
    expect(dec(made)).toBe('ALLOW');
    const regId = (mock.state.registries as unknown as { id: string }[])[0]?.id as string;
    const stolen = await app.pipeline.handleCall(b, call('delete', 'registry', regId));
    expect(dec(stolen)).toBe('DENY');
    expect(mock.state.registries).toHaveLength(1);
    const own = await app.pipeline.handleCall(a, call('delete', 'registry', regId));
    expect(dec(own)).toBe('ALLOW');
  });
  it('SEC-F3 session B cannot add a rule to session A firewall group that carries a plumbline-fw label', async () => {
    const { app, mock } = await makeBroker();
    const decision = await app.pipeline.runSystem('a1b2c3d4', { verb: 'create', class: 'firewall_group', params: { label: 'plumbline-s9-legacy' }, extra: {} });
    expect(dec(decision)).toBe('ALLOW');
    fws(mock)[0]!.description = 'plumbline-fw';
    app.db.prepare("UPDATE resources SET label='plumbline-fw'").run();
    const id = fws(mock)[0]?.id as string;
    const out = await app.pipeline.handleCall({ task_id: 'tb', session_id: 'b2c3d4e5' }, call('update', 'firewall_group', id, { port: '22' }));
    expect(dec(out)).toBe('DENY');
  });
});

describe('SEC-F4 the floor decides the worker prefix', () => {
  const sid = 'c3d4e5f6';
  const open = 'version: 2\nrules:\n  - {id: custom-allow, effect: allow, priority: 10, match: {verb: [create], class: [instance], label_prefix: [custom-, plumbline]}, reason: hot-edit}\n';
  it('SEC-F4 a hot-edited session policy with an allow rule cannot create plumbline-prod-a or plumbline-keep-1', async () => {
    const { app, mock } = await makeBroker();
    expect(app.policies.put(sid, open).ok).toBe(true);
    for (const label of ['plumbline-prod-a', 'plumbline-keep-1', 'plumbline-infra-b']) {
      const out = await app.pipeline.handleCall({ task_id: 't1', session_id: sid }, call('create', 'instance', undefined, { plan: 'vc2-1c-1gb', region: 'ewr', label }));
      expect([label, dec(out)]).toEqual([label, 'DENY']);
    }
    expect(mock.state.instances).toHaveLength(0);
  });
  it('SEC-F4 a plumbline-wk- worker is still created under the same edited policy', async () => {
    const { app, mock } = await makeBroker();
    app.policies.put(sid, open);
    const out = await app.pipeline.handleCall({ task_id: 't1', session_id: sid }, call('create', 'instance', undefined, { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-ok1' }));
    expect(JSON.stringify(out)).toContain('"decision":"ALLOW"');
    expect(mock.state.instances).toHaveLength(1);
  });
  it('SEC-F4 worker counting, reaping and fleet destroy select by class and protected, not by label', async () => {
    const { app, mock } = await makeBroker();
    const made = await app.pipeline.runSystem(sid, { verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-cnt1', ttl_h: 1 }, extra: {} });
    expect(dec(made)).toBe('ALLOW');
    const id = (mock.state.instances as unknown as { id: string }[])[0]?.id as string;
    app.db.prepare("UPDATE resources SET label='plumbline-odd-1' WHERE id = ?").run(id);
    expect(app.ledger.liveWorkerCount()).toBe(1);
    const fleet = await app.pipeline.destroyWorkers();
    expect(fleet.destroyed).toEqual([id]);
  });
  it('SEC-F4 protected instance rows (bootstrap infrastructure) are never counted as workers or destroyed', async () => {
    const { app } = await makeBroker();
    const made = await app.pipeline.runSystem(sid, { verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-pr1' }, extra: {} });
    expect(dec(made)).toBe('ALLOW');
    app.db.prepare('UPDATE resources SET protected = 1').run();
    expect(app.ledger.liveWorkerCount()).toBe(0);
    expect((await app.pipeline.destroyWorkers()).destroyed).toEqual([]);
  });
});

describe('SEC-F5 per-task state is dropped once the token has expired', () => {
  it('SEC-F5 reap deletes the call counter and the model entry of a task whose token expired', async () => {
    let now = 1_000_000;
    const { app } = await makeBroker({ clock: () => now });
    const t = await app.internal.inject({ method: 'POST', url: '/v1/task', headers: H, payload: { session_id: (await newSession(app)).session_id, model: 'm-x' } });
    const { task_id, token } = t.json() as { task_id: string; token: string };
    await app.sandbox.inject({ method: 'POST', url: '/v1/call', headers: { authorization: `Bearer ${token}` }, payload: call('list', 'instance') });
    expect(app.tasks.size()).toBe(1);
    expect(app.tasks.models.get(task_id)).toBe('m-x');
    now += 60_000;
    await app.reap();
    expect(app.tasks.size()).toBe(1);
    now += 120_000;
    await app.reap();
    expect(app.tasks.size()).toBe(0);
    expect(app.tasks.models.has(task_id)).toBe(false);
    expect(app.tasks.calls.has(task_id)).toBe(false);
  });
});

describe('SEC-M1 broker policy store', () => {
  it('SEC-M1 GET /v1/policy/<unknown sid> returns the default without inserting a per-sid copy', async () => {
    const { app } = await makeBroker();
    const r = await app.internal.inject({ method: 'GET', url: '/v1/policy/zzzz-not-a-session', headers: H });
    expect(r.statusCode).toBe(200);
    expect(app.policies.copies()).toBe(0);
  });
  it('SEC-M1 reap sweeps idle policy copies', async () => {
    let now = 1_000_000;
    const { app } = await makeBroker({ clock: () => now, config: { sessionIdleMs: 600_000 } });
    expect(app.policies.put('a1b2c3d4', 'version: 2\nrules:\n  - {id: custom-x, effect: allow, priority: 10, match: {verb: [list], class: [instance]}, reason: hot-edit}\n').ok).toBe(true);
    expect(app.policies.copies()).toBe(1);
    now += 700_000;
    app.sessions.create();
    await app.reap();
    expect(app.policies.copies()).toBe(0);
  });
});

describe('SEC-H1 broker side: /v1/sessions/alive', () => {
  it('SEC-H1 answers which ids the broker holds without refreshing them, and refuses malformed input', async () => {
    let now = 1_000;
    const { app } = await makeBroker({ clock: () => now });
    const s = app.sessions.create();
    now += 500;
    const r = await app.internal.inject({ method: 'POST', url: '/v1/sessions/alive', headers: H, payload: { ids: [s.id, 'deadbeef'] } });
    expect(r.json()).toEqual({ alive: [s.id] });
    expect(app.sessions.expired(100).map((x) => x.id)).toEqual([s.id]);
    const bad = await app.internal.inject({ method: 'POST', url: '/v1/sessions/alive', headers: H, payload: { ids: ['../x'] } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('SEC-REPLAY the public decision list carries no key, nonce or approval material', () => {
  it('SEC-REPLAY /v1/decisions after an ESCALATE exposes neither the approval nonce nor a session key or signature', async () => {
    const { app } = await makeBroker({ versions: 1 });
    const out = await app.pipeline.handleCall({ task_id: 't1', session_id: 'a1b2c3d4' }, call('delete', 'bucket_object', 'orders.json'));
    const nonce = out.status === 'DECIDED' ? (out as unknown as { approval?: { nonce: string } }).approval?.nonce : undefined;
    expect(nonce).toBeTruthy();
    const body = (await app.internal.inject({ method: 'GET', url: '/v1/decisions?limit=100', headers: H })).body;
    expect(body).toContain('last-copy-block');
    expect(body).not.toContain(nonce as string);
    expect(body.toLowerCase()).not.toMatch(/session_key|signature|x-plumbline|"nonce"|secret|token/);
  });
});
