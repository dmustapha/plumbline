// File: apps/broker/test/ag4.test.ts
// Regression tests for the A-G4 broker findings (INVARIANTS.md). One it() per finding id.
import { describe, expect, it } from 'vitest';
import { VERB_CLASS } from '@plumbline/policy-engine';
import { listDecisions } from '@plumbline/ledger';
import { Egress, EgressRefused, isPublicIp } from '../src/egress.ts';
import { DISPATCH_KEYS, parseCall } from '../src/pipeline.ts';
import { makeBroker, secrets } from './support.ts';

const A = { task_id: 'tA', session_id: 'sessaaa1' };
const B = { task_id: 'tB', session_id: 'sessbbb2' };
const H = { 'x-plumbline-api-token': secrets.apiToken };
const ADMIN = { 'x-plumbline-admin-token': secrets.adminToken };
const mkWorker = (label: string) => ({ verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region: 'ewr', label } });
const del = (cls: string, id: string) => ({ verb: 'delete', class: cls, target: { id } });
const deletes = (mock: { state: { calls: { method: string }[] } }) => mock.state.calls.filter((c) => c.method === 'DELETE');

describe('AG4-BRK-1 verb and class are enum-checked, dispatch is exhaustive', () => {
  it('AG4-BRK-1 unknown verb for a class is rejected before dispatch and never deletes', async () => {
    const { app, mock } = await makeBroker();
    mock.state.instances.push({ id: 'i-w', label: 'plumbline-wk-aaaa', status: 'active', tags: [] });
    for (const verb of ['read', 'fetch', 'write', 'put', 'restore']) {
      const out = await app.pipeline.handleCall(A, { verb, class: 'instance', target: { id: 'i-w' } });
      expect(out.status).toBe('ARGS_INVALID');
    }
    expect(deletes(mock)).toHaveLength(0);
    expect(mock.state.instances).toHaveLength(1);
    expect(listDecisions(app.db)).toHaveLength(0);
  });
  it('AG4-BRK-1 every verb x class pair outside the catalog is ARGS_INVALID', async () => {
    const { app } = await makeBroker();
    const verbs = ['list', 'create', 'update', 'delete', 'put', 'restore', 'fetch', 'read', 'write', 'drop', ''];
    for (const cls of [...Object.keys(VERB_CLASS), 'database', '__proto__', '']) {
      for (const verb of verbs) {
        const known = Object.hasOwn(VERB_CLASS, cls) && (VERB_CLASS as Record<string, readonly string[]>)[cls]?.includes(verb) === true;
        const r = parseCall({ verb, class: cls, target: { id: 'x' }, params: { url: 'http://a.example', version_id: 'v1' } });
        const outsideCatalog = !r.ok && r.errors.some((m) => m.includes('not in the catalog'));
        expect(outsideCatalog, `${cls}:${verb}`).toBe(!known);
      }
    }
    const bad = await app.pipeline.handleCall(A, { verb: 'list', class: 'policy' });
    expect(bad.status).toBe('ARGS_INVALID');
  });
  it('AG4-BRK-1 the dispatch table covers exactly the engine catalog (default throws)', () => {
    const want = Object.entries(VERB_CLASS).flatMap(([c, vs]) => vs.map((v) => `${c}:${v}`)).sort();
    expect([...DISPATCH_KEYS].sort()).toEqual(want);
  });
  it('AG4-BRK-1 read on policy returns text and never writes', async () => {
    const { app } = await makeBroker();
    const before = app.policies.get(A.session_id).text;
    const out = await app.pipeline.handleCall(A, { verb: 'read', class: 'policy' });
    expect(out.status === 'DECIDED' && (out.result as { text: string }).text).toBe(before);
    expect(app.policies.get(A.session_id).text).toBe(before);
  });
});

describe('AG4-BRK-2 security parameters reach CallRequest.params and are validated', () => {
  it('AG4-BRK-2 port, notes, content and firewall_group_id land in params', () => {
    const r = parseCall({ verb: 'update', class: 'firewall_group', target: { id: 'fw1' }, params: { port: '8000:8100', notes: 'web tier' } });
    expect(r.ok && r.call.params).toMatchObject({ port: '8000:8100', notes: 'web tier' });
    const i = parseCall({ verb: 'update', class: 'instance', target: { id: 'i1' }, params: { firewall_group_id: 'fw-abc' } });
    expect(i.ok && i.call.params).toMatchObject({ firewall_group_id: 'fw-abc' });
    const c = parseCall({ verb: 'put', class: 'bucket_object', target: { id: 'orders.json' }, params: { content: '{"a":1}' } });
    expect(c.ok && c.call.params).toMatchObject({ content: '{"a":1}' });
  });
  it('AG4-BRK-2 illegal port, notes, content and an empty detach are ARGS_INVALID', () => {
    const bad = (cls: string, verb: string, params: Record<string, unknown>) => parseCall({ verb, class: cls, target: { id: 'x' }, params }).ok;
    expect(bad('firewall_group', 'update', { port: '22; drop' })).toBe(false);
    expect(bad('firewall_group', 'update', { port: '70000' })).toBe(false);
    expect(bad('firewall_group', 'update', { notes: 'x' })).toBe(false);
    expect(bad('firewall_group', 'update', { port: '22', notes: '<script>' })).toBe(false);
    expect(bad('instance', 'update', { firewall_group_id: '' })).toBe(false);
    expect(bad('instance', 'update', {})).toBe(false);
    expect(bad('bucket_object', 'put', { content: '\u0000bad' })).toBe(false);
  });
  it('AG4-BRK-2 the engine request and ledger row carry the port', async () => {
    const { app, mock } = await makeBroker();
    mock.state.firewall_groups.push({ id: 'fw-1', description: 'plumbline-s9-vault' });
    await app.pipeline.handleCall(A, { verb: 'update', class: 'firewall_group', target: { id: 'fw-1' }, params: { port: '8080', notes: 'n' } });
    const row = db(app).prepare('SELECT request_json FROM decisions').get() as { request_json: string };
    expect(JSON.parse(row.request_json).params).toMatchObject({ port: '8080', notes: 'n' });
  });
});

const db = (app: { db: import('@plumbline/ledger').Db }) => app.db;

describe('AG4-BRK-3 resource ownership', () => {
  it('AG4-BRK-3 another session cannot delete my worker; I can', async () => {
    const { app, mock } = await makeBroker();
    const made = await app.pipeline.handleCall(B, mkWorker('plumbline-wk-bbbb'));
    const id = made.status === 'DECIDED' ? (made.result as { id: string }).id : '';
    expect(id).not.toBe('');
    const stolen = await app.pipeline.handleCall(A, del('instance', id));
    expect(stolen.status === 'DECIDED' && stolen.decision.decision).toBe('DENY');
    expect(deletes(mock)).toHaveLength(0);
    const own = await app.pipeline.handleCall(B, del('instance', id));
    expect(own.status === 'DECIDED' && own.decision.decision).toBe('ALLOW');
    expect(deletes(mock)).toHaveLength(1);
  });
  it('AG4-BRK-3 another session cannot touch my vault group even with protect-tagged-destroy removed', async () => {
    const { app, mock } = await makeBroker();
    const s = (await app.internal.inject({ method: 'POST', url: '/v1/session', headers: H, payload: {} })).json();
    const edited = app.policies.get(A.session_id).text.replace('id: protect-tagged-destroy\n    effect: deny', 'id: protect-tagged-destroy\n    effect: allow');
    expect(app.policies.put(A.session_id, edited).ok).toBe(true);
    const out = await app.pipeline.handleCall(A, del('firewall_group', s.playground.id));
    expect(out.status === 'DECIDED' && out.decision.decision).toBe('DENY');
    expect(deletes(mock)).toHaveLength(0);
  });
  it('AG4-BRK-3 a worker the ledger does not know is not mutable by any session', async () => {
    const { app, mock } = await makeBroker();
    mock.state.instances.push({ id: 'i-orph', label: 'plumbline-wk-orph', status: 'active', tags: [] });
    const out = await app.pipeline.handleCall(A, del('instance', 'i-orph'));
    expect(out.status === 'DECIDED' && out.decision.decision).toBe('DENY');
    expect(deletes(mock)).toHaveLength(0);
  });
});

describe('AG4-BRK-4 SSRF guard in egress', () => {
  const body = (chunks: Uint8Array[]) => (async function* () { for (const c of chunks) yield c; })();
  const mk = (resolved: Record<string, string[]>, seen: { ip: string; host: string }[] = [], respond?: () => { status: number; headers: Record<string, string>; body: AsyncIterable<Uint8Array> }) =>
    new Egress('http://127.0.0.1:1', fetch, {
      resolve: async (h) => resolved[h] ?? [],
      transport: async (r) => { seen.push({ ip: r.ip, host: r.url.hostname }); return respond ? respond() : { status: 200, headers: {}, body: body([Buffer.from('ok')]) }; },
    });
  it('AG4-BRK-4 refuses IP literals, private, link-local and metadata addresses', async () => {
    const seen: { ip: string; host: string }[] = [];
    const e = mk({ 'rebind.example': ['169.254.169.254'], 'lo.example': ['127.0.0.1'], 'v6.example': ['::1'], 'ula.example': ['fc00::1'], 'mixed.example': ['93.184.216.34', '10.0.0.5'] }, seen);
    for (const u of ['http://169.254.169.254/v1.json', 'http://127.0.0.1:8080/', 'http://[::1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://10.1.2.3/', 'http://rebind.example/', 'http://lo.example/', 'http://v6.example/', 'http://ula.example/', 'http://mixed.example/', 'ftp://a.example/', 'http://u:p@a.example/']) {
      await expect(e.fetch(u), u).rejects.toBeInstanceOf(EgressRefused);
    }
    expect(seen).toHaveLength(0);
  });
  it('AG4-BRK-4 isPublicIp classifies the reserved ranges', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) expect(isPublicIp(ip), ip).toBe(false);
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) expect(isPublicIp(ip), ip).toBe(true);
  });
  it('AG4-BRK-4 pins the resolved IP and does not follow a redirect to a private address', async () => {
    const seen: { ip: string; host: string }[] = [];
    const e = mk({ 'ok.example': ['93.184.216.34'] }, seen, () => ({ status: 302, headers: { location: 'http://169.254.169.254/v1.json' }, body: body([]) }));
    const out = await e.fetch('http://ok.example/x');
    expect(seen).toEqual([{ ip: '93.184.216.34', host: 'ok.example' }]);
    expect(out.status).toBe(302);
    expect(out.redirect_to).toBe('http://169.254.169.254/v1.json');
  });
  it('AG4-BRK-4 streams with a hard byte cap and stops pulling', async () => {
    let pulled = 0;
    const endless = (async function* () { for (;;) { pulled += 1; yield Buffer.alloc(16 * 1024, 97); } })();
    const e = mk({ 'big.example': ['93.184.216.34'] }, [], () => ({ status: 200, headers: {}, body: endless }));
    const out = await e.fetch('https://big.example/');
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.text)).toBe(64 * 1024);
    expect(pulled).toBeLessThanOrEqual(6);
  });
  it('AG4-BRK-4 the virtual range host still serves /pages only through the range API', async () => {
    const calls: string[] = [];
    const e = new Egress('http://127.0.0.1:9', (async (u: RequestInfo | URL) => { calls.push(String(u)); return new Response('page'); }) as typeof fetch);
    expect((await e.fetch('http://range.plumbline.local/pages/a')).text).toBe('page');
    expect(calls).toEqual(['http://127.0.0.1:9/pages/a']);
    expect((await e.fetch('http://range.plumbline.local/admin')).status).toBe(404);
  });
});

const CUSTOM_ESCALATE_BUCKET = `
  - id: custom-esc-bucket
    effect: escalate
    priority: 99
    match: { verb: [delete], class: [bucket_object] }
    reason: "custom escalation"
`;
const CUSTOM_ESCALATE_WORKER = `
  - id: custom-esc-worker
    effect: escalate
    priority: 99
    match: { verb: [delete], class: [instance], label_prefix: [plumbline-wk-] }
    reason: "custom escalation"
`;
const countKind = (app: { db: import('@plumbline/ledger').Db }, kind: string) => (app.db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE decision = ?').get(kind) as { n: number }).n;

describe('AG4-BRK-5 an approval covers one escalation', () => {
  it('AG4-BRK-5 re-evaluation that escalates for a different rule does not execute', async () => {
    const { app, s3 } = await makeBroker({ versions: 1 });
    const out = await app.pipeline.handleCall(A, del('bucket_object', 'orders.json'));
    if (out.status !== 'DECIDED' || !out.approval) throw new Error('expected approval');
    expect(out.decision.rule_id).toBe('last-copy-block');
    expect(app.policies.put(A.session_id, app.policies.get(A.session_id).text + CUSTOM_ESCALATE_BUCKET).ok).toBe(true);
    const res = await app.pipeline.approve(A.session_id, out.decision.decision_id, out.approval.nonce, true);
    expect(res.status).toBe('STALE');
    expect(s3.ops).not.toContain('delete');
  });
  it('AG4-BRK-5 a different resolved target (relabelled worker) does not execute', async () => {
    const { app, mock } = await makeBroker();
    const made = await app.pipeline.handleCall(A, mkWorker('plumbline-wk-aaaa'));
    const id = made.status === 'DECIDED' ? (made.result as { id: string }).id : '';
    expect(app.policies.put(A.session_id, app.policies.get(A.session_id).text + CUSTOM_ESCALATE_WORKER).ok).toBe(true);
    const out = await app.pipeline.handleCall(A, del('instance', id));
    if (out.status !== 'DECIDED' || !out.approval) throw new Error('expected approval');
    (mock.state.instances[0] as unknown as { label: string }).label = 'plumbline-wk-swapped';
    expect((await app.pipeline.approve(A.session_id, out.decision.decision_id, out.approval.nonce, true)).status).toBe('STALE');
    expect(deletes(mock)).toHaveLength(0);
  });
  it('AG4-BRK-5 an approval executes once, writes no extra ESCALATE row, links by approved_from, and cannot be replayed', async () => {
    const { app, s3 } = await makeBroker({ versions: 1 });
    const out = await app.pipeline.handleCall(A, del('bucket_object', 'orders.json'));
    if (out.status !== 'DECIDED' || !out.approval) throw new Error('expected approval');
    expect(countKind(app, 'ESCALATE')).toBe(1);
    const done = await app.pipeline.approve(A.session_id, out.decision.decision_id, out.approval.nonce, true);
    expect(done.status).toBe('DECIDED');
    expect(s3.ops).toEqual(['delete']);
    expect(countKind(app, 'ESCALATE')).toBe(1);
    const allow = listDecisions(app.db).find((r) => r.decision === 'ALLOW');
    expect(JSON.parse(allow?.detail_json ?? '{}').call.approved_from).toBe(out.decision.decision_id);
    expect((await app.pipeline.approve(A.session_id, out.decision.decision_id, out.approval.nonce, true)).status).toBe('NOT_FOUND');
    expect(s3.ops).toEqual(['delete']);
  });
  it('AG4-BRK-5 another session cannot approve my escalation', async () => {
    const { app, s3 } = await makeBroker({ versions: 1 });
    const out = await app.pipeline.handleCall(A, del('bucket_object', 'orders.json'));
    if (out.status !== 'DECIDED' || !out.approval) throw new Error('expected approval');
    expect((await app.pipeline.approve(B.session_id, out.decision.decision_id, out.approval.nonce, true)).status).toBe('NOT_FOUND');
    expect(s3.ops).toEqual([]);
  });
});

describe('AG4-BRK-6 the kill switch does not stop the broker cleanup', () => {
  const HOUR = 3_600_000;
  it('AG4-BRK-6 the TTL reaper still deletes an expired worker while the kill switch is engaged, and ledgers it', async () => {
    let now = 1_000_000;
    const { app, mock } = await makeBroker({ clock: () => now });
    await app.pipeline.handleCall(A, mkWorker('plumbline-wk-aaaa'));
    expect(mock.state.instances).toHaveLength(1);
    app.kill.engage('x');
    now += 2 * HOUR;
    await app.reap();
    expect(deletes(mock)).toHaveLength(1);
    expect(mock.state.instances).toHaveLength(0);
    const row = db(app).prepare("SELECT session_id, task_id, decision, detail_json FROM decisions WHERE verb='delete'").get() as { session_id: string; task_id: string; decision: string; detail_json: string };
    expect([row.session_id, row.decision]).toEqual(['system', 'ALLOW']);
    expect(row.task_id.startsWith('reap-')).toBe(true);
    expect(JSON.parse(row.detail_json).call.system_cleanup).toBe(true);
  });
  it('AG4-BRK-6 the cleanup path refuses anything that is not a worker or a playground group, and creates stay blocked', async () => {
    const { app, mock } = await makeBroker();
    mock.state.instances.push({ id: 'i-prod', label: 'plumbline-prod-db', status: 'active', tags: ['protected'] });
    app.kill.engage('x');
    const out = await app.pipeline.cleanup('sessaaa1', 'instance', 'i-prod');
    expect(out.status).toBe('ARGS_INVALID');
    expect(deletes(mock)).toHaveLength(0);
    const create = await app.pipeline.handleCall(A, mkWorker('plumbline-wk-bbbb'));
    expect(create.status === 'DECIDED' && create.decision.rule_id).toBe('kill-switch-engaged');
  });
  it('AG4-BRK-6 engage with no verifier configured destroys the fleet itself', async () => {
    const { app, mock } = await makeBroker();
    await app.pipeline.handleCall(A, mkWorker('plumbline-wk-aaaa'));
    await app.pipeline.handleCall(B, mkWorker('plumbline-wk-bbbb'));
    const r = await app.internal.inject({ method: 'POST', url: '/v1/admin/kill-switch/engage', headers: ADMIN, payload: { reason: 't' } });
    expect(r.json()).toMatchObject({ engaged: true, lease_expired_at_verifier: false, workers_failed: [] });
    expect(r.json().workers_destroyed).toHaveLength(2);
    expect(mock.state.instances).toHaveLength(0);
  });
  it('AG4-BRK-6 engage with an unreachable verifier still destroys the fleet', async () => {
    const { app, mock } = await makeBroker({ config: { verifierUrl: 'http://127.0.0.1:1' } });
    await app.pipeline.handleCall(A, mkWorker('plumbline-wk-aaaa'));
    const r = await app.internal.inject({ method: 'POST', url: '/v1/admin/kill-switch/engage', headers: ADMIN, payload: {} });
    expect(r.json().lease_expired_at_verifier).toBe(false);
    expect(mock.state.instances).toHaveLength(0);
  });
});

describe('AG4-BRK-7 the sandbox can never write a policy', () => {
  const call = (app: Awaited<ReturnType<typeof makeBroker>>['app'], sid: string, body: unknown) =>
    app.sandbox.inject({ method: 'POST', url: '/v1/call', headers: { authorization: `Bearer ${app.tokens.mint('t-sbx', sid).token}` }, payload: body as object });
  const RELAXED = 'version: 2\\nrules: []\\n';
  it('AG4-BRK-7 a policy write from the sandbox token is DENY and the session policy is unchanged', async () => {
    const { app } = await makeBroker();
    const before = app.policies.get('sessaaa1').text;
    const r = await call(app, 'sessaaa1', { verb: 'write', class: 'policy', params: { content: RELAXED } });
    expect(r.json().decision).toMatchObject({ decision: 'DENY', rule_id: 'policy-write-owner-only' });
    expect(app.policies.get('sessaaa1').text).toBe(before);
  });
  it('AG4-BRK-7 update on class policy is not a verb and is rejected', async () => {
    const { app } = await makeBroker();
    const r = await call(app, 'sessaaa1', { verb: 'update', class: 'policy', target: { id: 'x' }, params: { content: RELAXED } });
    expect(r.statusCode).toBe(400);
  });
  it('AG4-BRK-7 even if every policy layer would allow it, dispatch refuses a sandbox policy write', async () => {
    const strip = (t: string) => t.replace(/  - id: policy-write-owner-only[\s\S]*?(?=\n  - id:)/, '').replace(/  - id: policy-production-immutable[\s\S]*?(?=\n  - id:)/, '');
    const { app } = await makeBroker({ floorTransform: strip });
    const before = app.policies.get('sessaaa1').text;
    const r = await call(app, 'sessaaa1', { verb: 'write', class: 'policy', params: { content: RELAXED } });
    expect(r.json().error.message).toContain('POLICY_WRITE_OWNER_ONLY');
    expect(app.policies.get('sessaaa1').text).toBe(before);
  });
  it('AG4-BRK-7 the owner PUT route is the only writer of the session copy', async () => {
    const { app } = await makeBroker();
    const text = app.policies.get('sessaaa1').text;
    const ok = await app.internal.inject({ method: 'PUT', url: '/v1/policy/sessaaa1', headers: H, payload: { text } });
    expect(ok.statusCode).toBe(200);
  });
});
