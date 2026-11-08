// File: apps/range-api/test/ledger-public.test.ts
// The "check it yourself" ledger: the public export route, the in-browser verifier in public/app.js, and the offline script all agree,
// run against a REAL export (the ledger package's own writer), and a cheat is caught by every one of them.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exportLedger, openDb, recordDecision, type LedgerExport } from '../../../packages/ledger/src/index.ts';
import { createReq, decide } from '../../../packages/ledger/test/support/engine.ts';
import { verify as verifyScript } from '../../../scripts/verify-ledger.mjs';
import { makeBroker, secrets } from '../../broker/test/support.ts';
import { fakeBroker, makeApi } from './support.ts';

const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const block = appJs.slice(appJs.indexOf('/* ledger-verify:start */'), appJs.indexOf('/* ledger-verify:end */'));
const browser = new Function(`${block}; return { verifyLedgerExport, ledgerCheatCopy, ledgerCanon };`)() as {
  verifyLedgerExport: (e: unknown, sha: (t: string) => Promise<string>, o?: Record<string, unknown>) => Promise<{ ok: boolean; steps: { id: string; ok: boolean; detail: string }[] }>;
  ledgerCheatCopy: (e: unknown) => { copy: LedgerExport; seq: number; was: string; now: string };
  ledgerCanon: (v: unknown) => string;
};
const sha = async (t: string): Promise<string> => createHash('sha256').update(t).digest('hex');

function fixture(n = 6): LedgerExport {
  const db = openDb(':memory:');
  for (let i = 0; i < n; i += 1) {
    const r = createReq(`plumbline-wk-${i + 1}`); const d = decide(r);
    recordDecision(db, d, { session_id: r.session_id, task_id: r.task_id, model: null, call: null, vultr_ids: [], request: r }, 1000 + i);
  }
  return exportLedger(db, 5000);
}

describe('the browser verifier', () => {
  it('accepts a real export, and every step runs (including the request-fingerprint check)', async () => {
    const r = await browser.verifyLedgerExport(fixture(), sha);
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.id)).toEqual(['format', 'decisions', 'sequence', 'resources', 'unknown', 'head', 'allowtie', 'request']);
    expect(r.steps.find((s) => s.id === 'request')!.detail).toMatch(/^6 recorded requests/);
  });
  it('checks the second-region pin when there is one, and fails when it disagrees', async () => {
    const e = fixture();
    const good = await browser.verifyLedgerExport(e, sha, { pin: { seq: 4, row_hash: e.decisions[3]!.row_hash } });
    expect(good.ok).toBe(true); expect(good.steps.at(-1)!.id).toBe('pin');
    const bad = await browser.verifyLedgerExport(e, sha, { pin: { seq: 4, row_hash: 'f'.repeat(64) } });
    expect(bad.ok).toBe(false); expect(bad.steps.at(-1)!.detail).toMatch(/rewritten/);
  });
  it('the cheat copy (one verdict flipped) is caught at that row, and the original is untouched', async () => {
    const e = fixture(); const before = JSON.stringify(e);
    const k = browser.ledgerCheatCopy(e);
    const r = await browser.verifyLedgerExport(k.copy, sha);
    expect(r.ok).toBe(false);
    expect(r.steps.find((s) => !s.ok)!.detail).toContain(`#${k.seq}`);
    expect(JSON.stringify(e)).toBe(before);
  });
  it.each([
    ['a deleted row', (e: LedgerExport) => { e.decisions.splice(2, 1); }],
    ['a swapped row order', (e: LedgerExport) => { [e.decisions[1], e.decisions[2]] = [e.decisions[2]!, e.decisions[1]!]; }],
    ['a changed request body', (e: LedgerExport) => { (e.decisions[0]!.request as { params: object }).params = { x: 1 }; }],
    ['a forged chain head', (e: LedgerExport) => { e.chain_head = 'a'.repeat(64); }],
    ['a changed timestamp', (e: LedgerExport) => { e.decisions[3]!.ts += 1; }],
  ])('catches %s', async (_n, mutate) => {
    const e = JSON.parse(JSON.stringify(fixture())) as LedgerExport; mutate(e);
    expect((await browser.verifyLedgerExport(e, sha)).ok).toBe(false);
  });
  it('a re-hashed (consistent) rewrite still fails the second-region pin', async () => {
    const e = fixture(); const pin = { seq: e.decisions.length, row_hash: e.decisions.at(-1)!.row_hash };
    const rewritten = fixture(5); // a different, internally consistent history
    const r = await browser.verifyLedgerExport(rewritten, sha, { pin });
    expect(r.ok).toBe(false);
  });
  it('garbage in is a clear failure, not an exception', async () => {
    for (const x of [null, {}, { schema: 'x' }, { schema: 'plumbline-ledger-export/v2', decisions: 'no' }]) expect((await browser.verifyLedgerExport(x, sha)).ok).toBe(false);
  });
  it('canonical JSON sorts keys and drops undefined like the broker', () => {
    expect(browser.ledgerCanon({ b: 1, a: [2, { d: undefined, c: 'x' }] })).toBe('{"a":[2,{"c":"x"}],"b":1}');
  });
});

describe('the offline script agrees with the browser verifier', () => {
  it('same verdict on a good export and on every kind of damage', async () => {
    const e = fixture();
    expect(verifyScript(e, null).every((s: { ok: boolean }) => s.ok)).toBe(true);
    const k = browser.ledgerCheatCopy(e);
    expect(verifyScript(k.copy, null).every((s: { ok: boolean }) => s.ok)).toBe(false);
    const dropped = JSON.parse(JSON.stringify(e)) as LedgerExport; dropped.decisions.pop();
    expect(verifyScript(dropped, null).every((s: { ok: boolean }) => s.ok)).toBe(false);
    expect((await browser.verifyLedgerExport(dropped, sha)).ok).toBe(false);
  });
});

describe('GET /api/ledger/public', () => {
  it('serves the real broker export to anyone, with no credential, and the browser verifier accepts it', async () => {
    const { app } = await makeBroker();
    const f = fakeBroker();
    const call = async (method: string, path: string): Promise<{ status: number; json: unknown }> => {
      const r = await app.internal.inject({ method: method as 'GET', url: path, headers: { 'x-plumbline-api-token': secrets.apiToken } });
      return { status: r.statusCode, json: r.json() as unknown };
    };
    const api = await makeApi(f, { broker: { call, chat: f.broker.chat, mint: f.broker.mint } as never });
    const r = await api.app.inject({ method: 'GET', url: '/api/ledger/public' });
    expect(r.statusCode).toBe(200);
    expect((r.json() as LedgerExport).schema).toBe('plumbline-ledger-export/v2');
    expect((await browser.verifyLedgerExport(r.json(), sha)).ok).toBe(true);
  });
  it('the download variant is an attachment, and the route is rate limited per address', async () => {
    const f = fakeBroker(); const e = fixture();
    const call = async (m: string, p: string) => (p === '/v1/ledger/public' ? { status: 200, json: e } : f.broker.call(m, p));
    const api = await makeApi(f, { broker: { call, chat: f.broker.chat, mint: f.broker.mint } as never });
    const d = await api.app.inject({ method: 'GET', url: '/api/ledger/public?download=1' });
    expect(d.statusCode).toBe(200); expect(d.headers['content-disposition']).toContain('plumbline-ledger.json');
    let limited = 0; for (let i = 0; i < 40; i += 1) if ((await api.app.inject({ method: 'GET', url: '/api/ledger/public' })).statusCode === 429) limited += 1;
    expect(limited).toBeGreaterThan(0);
  });
  it('the exported text carries nothing credential-shaped', () => {
    expect(JSON.stringify(fixture())).not.toMatch(/api[_-]?key|secret|token|password|BEGIN [A-Z ]*KEY/i);
  });
});
