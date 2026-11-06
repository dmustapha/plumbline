// File: apps/broker/test/orphan-sweep.test.ts
// LIVE FINDING: sessions are in memory, so a broker restart orphans playground VPCs; their ledger rows must not eat the 5-per-location capacity for ever.
import { describe, expect, it } from 'vitest';
import { makeBroker, secrets } from './support.ts';

const H = { 'x-plumbline-api-token': secrets.apiToken };
type Built = Awaited<ReturnType<typeof makeBroker>>;
type Created = { session_id: string; playground: { id: string } | null };
const newSession = async (app: Built['app']): Promise<Created> => (await app.internal.inject({ method: 'POST', url: '/v1/session', headers: H, payload: {} })).json();
const vpcs = (mock: Built['mock']) => mock.state.vpcs as unknown as { id: string }[];
const active = (app: Built['app']): number => (app.db.prepare("SELECT COUNT(*) n FROM resources WHERE class='vpc' AND protected=1 AND destroyed_at_ms IS NULL").get() as { n: number }).n;

describe('ORPHAN-SWEEP playground VPCs whose session is gone', () => {
  it('ORPHAN-SWEEP a live VPC with no session is deleted through the audited cleanup path and its row closes', async () => {
    const { app, mock } = await makeBroker();
    const s = await newSession(app);
    expect(active(app)).toBe(1);
    app.sessions.drop(s.session_id); // what a restart does to the in-memory registry
    await app.reap();
    expect(vpcs(mock)).toHaveLength(0);
    expect(active(app)).toBe(0);
  });
  it('ORPHAN-SWEEP a row whose VPC is already gone at Vultr is closed without a delete call', async () => {
    const { app, mock } = await makeBroker();
    const s = await newSession(app);
    app.sessions.drop(s.session_id);
    mock.state.vpcs.length = 0; // deleted out of band (owner cleanup)
    await app.reap();
    expect(active(app)).toBe(0);
  });
  it('ORPHAN-SWEEP a VPC whose session is still alive is never touched', async () => {
    const { app, mock } = await makeBroker();
    await newSession(app);
    await app.reap();
    expect(vpcs(mock)).toHaveLength(1);
    expect(active(app)).toBe(1);
  });
  it('ORPHAN-SWEEP freed capacity lets a new session get a playground again', async () => {
    const { app } = await makeBroker();
    const first = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => newSession(app)));
    expect(first.every((s) => s.playground)).toBe(true);
    const ninth = await newSession(app);
    expect(ninth.playground).toBeNull();
    first.forEach((s) => app.sessions.drop(s.session_id));
    await app.reap();
    expect((await newSession(app)).playground).not.toBeNull();
  });
});
