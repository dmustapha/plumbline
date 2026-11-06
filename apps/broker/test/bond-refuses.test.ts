// File: apps/broker/test/bond-refuses.test.ts
// L7 pipeline-level proof: an approved irreversible delete holds then burns the bond, and the NEXT provision is
// refused by the engine (DENY bond-insufficient) before any network call. Bond is a risk budget, not a deterrent.
import { describe, expect, it } from 'vitest';
import { Bond, getDecision, listDecisions } from '@plumbline/ledger';
import { makeBroker } from './support.ts';

const claims = { task_id: 't-bond', session_id: 'sessbond' };
const claimsB = { task_id: 't-bond-b', session_id: 'sessbond2' };
const KEY = 'bond-scene/s1.json';
const worker = { verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-bond' } };
const objCall = (verb: string, id: string, params: Record<string, unknown> = {}) => ({ verb, class: 'bucket_object', target: { id }, params });
const posts = (mock: { state: { calls: { method: string }[] } }) => mock.state.calls.filter((c) => c.method === 'POST');

/** The broker does not export its Bond; a second handle on the same ledger db reads the same rows. */
const bondOf = (app: Awaited<ReturnType<typeof makeBroker>>['app']): Bond => new Bond(app.db, 0.05);

async function approvedDelete(app: Awaited<ReturnType<typeof makeBroker>>['app'], key: string) {
  const out = await app.pipeline.handleCall(claims, objCall('delete', key));
  if (out.status !== 'DECIDED' || !out.approval) throw new Error('expected an ESCALATE with an approval nonce');
  return { escalation: out.decision, done: await app.pipeline.approve(claims.session_id, out.decision.decision_id, out.approval.nonce, true) };
}

describe('L7 bond: refuses_after_slash (pipeline level)', () => {
  it('refuses_after_slash: a burned bond makes the next provision DENY bond-insufficient with no network call', async () => {
    const { app, mock, s3 } = await makeBroker({ versions: 1, config: { bondEnabled: true } });
    expect(bondOf(app).snapshot(claims.session_id)).toEqual({ free: 0.05, held: 0, burned: 0 });
    const put = await app.pipeline.handleCall(claims, objCall('put', KEY, { content: '{"scene":"bond"}' }));
    expect(put.status === 'DECIDED' && put.decision.decision).toBe('ALLOW');

    const { escalation, done } = await approvedDelete(app, KEY);
    expect(escalation.decision).toBe('ESCALATE');
    expect(done.status).toBe('DECIDED');
    expect(s3.ops).toContain('delete');
    expect(bondOf(app).snapshot(claims.session_id).held).toBe(0);
    expect(bondOf(app).snapshot(claims.session_id).burned).toBeCloseTo(0.045, 9);
    expect(bondOf(app).snapshot(claims.session_id).free).toBeCloseTo(0.005, 9);
    const burnRow = app.db.prepare("SELECT amount, state FROM bond_actions WHERE action_id = ?").get(escalation.decision_id);
    expect(burnRow).toEqual({ amount: 0.045, state: 'burned' });
    const allowRow = listDecisions(app.db).find((r) => r.decision === 'ALLOW' && r.detail_json.includes(`"approved_from":"${escalation.decision_id}"`));
    expect(allowRow?.class).toBe('bucket_object');

    mock.state.calls.length = 0;
    const next = await app.pipeline.handleCall(claims, worker);
    expect(next.status).toBe('DECIDED');
    if (next.status !== 'DECIDED') return;
    expect(next.decision.decision).toBe('DENY');
    expect(next.decision.rule_id).toBe('bond-insufficient');
    expect(mock.state.calls).toHaveLength(0);
    expect(mock.state.instances).toHaveLength(0);
    expect(app.ledger.sessionSpend(claims.session_id)).toBe(0);
    expect(getDecision(app.db, next.decision.decision_id)?.rule_id).toBe('bond-insufficient');
  });

  it('control: the same provision is ALLOWed before the slash', async () => {
    const { app, mock } = await makeBroker({ versions: 1, config: { bondEnabled: true } });
    const out = await app.pipeline.handleCall(claims, worker);
    expect(out.status === 'DECIDED' && out.decision.decision).toBe('ALLOW');
    expect(posts(mock)).toHaveLength(1);
  });

  it('control: with the bond disabled the same delete burns nothing and the next provision is ALLOWed', async () => {
    const { app } = await makeBroker({ versions: 1, config: { bondEnabled: false } });
    await approvedDelete(app, KEY);
    expect(bondOf(app).snapshot(claims.session_id)).toEqual({ free: 0.05, held: 0, burned: 0 });
    const out = await app.pipeline.handleCall(claims, worker);
    expect(out.status === 'DECIDED' && out.decision.decision).toBe('ALLOW');
  });

  it('a reversible delete (two versions) is a plain ALLOW: nothing is held or burned', async () => {
    const { app } = await makeBroker({ versions: 2, config: { bondEnabled: true } });
    const out = await app.pipeline.handleCall(claims, objCall('delete', 'orders.json'));
    expect(out.status === 'DECIDED' && out.decision.decision).toBe('ALLOW');
    expect(bondOf(app).snapshot(claims.session_id)).toEqual({ free: 0.05, held: 0, burned: 0 });
    const next = await app.pipeline.handleCall(claims, worker);
    expect(next.status === 'DECIDED' && next.decision.decision).toBe('ALLOW');
  });

  it('a delete that fails at the store releases the hold: the bond is not burned and provisioning stays open', async () => {
    const { app, s3 } = await makeBroker({ versions: 1, config: { bondEnabled: true } });
    s3.port.deleteObject = async () => { throw new Error('boom'); };
    const { done } = await approvedDelete(app, KEY);
    expect(done.status === 'DECIDED' && done.error?.code).toBeTruthy();
    expect(bondOf(app).snapshot(claims.session_id)).toEqual({ free: 0.05, held: 0, burned: 0 });
    const next = await app.pipeline.handleCall(claims, worker);
    expect(next.status === 'DECIDED' && next.decision.decision).toBe('ALLOW');
  });

  it('a second irreversible delete after the slash cannot hold a bond and does not execute', async () => {
    const { app, s3 } = await makeBroker({ versions: 1, config: { bondEnabled: true } });
    await approvedDelete(app, KEY);
    const deletesBefore = s3.ops.filter((o) => o === 'delete').length;
    const { done } = await approvedDelete(app, 'bond-scene/s2.json');
    expect(done.status === 'DECIDED' && done.decision.rule_id).toBe('bond-insufficient');
    expect(s3.ops.filter((o) => o === 'delete')).toHaveLength(deletesBefore);
    expect(bondOf(app).snapshot(claims.session_id).burned).toBeCloseTo(0.045, 9);
  });

  it('BOND-PER-SESSION a slash in session A does not stop session B provisioning, and B can still be slashed on its own', async () => {
    const { app, mock } = await makeBroker({ versions: 1, config: { bondEnabled: true } });
    await approvedDelete(app, KEY);
    const refused = await app.pipeline.handleCall(claims, worker);
    expect(refused.status === 'DECIDED' && refused.decision.rule_id).toBe('bond-insufficient');
    expect(bondOf(app).snapshot(claimsB.session_id)).toEqual({ free: 0.05, held: 0, burned: 0 });

    mock.state.calls.length = 0;
    const other = await app.pipeline.handleCall(claimsB, { ...worker, params: { ...worker.params, label: 'plumbline-wk-bond-b' } });
    expect(other.status === 'DECIDED' && other.decision.decision).toBe('ALLOW');
    expect(posts(mock)).toHaveLength(1);

    const out = await app.pipeline.handleCall(claimsB, objCall('delete', 'bond-scene/b1.json'));
    if (out.status !== 'DECIDED' || !out.approval) throw new Error('expected an ESCALATE for session B');
    await app.pipeline.approve(claimsB.session_id, out.decision.decision_id, out.approval.nonce, true);
    expect(bondOf(app).snapshot(claimsB.session_id).burned).toBeCloseTo(0.045, 9);
    expect(bondOf(app).snapshot(claims.session_id).burned).toBeCloseTo(0.045, 9);
  });
});

