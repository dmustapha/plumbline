// File: apps/range-api/test/verify-run-race.test.ts
// A reconcile run already in progress (the keep-fresh timer's) must not surface to a visitor as a 409: they get the current report.
import { afterAll, describe, expect, it } from 'vitest';
import { cfg, fakeBroker, makeApi } from './support.ts';

const report = { status: 'GREEN', counts: { unauthorized: 0 }, age_s: 3 };
const mk = (runStatus: number): typeof fetch => (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url); const method = init?.method ?? 'GET';
  if (u.endsWith('/api/verify/run') && method === 'POST') return new Response(JSON.stringify(runStatus === 409 ? { status: 'RUNNING' } : report), { status: runStatus });
  if (u.endsWith('/api/verify')) return new Response(JSON.stringify(report), { status: 200 });
  return new Response('{}', { status: 404 });
}) as typeof fetch;

const apps: { close(): Promise<void> }[] = [];
afterAll(async () => { for (const a of apps) await a.close(); });

describe('POST /api/verify/run when a run is already in progress', () => {
  it('answers 200 with the current report instead of passing the 409 through', async () => {
    const { app } = await makeApi(fakeBroker(), { fetchImpl: mk(409) }, { ...cfg, verifierUrl: 'http://verifier.test' }); apps.push(app);
    const r = await app.inject({ method: 'POST', url: '/api/verify/run', payload: {} });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ status: 'GREEN' });
  });
  it('a normal run still returns the verifier report with its own status', async () => {
    const { app } = await makeApi(fakeBroker(), { fetchImpl: mk(200) }, { ...cfg, verifierUrl: 'http://verifier.test' }); apps.push(app);
    const r = await app.inject({ method: 'POST', url: '/api/verify/run', payload: {} });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ status: 'GREEN', age_s: 3 });
  });
});
