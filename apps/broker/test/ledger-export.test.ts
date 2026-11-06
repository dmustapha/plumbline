// File: apps/broker/test/ledger-export.test.ts
// CO-2 H-2 (E-1): the export schema is frozen NOW. This test pins the exact key sets; a change here is a new schema id.
import { describe, expect, it } from 'vitest';
import { verifyExport } from '@plumbline/ledger';
import { LEDGER_EXPORT_KEYS, LEDGER_EXPORT_SCHEMA, exportSignature, type LedgerExport } from '../src/ledgerExport.ts';
import { makeBroker, secrets } from './support.ts';

const claims = { task_id: 't1', session_id: 'sessaaa1' };

async function fetchExport(app: Awaited<ReturnType<typeof makeBroker>>['app']) {
  const ts = Date.now();
  return app.internal.inject({ method: 'GET', url: '/v1/ledger/export', headers: { 'x-plumbline-ts': String(ts), 'x-plumbline-sig': exportSignature(secrets.leaseSecret, ts) } });
}

describe('GET /v1/ledger/export frozen contract (CO-2 H-2)', () => {
  it('H-2 the export rejects an unsigned request and serves the frozen key sets when signed', async () => {
    const { app } = await makeBroker();
    expect((await app.internal.inject({ method: 'GET', url: '/v1/ledger/export' })).statusCode).toBe(401);
    await app.pipeline.handleCall(claims, { verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-aaaa' } });
    await app.pipeline.handleCall(claims, { verb: 'delete', class: 'instance', target: { id: 'nope' } });
    const r = await fetchExport(app);
    expect(r.statusCode).toBe(200);
    const exp = r.json() as LedgerExport;
    expect(exp.schema).toBe(LEDGER_EXPORT_SCHEMA);
    const keys = (o: object): string[] => Object.keys(o).sort();
    const want = (k: readonly string[]): string[] => [...k].sort();
    expect(keys(exp)).toEqual(want(LEDGER_EXPORT_KEYS.top));
    expect(keys(exp.decisions[0] as object)).toEqual(want(LEDGER_EXPORT_KEYS.decision));
    expect(keys(exp.resources[0] as object)).toEqual(want(LEDGER_EXPORT_KEYS.resource));
  });
  it('H-2 every row carries plan, region and the full normalized request, so the engine can be re-run', async () => {
    const { app } = await makeBroker();
    await app.pipeline.handleCall(claims, { verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-aaaa' } });
    const exp = (await fetchExport(app)).json() as LedgerExport;
    const d = exp.decisions[0];
    expect(d).toMatchObject({ seq: 1, decision: 'ALLOW', verb: 'create', class: 'instance', plan: 'vc2-1c-1gb', region: 'ewr' });
    expect(d?.request).toMatchObject({ verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-aaaa' } });
    expect(d?.request_hash).toMatch(/^[0-9a-f]{64}$/);
    const res = exp.resources[0];
    expect(res).toMatchObject({ class: 'instance', plan: 'vc2-1c-1gb', region: 'ewr', allow_decision_kind: 'ALLOW', allow_request_hash: d?.request_hash });
    expect(res?.request).toEqual(d?.request);
  });
  it('H-2 the hash chain verifies, a forged row does not, and the response is fresh', async () => {
    const { app } = await makeBroker();
    await app.pipeline.handleCall(claims, { verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-aaaa' } });
    const exp = (await fetchExport(app)).json() as LedgerExport;
    expect(verifyExport(exp, { now_ms: Date.now(), max_age_ms: 5000 })).toEqual({ ok: true });
    const forged = structuredClone(exp);
    (forged.resources[0] as { plan: string }).plan = 'vc2-24c-96gb';
    expect(verifyExport(forged, { now_ms: Date.now(), max_age_ms: 5000 }).ok).toBe(false);
    expect(verifyExport(exp, { now_ms: Date.now() + 60_000, max_age_ms: 5000 })).toMatchObject({ ok: false, reason: 'STALE' });
  });
});
