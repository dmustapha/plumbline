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

// Phase 5 debug regressions (debug-results/phase-5-core-critique.md M1 to M4).
import { listUnknownOutcomes } from '@plumbline/ledger';
import { VultrError } from '@plumbline/vultr-adapter';

const mkWorker = (label: string) => call('create', 'instance', undefined, { plan: 'vc2-1c-1gb', region: 'ewr', label });
const decided = (o: { status: string }) => o as { status: 'DECIDED'; decision: { decision: string; rule_id: string }; error?: { code: string } };

describe('DBG phase-5 core', () => {
  it('DBG-M1: parallel creates never exceed max_instances', async () => {
    const { app, mock } = await makeBroker({ config: { maxInstances: 2 } });
    const outs = await Promise.all([1, 2, 3, 4, 5].map((n) => app.pipeline.handleCall(claims, mkWorker(`plumbline-wk-par${n}`))));
    const allows = outs.filter((o) => decided(o).decision.decision === 'ALLOW');
    expect(allows).toHaveLength(2);
    expect(outs.filter((o) => decided(o).decision.rule_id === 'max-instances')).toHaveLength(3);
    expect(mock.state.instances).toHaveLength(2);
    expect(app.ledger.liveWorkerCount()).toBe(2);
  });

  it('DBG-M2: a zero-cost call is never refused by the cap, a positive-cost call over the cap still is', async () => {
    const { app } = await makeBroker({ config: { globalCapUsd: 1 } });
    app.ledger.recordInference('sess0001', 'm', 1, 1, 1.01);
    expect(app.ledger.charge('vultr', 0, { session_id: 'sess0001' }).ok).toBe(true);
    expect(app.ledger.charge('s3', 0, { session_id: 'sess0001' }).ok).toBe(true);
    const pos = app.ledger.charge('vultr', 0.007, { session_id: 'sess0001' });
    expect(pos.ok === false && pos.reason).toBe('global-cap-exceeded');
  });

  it('DBG-M2: destroyWorkers destroys the fleet when the budget is exhausted', async () => {
    const { app, mock } = await makeBroker({ config: { globalCapUsd: 1 } });
    expect(decided(await app.pipeline.handleCall(claims, mkWorker('plumbline-wk-cap1'))).decision.decision).toBe('ALLOW');
    app.ledger.recordInference('sess0001', 'm', 1, 1, 1.01);
    const res = await app.pipeline.destroyWorkers();
    expect(res.failed).toEqual([]);
    expect(res.destroyed).toHaveLength(1);
    expect(mock.state.instances).toHaveLength(0);
    expect(app.ledger.liveWorkerCount()).toBe(0);
  });

  it('DBG-M3: reap closes a live worker row whose Vultr instance is already gone, and leaves a present one live', async () => {
    const { app, mock } = await makeBroker({ config: { maxInstances: 2 } });
    await app.pipeline.handleCall(claims, mkWorker('plumbline-wk-gone1'));
    await app.pipeline.handleCall(claims, mkWorker('plumbline-wk-stay1'));
    expect(app.ledger.liveWorkerCount()).toBe(2);
    mock.state.instances.splice(0, 1); // deleted out of band
    await app.reap();
    expect(app.ledger.liveWorkerCount()).toBe(1);
    expect(mock.state.instances).toHaveLength(1);
    const third = await app.pipeline.handleCall(claims, mkWorker('plumbline-wk-third'));
    expect(decided(third).decision.decision).toBe('ALLOW');
  });

  it('DBG-M3: a failed instance listing closes nothing', async () => {
    const { app, mock } = await makeBroker();
    await app.pipeline.handleCall(claims, mkWorker('plumbline-wk-keep1'));
    mock.state.instances.length = 0;
    app.tiers.noteFailure('observer', new VultrError(401, null, null, '/instances'));
    await app.reap().catch(() => undefined); // later reap steps also need the observer tier
    expect(mock.state.instances).toHaveLength(0);
    expect(app.ledger.liveWorkerCount()).toBe(1);
  });

  it('DBG-M4: an ambiguous create (502) records an unknown outcome that counts against max_instances', async () => {
    const { app, mock } = await makeBroker({ config: { maxInstances: 1 } });
    mock.state.nextCreateStatus = 502;
    const out = decided(await app.pipeline.handleCall(claims, mkWorker('plumbline-wk-amb1')));
    mock.state.nextCreateStatus = 202;
    expect(out.error?.code).toBe('OUTCOME_UNKNOWN');
    expect(mock.state.instances).toHaveLength(1);
    expect(listUnknownOutcomes(app.db)).toHaveLength(1);
    expect(app.ledger.liveWorkerCount()).toBe(0);
    const second = decided(await app.pipeline.handleCall(claims, mkWorker('plumbline-wk-amb2')));
    expect(second.decision.rule_id).toBe('max-instances');
    expect(mock.state.instances).toHaveLength(1);
  });

  it('DBG-M4: the reaper deletes the unrecorded instance on its second sighting and resolves the outcome', async () => {
    const { app, mock } = await makeBroker({ config: { maxInstances: 1 } });
    mock.state.nextCreateStatus = 502;
    await app.pipeline.handleCall(claims, mkWorker('plumbline-wk-amb3'));
    mock.state.nextCreateStatus = 202;
    await app.reap();
    expect(mock.state.instances).toHaveLength(1); // first sighting: never raced
    await app.reap();
    expect(mock.state.instances).toHaveLength(0);
    expect(listUnknownOutcomes(app.db)).toHaveLength(0);
    expect(decided(await app.pipeline.handleCall(claims, mkWorker('plumbline-wk-amb4'))).decision.decision).toBe('ALLOW');
  });

  it('DBG-M4: an unknown create that left no instance is resolved after two empty sweeps', async () => {
    const { app, mock } = await makeBroker({ config: { maxInstances: 1 } });
    mock.state.nextCreateStatus = 502;
    await app.pipeline.handleCall(claims, mkWorker('plumbline-wk-amb5'));
    mock.state.nextCreateStatus = 202;
    mock.state.instances.length = 0; // Vultr never created it
    await app.reap();
    expect(listUnknownOutcomes(app.db)).toHaveLength(1);
    await app.reap();
    expect(listUnknownOutcomes(app.db)).toHaveLength(0);
  });
});
