// File: apps/broker/test/playground-cap.test.ts
// PLAYGROUND-CAP: this Vultr account allows 5 VPCs per location, so playground VPCs spill ewr -> ord and the 9th session gets none.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { makeBroker, secrets } from './support.ts';

const H = { 'x-plumbline-api-token': secrets.apiToken };
type Built = Awaited<ReturnType<typeof makeBroker>>;
type Created = { session_id: string; playground: { id: string; label: string } | null; playground_error: { code?: string; detail?: string } | null };
const newSession = async (app: Built['app']): Promise<Created> => (await app.internal.inject({ method: 'POST', url: '/v1/session', headers: H, payload: {} })).json();
const vpcs = (mock: Built['mock']) => mock.state.vpcs as unknown as { id: string; region: string }[];
const regionsOf = (mock: Built['mock']) => vpcs(mock).map((v) => v.region);
const ENV = {
  VULTR_S3_HOST: 'h', PLUMBLINE_API_TOKEN: 'a', PLUMBLINE_ADMIN_TOKEN: 'b', PLUMBLINE_TASK_HMAC: 'c', PLUMBLINE_LEASE_SECRET: 'd',
  PLUMBLINE_POLICY_PUBKEY: 'e', VULTR_INFERENCE_API_KEY: 'f', VULTR_S3_ACCESS_KEY: 'g', VULTR_S3_SECRET_KEY: 'h',
};

describe('PLAYGROUND-CAP config', () => {
  it('PLAYGROUND-CAP defaults: regions ewr,ord, cap 4 per region, idle 10 minutes', () => {
    const c = loadConfig(ENV).config;
    expect([c.playgroundRegions, c.playgroundCapPerRegion, c.sessionIdleMs]).toEqual([['ewr', 'ord'], 4, 600_000]);
  });
  it('PLAYGROUND-CAP env overrides, with whitespace and empty entries ignored', () => {
    const c = loadConfig({ ...ENV, PLUMBLINE_PLAYGROUND_REGIONS: ' ord , ,ewr', PLUMBLINE_PLAYGROUND_CAP_PER_REGION: '2', PLUMBLINE_SESSION_IDLE_MIN: '5' }).config;
    expect([c.playgroundRegions, c.playgroundCapPerRegion, c.sessionIdleMs]).toEqual([['ord', 'ewr'], 2, 300_000]);
  });
  it('PLAYGROUND-CAP an empty region list or a non-positive cap refuses to boot', () => {
    expect(() => loadConfig({ ...ENV, PLUMBLINE_PLAYGROUND_REGIONS: ' , ' })).toThrow('BOOT_REFUSED');
    expect(() => loadConfig({ ...ENV, PLUMBLINE_PLAYGROUND_CAP_PER_REGION: '0' })).toThrow('BOOT_REFUSED');
  });
  it('PLAYGROUND-CAP the example env file says idle 10, regions ewr,ord and cap 4', () => {
    const text = readFileSync(new URL('../../../ops/env/broker.env.example', import.meta.url), 'utf8');
    expect(text).toMatch(/^PLUMBLINE_SESSION_IDLE_MIN=10$/m);
    expect(text).toMatch(/^PLUMBLINE_PLAYGROUND_REGIONS=ewr,ord$/m);
    expect(text).toMatch(/^PLUMBLINE_PLAYGROUND_CAP_PER_REGION=4$/m);
  });
});

describe('PLAYGROUND-CAP region choice', () => {
  it('PLAYGROUND-CAP the first session gets ewr', async () => {
    const { app, mock } = await makeBroker();
    const s = await newSession(app);
    expect(s.playground).not.toBeNull();
    expect(regionsOf(mock)).toEqual(['ewr']);
  });
  it('PLAYGROUND-CAP four sessions fill ewr, the next four go to ord, then the 9th gets PLAYGROUND_CAPACITY with zero Vultr calls', async () => {
    const { app, mock } = await makeBroker();
    for (let i = 0; i < 8; i++) expect((await newSession(app)).playground).not.toBeNull();
    expect(regionsOf(mock)).toEqual(['ewr', 'ewr', 'ewr', 'ewr', 'ord', 'ord', 'ord', 'ord']);
    mock.state.calls.length = 0;
    const ninth = await newSession(app);
    expect(ninth.playground).toBeNull();
    expect(ninth.playground_error).toMatchObject({ code: 'PLAYGROUND_CAPACITY' });
    expect(String(ninth.playground_error?.detail)).toMatch(/ewr|ord|capacity/i);
    expect(mock.state.calls).toHaveLength(0);
    expect(vpcs(mock)).toHaveLength(8);
    expect(app.sessions.get(ninth.session_id)).toBeDefined();
  });
  it('PLAYGROUND-CAP simultaneous session creations never exceed the cap', async () => {
    const { app, mock } = await makeBroker();
    const all = await Promise.all(Array.from({ length: 11 }, () => newSession(app)));
    expect(all.filter((s) => s.playground)).toHaveLength(8);
    expect(all.filter((s) => s.playground_error?.code === 'PLAYGROUND_CAPACITY')).toHaveLength(3);
    expect(regionsOf(mock).filter((r) => r === 'ewr')).toHaveLength(4);
    expect(regionsOf(mock).filter((r) => r === 'ord')).toHaveLength(4);
  });
  it('PLAYGROUND-CAP a region cap of 1 and one region means the second session gets no playground', async () => {
    const { app } = await makeBroker({ config: { playgroundRegions: ['ewr'], playgroundCapPerRegion: 1 } });
    expect((await newSession(app)).playground).not.toBeNull();
    expect((await newSession(app)).playground_error).toMatchObject({ code: 'PLAYGROUND_CAPACITY' });
  });
  it('PLAYGROUND-CAP a VPC that is not a protected playground does not count against the cap', async () => {
    const { app, mock } = await makeBroker({ config: { playgroundRegions: ['ewr'], playgroundCapPerRegion: 1 } });
    await app.pipeline.runSystem('s0', { verb: 'create', class: 'vpc', params: { label: 'plumbline-s0a0a0a0a-x', region: 'ewr', subnet: '10.150.1.0', subnet_size: 24 }, extra: {} });
    expect(vpcs(mock)).toHaveLength(1);
    expect((await newSession(app)).playground).not.toBeNull();
  });
  it('PLAYGROUND-CAP any other creation failure is still reported as the pipeline outcome, not as capacity', async () => {
    const { app, mock } = await makeBroker({ config: { playgroundRegions: ['ams'] } });
    const s = await newSession(app);
    expect(s.playground).toBeNull();
    expect(s.playground_error?.code).toBeUndefined();
    expect(JSON.stringify(s.playground_error)).toContain('region-not-allowed');
    expect(vpcs(mock)).toHaveLength(0);
  });
});

describe('PLAYGROUND-CAP cleanup and the engine', () => {
  it('PLAYGROUND-CAP idle cleanup frees capacity, whatever region the VPC is in', async () => {
    let now = 5_000_000;
    const { app, mock } = await makeBroker({ clock: () => now });
    const made: Created[] = [];
    for (let i = 0; i < 8; i++) made.push(await newSession(app));
    expect((await newSession(app)).playground_error).toMatchObject({ code: 'PLAYGROUND_CAPACITY' });
    const idle = [made[0], made[5]] as Created[];
    now += 20 * 60_000;
    for (const s of made) if (!idle.includes(s)) app.sessions.get(s.session_id);
    now += 11 * 60_000;
    await app.reap();
    expect(vpcs(mock)).toHaveLength(6);
    const next = await newSession(app);
    expect(next.playground).not.toBeNull();
    const again = await newSession(app);
    expect(again.playground).not.toBeNull();
    expect(regionsOf(mock).filter((r) => r === 'ewr')).toHaveLength(4);
    expect(regionsOf(mock).filter((r) => r === 'ord')).toHaveLength(4);
    expect((await newSession(app)).playground_error).toMatchObject({ code: 'PLAYGROUND_CAPACITY' });
  });
  it('PLAYGROUND-CAP a VPC created in ord passes the engine and is ledgered with region ord', async () => {
    const { app, mock } = await makeBroker({ config: { playgroundRegions: ['ord'] } });
    const s = await newSession(app);
    expect(s.playground).not.toBeNull();
    expect(regionsOf(mock)).toEqual(['ord']);
    const row = app.db.prepare("SELECT decision, region, rule_id FROM decisions WHERE class='vpc' AND verb='create'").get();
    expect(row).toMatchObject({ decision: 'ALLOW', region: 'ord' });
  });
  it('PLAYGROUND-CAP an instance in ord is still denied region-not-allowed and nothing reaches Vultr', async () => {
    const { app, mock } = await makeBroker();
    const out = await app.pipeline.runSystem('s0', { verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region: 'ord', label: 'plumbline-wk-ord' }, extra: {} });
    expect(out.status).toBe('DECIDED');
    expect(out.status === 'DECIDED' && [out.decision.decision, out.decision.rule_id]).toEqual(['DENY', 'region-not-allowed']);
    expect(mock.state.instances).toHaveLength(0);
  });
});
