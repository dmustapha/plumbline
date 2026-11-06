// File: apps/broker/test/co-integration.test.ts
// Change orders CO-A (VPC playground), CO-B (reaper scope), CO-C (lease ttl default), CO-E (L6 session canary wiring).
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '@plumbline/ledger';
import { PLAYGROUND_LABEL_RE } from '@plumbline/policy-engine';
import { brokerKeyGuard, canaryKeyFor } from '../src/canary.ts';
import { loadConfig } from '../src/config.ts';
import { assemble } from '../src/main.ts';
import { PolicyStore } from '../src/policyStore.ts';
import { playgroundSubnet, SessionRegistry } from '../src/sessions.ts';
import { baseConfig, makeBroker, secrets } from './support.ts';

const H = { 'x-plumbline-api-token': secrets.apiToken };
const HOUR = 3_600_000;
const del = (cls: string, id: string) => ({ verb: 'delete', class: cls, target: { id } });
const deletes = (mock: { state: { calls: { method: string }[] } }) => mock.state.calls.filter((c) => c.method === 'DELETE');
type Built = Awaited<ReturnType<typeof makeBroker>>;
const newSession = async (app: Built['app']) => (await app.internal.inject({ method: 'POST', url: '/v1/session', headers: H, payload: {} })).json();
const vpcs = (mock: Built['mock']) => mock.state.vpcs as unknown as { id: string; description: string; v4_subnet: string; v4_subnet_mask: number; region: string }[];

describe('CO-A: the session playground is a VPC', () => {
  it('CO-A session creation makes a VPC (not a firewall group) with subnet, size 24 and the configured region', async () => {
    const { app, mock } = await makeBroker();
    const s = await newSession(app);
    expect(mock.state.firewall_groups).toHaveLength(0);
    expect(vpcs(mock)).toHaveLength(1);
    expect(vpcs(mock)[0]).toMatchObject({ description: `plumbline-s${s.session_id}-vault`, v4_subnet: playgroundSubnet(s.session_id), v4_subnet_mask: 24, region: 'ewr' });
    expect(s.playground).toEqual({ id: vpcs(mock)[0]?.id, label: `plumbline-s${s.session_id}-vault` });
    const row = app.db.prepare("SELECT class, protected, session_id FROM resources WHERE id = ?").get(s.playground.id);
    expect(row).toEqual({ class: 'vpc', protected: 1, session_id: s.session_id });
  });
  it('CO-A the playground label matches the floor playground regex', async () => {
    const { app } = await makeBroker();
    const s = await newSession(app);
    expect(PLAYGROUND_LABEL_RE.test(s.playground.label)).toBe(true);
  });
  it('CO-A the region comes from the broker config', async () => {
    const { app, mock } = await makeBroker({ config: { region: 'ams' } });
    const s = await newSession(app);
    expect(s.playground).toBeNull();
    expect(vpcs(mock)).toHaveLength(0);
    expect(JSON.stringify(s.playground_error)).toContain('region-not-allowed');
  });
  it('CO-A the subnet is deterministic, a /24 10.100-199.x.0, and no two live sessions share one', () => {
    expect(playgroundSubnet('0a1b2c3d')).toBe(playgroundSubnet('0a1b2c3d'));
    expect(playgroundSubnet('00000000')).toBe('10.100.0.0');
    expect(playgroundSubnet('ffffffff')).toMatch(/^10\.(1\d\d)\.255\.0$/);
    const reg = new SessionRegistry();
    const subnets = new Set(Array.from({ length: 300 }, () => playgroundSubnet(reg.create().id)));
    expect(subnets.size).toBe(300);
  });
  it('CO-A idle expiry deletes the VPC through the audited cleanup path', async () => {
    let now = 5_000_000;
    const { app, mock } = await makeBroker({ clock: () => now });
    const s = await newSession(app);
    now += 31 * 60_000;
    await app.reap();
    expect(vpcs(mock)).toHaveLength(0);
    expect(deletes(mock)).toHaveLength(1);
    const row = app.db.prepare("SELECT session_id, task_id, decision, class, detail_json FROM decisions WHERE verb='delete'").get() as { session_id: string; task_id: string; decision: string; class: string; detail_json: string };
    expect([row.session_id, row.decision, row.class]).toEqual(['system', 'ALLOW', 'vpc']);
    expect(row.task_id.startsWith('reap-')).toBe(true);
    expect(JSON.parse(row.detail_json).call.system_cleanup).toBe(true);
    expect(app.sessions.get(s.session_id)).toBeUndefined();
    expect(app.db.prepare('SELECT destroyed_at_ms FROM resources WHERE id = ?').get(s.playground.id)).not.toEqual({ destroyed_at_ms: null });
  });
  it('CO-A cleanup still refuses a VPC whose label is not plumbline-s<8hex>-*', async () => {
    const { app, mock } = await makeBroker();
    for (const [id, description] of [['vpc-infra', 'plumbline-infra-vpc'], ['vpc-bad', 'plumbline-sABC-vault'], ['vpc-up', 'plumbline-sABCDEF12-vault']]) mock.state.vpcs.push({ id, description } as never);
    for (const id of ['vpc-infra', 'vpc-bad', 'vpc-up']) expect((await app.pipeline.cleanup('0a1b2c3d', 'vpc', id)).status).toBe('ARGS_INVALID');
    expect(deletes(mock)).toHaveLength(0);
    expect(vpcs(mock)).toHaveLength(3);
  });
  it('CO-A the kill switch does not stop the idle cleanup of the VPC', async () => {
    let now = 5_000_000;
    const { app, mock } = await makeBroker({ clock: () => now });
    await newSession(app);
    app.kill.engage('x');
    now += 31 * 60_000;
    await app.reap();
    expect(vpcs(mock)).toHaveLength(0);
  });
  it('CO-A another session cannot delete my playground VPC; its owner is DENIED protect-tagged-destroy until the hot-edit flips it to ESCALATE', async () => {
    const { app, mock } = await makeBroker();
    const s = await newSession(app);
    const other = await app.pipeline.handleCall({ task_id: 'tB', session_id: '99999999' }, del('vpc', s.playground.id));
    expect(other.status === 'DECIDED' && other.decision.decision).toBe('DENY');
    // LIVE FINDING: the playground is protected by its ledger row (a VPC label cannot carry [protected]), so the hot-edit flip has something to flip
    const own = await app.pipeline.handleCall({ task_id: 'tA', session_id: s.session_id }, del('vpc', s.playground.id));
    expect(own.status === 'DECIDED' && own.decision).toMatchObject({ decision: 'DENY', rule_id: 'protect-tagged-destroy' });
    expect(deletes(mock)).toHaveLength(0);
    const flipped = app.policies.get(s.session_id).text.replace('id: protect-tagged-destroy\n    effect: deny', 'id: protect-tagged-destroy\n    effect: escalate');
    expect(app.policies.put(s.session_id, flipped).ok).toBe(true);
    const esc = await app.pipeline.handleCall({ task_id: 'tC', session_id: s.session_id }, del('vpc', s.playground.id));
    expect(esc.status === 'DECIDED' && esc.decision).toMatchObject({ decision: 'ESCALATE', rule_id: 'protect-tagged-destroy' });
    expect(deletes(mock)).toHaveLength(0);
  });
});

describe('CO-B: the TTL reaper only selects unprotected plumbline-wk-* instances', () => {
  it('CO-B an infra row with an expired ttl is never reaped, protected or not', async () => {
    let now = 1_000_000;
    const { app, mock } = await makeBroker({ clock: () => now });
    const mk = (label: string) => ({ verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region: 'ewr', label, ttl_h: 1 } });
    for (const label of ['plumbline-wk-infa', 'plumbline-wk-infb', 'plumbline-wk-prot']) await app.pipeline.handleCall({ task_id: 't', session_id: 'sess0001' }, mk(label));
    expect(mock.state.instances).toHaveLength(3);
    // Re-label the rows the way bootstrap writes infra rows: not a worker label (two of them), one worker row marked protected.
    app.db.prepare("UPDATE resources SET label='plumbline-infra-broker', protected=1 WHERE label='plumbline-wk-infa'").run();
    app.db.prepare("UPDATE resources SET label='plumbline-infra-verifier' WHERE label='plumbline-wk-infb'").run();
    app.db.prepare("UPDATE resources SET protected=1 WHERE label='plumbline-wk-prot'").run();
    now += 5 * HOUR;
    await app.reap();
    expect(deletes(mock)).toHaveLength(0);
    expect(mock.state.instances).toHaveLength(3);
  });
});

describe('CO-C: lease ttl default', () => {
  const ENV = {
    VULTR_S3_HOST: 'h', PLUMBLINE_API_TOKEN: 'a', PLUMBLINE_ADMIN_TOKEN: 'b', PLUMBLINE_TASK_HMAC: 'c', PLUMBLINE_LEASE_SECRET: 'd',
    PLUMBLINE_POLICY_PUBKEY: 'e', VULTR_INFERENCE_API_KEY: 'f', VULTR_S3_ACCESS_KEY: 'g', VULTR_S3_SECRET_KEY: 'h',
  };
  it('CO-C the broker default PLUMBLINE_LEASE_TTL_S is 45, an explicit value still wins', () => {
    expect(loadConfig(ENV).config.leaseTtlS).toBe(45);
    expect(loadConfig({ ...ENV, PLUMBLINE_LEASE_TTL_S: '30' }).config.leaseTtlS).toBe(30);
  });
  it('CO-C the example env file says 45', () => {
    const text = readFileSync(new URL('../../../ops/env/broker.env.example', import.meta.url), 'utf8');
    expect(text).toMatch(/^PLUMBLINE_LEASE_TTL_S=45$/m);
  });
  it('CO-C the region default is ewr', () => {
    expect(loadConfig(ENV).config.region).toBe('ewr');
  });
});

describe('CO-E: the key guard and the per-session canary', () => {
  const SID = '0a1b2c3d';
  it('CO-E key guard: a session may use only its own prefix; orders.json and another prefix are refused', () => {
    const g = brokerKeyGuard(false);
    expect(() => g(SID, `sessions/${SID}/orders.json`)).not.toThrow();
    expect(() => g(SID, 'orders.json')).toThrow(/SESSION_KEY_FORBIDDEN/);
    expect(() => g(SID, 'sessions/ffffffff/orders.json')).toThrow(/SESSION_KEY_FORBIDDEN/);
    expect(() => g(SID, `sessions/${SID}/../orders.json`)).toThrow(/SESSION_KEY_FORBIDDEN/);
    expect(() => g('system', 'orders.json')).not.toThrow();
  });
  it('CO-E key guard: bond-scene keys are open only while the bond is enabled, and only as plain names', () => {
    expect(() => brokerKeyGuard(true)(SID, 'bond-scene/live-1.json')).not.toThrow();
    expect(() => brokerKeyGuard(true)(SID, 'bond-scene/../orders.json')).toThrow(/SESSION_KEY_FORBIDDEN/);
    expect(() => brokerKeyGuard(true)(SID, 'bond-scene/a/b.json')).toThrow(/SESSION_KEY_FORBIDDEN/);
    expect(() => brokerKeyGuard(false)(SID, 'bond-scene/live-1.json')).toThrow(/SESSION_KEY_FORBIDDEN/);
  });
  it('CO-E canaryKeyFor: session key for a session id, the shared object only for non-session principals', () => {
    expect(canaryKeyFor(SID)).toBe(`sessions/${SID}/orders.json`);
    expect(canaryKeyFor('system')).toBe('orders.json');
  });
  it('CO-E main builds the real S3Store with the guard: a session naming orders.json never reaches the store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plb-real-s3-'));
    const cfg = { ...baseConfig, dataDir: dir, bondEnabled: true };
    const policies = new PolicyStore(dir, readFileSync(cfg.floorPath, 'utf8'), undefined, secrets.policyPubkeyB64, false, readFileSync(cfg.sessionDefaultPath, 'utf8'));
    const app = await assemble(cfg, secrets, { db: openDb(':memory:'), policies });
    const out = await app.pipeline.handleCall({ task_id: 't', session_id: SID }, { verb: 'put', class: 'bucket_object', target: { id: 'orders.json' }, params: { content: '{}' } });
    expect(out.status).toBe('REWIND_UNAVAILABLE');
    expect(out.status === 'REWIND_UNAVAILABLE' && out.message).toContain('SESSION_KEY_FORBIDDEN');
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE class='bucket_object'").get()).toEqual({ n: 0 });
    await app.stop();
  });
  it('CO-E session creation seeds the canary to two versions with engine-judged puts that are in the ledger', async () => {
    const { app, s3 } = await makeBroker({ versions: 0, growOnPut: true });
    const s = await newSession(app);
    expect(s.canary).toEqual({ key: `sessions/${s.session_id}/orders.json`, versions: 2, error: null });
    expect(s3.ops).toEqual(['put', 'put']);
    expect(s3.keys.filter((k) => k.op === 'put').map((k) => k.key)).toEqual([s.canary.key, s.canary.key]);
    const rows = app.db.prepare("SELECT decision, verb, target_id FROM decisions WHERE class='bucket_object'").all();
    expect(rows).toEqual([{ decision: 'ALLOW', verb: 'put', target_id: s.canary.key }, { decision: 'ALLOW', verb: 'put', target_id: s.canary.key }]);
  });
  it('CO-E a canary that already has two versions is not seeded again', async () => {
    const { app, s3 } = await makeBroker({ versions: 2 });
    const s = await newSession(app);
    expect(s.canary.versions).toBe(2);
    expect(s3.ops).toEqual([]);
  });
  it('CO-E a seed that does not grow the store is reported, and the session still exists', async () => {
    const { app } = await makeBroker({ versions: 0 });
    const s = await newSession(app);
    expect(s.canary.error).toContain('CANARY_SEED_FAILED');
    expect(s.canary.versions).toBeNull();
    expect(app.sessions.get(s.session_id)).toBeDefined();
  });
  it('CO-E /v1/rewind lists the session canary, never orders.json, and reports object_versions', async () => {
    const { app, s3 } = await makeBroker({ versions: 2 });
    const r = await app.internal.inject({ method: 'GET', url: `/v1/rewind?session_id=${SID}`, headers: H });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ key: `sessions/${SID}/orders.json`, object_versions: 2, classify: { reversible: true, state_known: true } });
    expect(s3.keys.map((k) => k.key)).toEqual([`sessions/${SID}/orders.json`]);
  });
  it('CO-E /v1/rewind refuses a missing or non-session id (no fallback to the shared object)', async () => {
    const { app, s3 } = await makeBroker();
    for (const q of ['', '?session_id=system', '?session_id=../../x']) expect((await app.internal.inject({ method: 'GET', url: `/v1/rewind${q}`, headers: H })).statusCode).toBe(400);
    expect(s3.keys).toHaveLength(0);
  });
  it('CO-E a listing error answers REWIND_UNAVAILABLE with object_versions null', async () => {
    const { app, s3 } = await makeBroker();
    s3.fault.listing = true;
    const r = await app.internal.inject({ method: 'GET', url: `/v1/rewind?session_id=${SID}`, headers: H });
    expect([r.statusCode, r.json().status, r.json().object_versions]).toEqual([503, 'REWIND_UNAVAILABLE', null]);
    expect(r.json().classify.state_known).toBe(false);
  });
  it('CO-E the rewind delete targets the session canary and, when the listing fails, the engine DENYs object-state-unknown', async () => {
    const { app, s3 } = await makeBroker();
    await app.internal.inject({ method: 'POST', url: '/v1/session', headers: H, payload: {} });
    const sid = (app.db.prepare("SELECT session_id FROM resources WHERE class='vpc'").get() as { session_id: string }).session_id;
    const ok = await app.internal.inject({ method: 'POST', url: '/v1/rewind/act', headers: H, payload: { session_id: sid, action: 'delete' } });
    expect(ok.json().decision).toMatchObject({ decision: 'ALLOW' });
    expect(app.db.prepare("SELECT target_id FROM decisions WHERE verb='delete'").get()).toEqual({ target_id: `sessions/${sid}/orders.json` });
    s3.fault.listing = true;
    const bad = await app.internal.inject({ method: 'POST', url: '/v1/rewind/act', headers: H, payload: { session_id: sid, action: 'delete' } });
    expect(bad.json().decision).toMatchObject({ decision: 'DENY', rule_id: 'object-state-unknown' });
    expect(s3.ops.filter((o) => o === 'delete')).toHaveLength(1);
  });
  it('CO-E a bucket call that names no key uses the caller\'s own canary', async () => {
    const { app, s3 } = await makeBroker();
    await app.pipeline.handleCall({ task_id: 't', session_id: SID }, { verb: 'list', class: 'bucket_object' });
    await app.pipeline.handleCall({ task_id: 't', session_id: SID }, { verb: 'list', class: 'bucket_object' });
    expect(s3.keys.map((k) => k.key)).toEqual([`sessions/${SID}/orders.json`, `sessions/${SID}/orders.json`]);
    const out = await app.pipeline.handleCall({ task_id: 't', session_id: SID }, { verb: 'delete', class: 'bucket_object', target: { id: `sessions/${SID}/orders.json` } });
    expect(out.status === 'DECIDED' && out.decision.decision).toBe('ALLOW');
  });
  it('CO-E live-list reads the caller\'s canary for a session id and the shared object for system', async () => {
    const { app, s3 } = await makeBroker();
    await app.internal.inject({ method: 'GET', url: `/v1/live-list?session_id=${SID}`, headers: H });
    await app.internal.inject({ method: 'GET', url: '/v1/live-list?session_id=system', headers: H });
    expect(s3.keys.map((k) => k.key)).toEqual([`sessions/${SID}/orders.json`, 'orders.json']);
  });
});
