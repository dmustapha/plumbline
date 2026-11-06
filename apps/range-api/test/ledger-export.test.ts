// File: apps/range-api/test/ledger-export.test.ts
// CO-D: the verifier reaches the broker's HMAC-gated ledger export through range-api, and nothing else of the broker.
import { describe, expect, it } from 'vitest';
import { exportSignature } from '../../broker/src/ledgerExport.ts';
import { makeBroker, secrets } from '../../broker/test/support.ts';
import { makeApi, fakeBroker } from './support.ts';

type Sent = { method: string; path: string; headers: Record<string, string> };

/** A broker stand-in that is the REAL broker internal app, and records what range-api sent it. */
async function realBrokerApi() {
  const { app } = await makeBroker();
  const sent: Sent[] = [];
  const call = async (method: string, path: string, _body?: unknown, extra: Record<string, string> = {}) => {
    const headers = { 'x-plumbline-api-token': secrets.apiToken, ...extra };
    sent.push({ method, path, headers: extra });
    const r = await app.internal.inject({ method: method as 'GET', url: path, headers });
    return { status: r.statusCode, json: r.json() as unknown };
  };
  const f = fakeBroker();
  const api = await makeApi(f, { broker: { call, chat: f.broker.chat, mint: f.broker.mint } as never });
  return { api: api.app, sent, brokerApp: app };
}

describe('CO-D: GET /v1/ledger/export', () => {
  it('CO-D a signed request is forwarded with exactly the two HMAC headers and the broker answer comes back unchanged', async () => {
    const { api, sent } = await realBrokerApi();
    const ts = String(Date.now());
    const sig = exportSignature(secrets.leaseSecret, Number(ts));
    const r = await api.inject({ method: 'GET', url: '/v1/ledger/export', headers: { 'x-plumbline-ts': ts, 'x-plumbline-sig': sig, authorization: 'Bearer x', cookie: 'a=b', 'x-plumbline-session-key': 'k' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().schema).toBe('plumbline-ledger-export/v2');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'GET', path: '/v1/ledger/export' });
    expect(Object.keys(sent[0]?.headers ?? {}).sort()).toEqual(['x-plumbline-sig', 'x-plumbline-ts']);
  });
  it('CO-D an unsigned request gets 401 from the broker, not from range-api', async () => {
    const { api, sent } = await realBrokerApi();
    const r = await api.inject({ method: 'GET', url: '/v1/ledger/export' });
    expect([r.statusCode, r.json().status]).toEqual([401, 'AUTH_EXPORT_INVALID']);
    expect(sent).toHaveLength(1);
  });
  it('CO-D a wrong signature and a stale timestamp are 401 from the broker', async () => {
    const { api } = await realBrokerApi();
    const ts = String(Date.now());
    const bad = await api.inject({ method: 'GET', url: '/v1/ledger/export', headers: { 'x-plumbline-ts': ts, 'x-plumbline-sig': 'ab'.repeat(32) } });
    expect(bad.statusCode).toBe(401);
    const old = String(Date.now() - 120_000);
    const stale = await api.inject({ method: 'GET', url: '/v1/ledger/export', headers: { 'x-plumbline-ts': old, 'x-plumbline-sig': exportSignature(secrets.leaseSecret, Number(old)) } });
    expect(stale.statusCode).toBe(401);
  });
  it('CO-D no other /v1/* path is forwarded to the broker', async () => {
    const { api, sent } = await realBrokerApi();
    const paths: [string, string][] = [
      ['GET', '/v1/status'], ['GET', '/v1/decisions'], ['GET', '/v1/proof'], ['POST', '/v1/session'], ['POST', '/v1/task'], ['POST', '/v1/llm'],
      ['GET', '/v1/admin/kill-switch/clear'], ['POST', '/v1/admin/kill-switch/engage'], ['GET', '/v1/ledger/export/'], ['GET', '/v1/ledger/exportx'], ['GET', '/v1/ledger'],
    ];
    for (const [method, url] of paths) {
      const r = await api.inject({ method: method as 'GET', url, headers: { 'x-plumbline-ts': '1', 'x-plumbline-sig': 'x' } });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(sent).toHaveLength(0);
  });
  it('CO-D a dead broker is 502, not an exception', async () => {
    const f = fakeBroker();
    const api = await makeApi(f, { broker: { call: async () => { throw new Error('ECONNREFUSED'); }, chat: f.broker.chat, mint: f.broker.mint } as never });
    const r = await api.app.inject({ method: 'GET', url: '/v1/ledger/export' });
    expect([r.statusCode, r.json().status]).toEqual([502, 'BROKER_UNREACHABLE']);
  });
});
