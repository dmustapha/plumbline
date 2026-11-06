// File: apps/broker/test/pipeline.test.ts
import { describe, expect, it } from 'vitest';
import { listDecisions, proofCounts } from '@plumbline/ledger';
import { makeBroker } from './support.ts';

const claims = { task_id: 't1', session_id: 'sess0001' };
const call = (verb: string, cls: string, id?: string, params: Record<string, unknown> = {}) => ({ verb, class: cls, target: id ? { id } : {}, params });

describe('pipeline', () => {
  it('DENY protect-tagged-destroy leaves the live account unchanged', async () => {
    const { app, mock } = await makeBroker();
    mock.state.instances.push({ id: 'i-prod', label: 'plumbline-prod-db', status: 'active', tags: ['protected'] });
    const out = await app.pipeline.handleCall(claims, call('delete', 'instance', 'i-prod'), 'qwen3.8-27b');
    expect(out.status).toBe('DECIDED');
    if (out.status !== 'DECIDED') return;
    expect(out.decision.decision).toBe('DENY');
    expect(out.decision.rule_id).toBe('protect-tagged-destroy');
    expect(out.decision.layers.find((l) => l.layer === 'floor')?.rule_id).toBe('floor-prod-immutable');
    expect(mock.state.instances).toHaveLength(1);
    expect(mock.state.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(listDecisions(app.db)[0]?.model).toBe('qwen3.8-27b');
  });
  it('ignores model-supplied labels and tags and still resolves the truth', async () => {
    const { app, mock } = await makeBroker();
    mock.state.instances.push({ id: 'i-prod', label: 'plumbline-prod-db', status: 'active', tags: ['protected'] });
    const lie = { verb: 'delete', class: 'instance', target: { id: 'i-prod', label: 'plumbline-wk-lie', tags: [] } };
    const out = await app.pipeline.handleCall(claims, lie);
    expect(out.status === 'DECIDED' && out.decision.rule_id).toBe('protect-tagged-destroy');
  });
  it('ARGS_INVALID reaches nothing and writes no decision row', async () => {
    const { app, mock } = await makeBroker();
    const out = await app.pipeline.handleCall(claims, { verb: 'create', class: 'instance', params: { plan: 5, bogus: 1 } });
    expect(out.status).toBe('ARGS_INVALID');
    expect(mock.state.calls).toHaveLength(0);
    expect(proofCounts(app.db).attacks).toBe(0);
  });
  it('a worker create is ALLOW, appears pending in the live account, and is charged', async () => {
    const { app, mock } = await makeBroker();
    const out = await app.pipeline.handleCall(claims, call('create', 'instance', undefined, { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-aaaa' }));
    expect(out.status === 'DECIDED' && out.decision.decision).toBe('ALLOW');
    expect(mock.state.instances).toHaveLength(1);
    expect(app.ledger.sessionSpend(claims.session_id)).toBeCloseTo(0.007, 6);
    expect(app.ledger.liveWorkerCount()).toBe(1);
  });
  it('an over-ceiling create is refused before any POST', async () => {
    const { app, mock } = await makeBroker({ config: { sessionCeilingUsd: 0.005 } });
    const out = await app.pipeline.handleCall(claims, call('create', 'instance', undefined, { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-aaaa' }));
    expect(out.status === 'DECIDED' && out.decision.rule_id).toBe('ceiling-dollar-deny');
    expect(mock.state.calls.some((c) => c.method === 'POST')).toBe(false);
  });
  it('kill-switch refuses every mutating verb', async () => {
    const { app } = await makeBroker();
    app.kill.engage('test');
    const out = await app.pipeline.handleCall(claims, call('create', 'instance', undefined, { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-aaaa' }));
    expect(out.status === 'DECIDED' && out.decision.rule_id).toBe('kill-switch-engaged');
  });
  it('last copy escalates and a denied approval deletes nothing', async () => {
    const { app, s3 } = await makeBroker({ versions: 1 });
    const out = await app.pipeline.handleCall(claims, call('delete', 'bucket_object', 'orders.json'));
    expect(out.status === 'DECIDED' && out.decision.rule_id).toBe('last-copy-block');
    if (out.status !== 'DECIDED' || !out.approval) throw new Error('expected approval');
    const res = await app.pipeline.approve(claims.session_id, out.decision.decision_id, out.approval.nonce, false);
    expect(res.status).toBe('DENIED');
    expect(s3.ops).not.toContain('delete');
  });
  it('an approved last-copy delete executes through an engine ALLOW, bad nonce does not', async () => {
    const { app, s3 } = await makeBroker({ versions: 1 });
    const out = await app.pipeline.handleCall(claims, call('delete', 'bucket_object', 'orders.json'));
    if (out.status !== 'DECIDED' || !out.approval) throw new Error('expected approval');
    expect((await app.pipeline.approve(claims.session_id, out.decision.decision_id, 'wrong', true)).status).toBe('BAD_NONCE');
    const done = await app.pipeline.approve(claims.session_id, out.decision.decision_id, out.approval.nonce, true);
    expect(done.status).toBe('DECIDED');
    expect(s3.ops).toContain('delete');
  });
  it('unknown ids resolve to no label and fall to scope-label-prefix', async () => {
    const { app } = await makeBroker();
    const out = await app.pipeline.handleCall(claims, call('delete', 'instance', 'does-not-exist'));
    expect(out.status === 'DECIDED' && out.decision.rule_id).toBe('scope-label-prefix');
  });
});
