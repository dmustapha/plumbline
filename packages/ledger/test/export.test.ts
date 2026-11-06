import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { requestHash } from '@plumbline/policy-engine';
import {
  Ledger, exportLedger, listUnknownOutcomes, openDb, recordDecision, recordUnknownOutcome, resolveUnknownOutcome, verifyExport,
  type Db,
} from '../src/index.ts';
import { createReq, decide, deleteReq, req } from './support/engine.ts';

const meta = (r = req()) => ({ session_id: r.session_id, task_id: r.task_id, model: null, call: null, vultr_ids: [], request: r });
const l = (db: Db) => new Ledger(db, { session_ceiling_usd: 1.5, global_cap_usd: 10 });
const allowCreate = (db: Db, n = 1) => {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const r = createReq(`plumbline-wk-${i + 1}`);
    const d = decide(r);
    if (d.decision !== 'ALLOW') throw new Error('expected ALLOW');
    const rec = recordDecision(db, d, meta(r), 1000 + i);
    out.push({ r, d, rec });
  }
  return out;
};
const res = (id: string, decisionId: string, label = 'plumbline-wk-1') =>
  ({ id, class: 'instance', label, plan: 'vc2-1c-1gb', hourly: 0.007, ttl_h: 1, protected: false, session_id: 's', allow_decision_id: decisionId });

describe('AG4-VER-1 / CO-2 E-1 ledger export carries the full request', () => {
  it('E-1 exported decision rows carry plan, region, request, request_hash and target_id', () => {
    const db = openDb(':memory:');
    const [a] = allowCreate(db);
    const row = exportLedger(db, 2000).decisions[0];
    expect(row).toMatchObject({ plan: 'vc2-1c-1gb', region: 'ewr', target_id: null, request_hash: requestHash(a!.r), decision: 'ALLOW' });
    expect(row?.request).toEqual({ verb: 'create', class: 'instance', target: {}, params: { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-1' } });
    expect(requestHash(row!.request!)).toBe(row?.request_hash);
  });
  it('E-1 a delete row carries its target id', () => {
    const db = openDb(':memory:');
    const r = deleteReq();
    const d = decide(r);
    if (d.decision !== 'ALLOW') throw new Error('expected ALLOW');
    recordDecision(db, d, meta(r));
    expect(exportLedger(db).decisions[0]).toMatchObject({ target_id: 'i-1', verb: 'delete' });
  });
  it('E-1 recordDecision refuses a request that is not the one the engine decided', () => {
    const db = openDb(':memory:');
    const r = createReq();
    const d = decide(r);
    const other = createReq();
    other.params = { plan: 'vc2-2c-4gb', region: 'sgp', label: 'plumbline-wk-1' };
    expect(() => recordDecision(db, d, meta(other))).toThrow('DECISION_REQUEST_MISMATCH');
    expect(() => recordDecision(db, d, { ...meta(r), request: undefined as never })).toThrow();
  });
  it('E-1 resource rows expose plan, region and the full request of the ALLOW they cite', () => {
    const db = openDb(':memory:');
    const [a] = allowCreate(db);
    l(db).recordResource(res('i-9', a!.rec.id));
    const row = exportLedger(db).resources[0];
    expect(row).toMatchObject({ id: 'i-9', plan: 'vc2-1c-1gb', region: 'ewr', allow_decision_kind: 'ALLOW', allow_request_hash: requestHash(a!.r) });
    expect(row?.request).toMatchObject({ verb: 'create', params: { plan: 'vc2-1c-1gb' } });
  });
});

describe('AG4-VER-1 resources are tied to ALLOW decisions', () => {
  it('AG4-VER-1 recordResource refuses a made-up decision id', () => {
    const db = openDb(':memory:');
    expect(() => l(db).recordResource(res('i-1', 'd-made-up'))).toThrow('RESOURCE_NOT_TIED_TO_ALLOW');
  });
  it('AG4-VER-1 recordResource refuses a DENY or ESCALATE decision', () => {
    const db = openDb(':memory:');
    const r = req({ verb: 'delete', class: 'instance', target: { id: 'i-1', label: 'prod-db', tags: [], resolved: true } });
    const d = decide(r);
    expect(d.decision).not.toBe('ALLOW');
    const rec = recordDecision(db, d, meta(r));
    expect(() => l(db).recordResource(res('i-1', rec.id))).toThrow('RESOURCE_NOT_TIED_TO_ALLOW');
  });
  it('AG4-VER-1 recordResource refuses an ALLOW of another resource class', () => {
    const db = openDb(':memory:');
    const [a] = allowCreate(db);
    expect(() => l(db).recordResource({ ...res('fw-1', a!.rec.id), class: 'firewall_group' })).toThrow('RESOURCE_NOT_TIED_TO_ALLOW');
  });
});

describe('AG4-VER-1 hash-chained, monotonic, fresh export', () => {
  it('AG4-VER-1 rows have a gapless monotonic seq and verifyExport accepts an intact export', () => {
    const db = openDb(':memory:');
    const all = allowCreate(db, 3);
    l(db).recordResource(res('i-1', all[0]!.rec.id));
    const exp = exportLedger(db, 5000);
    expect(exp.decisions.map((d) => d.seq)).toEqual([1, 2, 3]);
    expect(exp.generated_at).toBe(5000);
    expect(exp.decision_count).toBe(3);
    expect(verifyExport(exp, { now_ms: 5001, max_age_ms: 30_000 })).toEqual({ ok: true });
  });
  it('AG4-VER-1 a modified row is detected', () => {
    const db = openDb(':memory:');
    allowCreate(db, 2);
    const exp = JSON.parse(JSON.stringify(exportLedger(db, 5000)));
    exp.decisions[0].plan = 'vc2-1c-1gb-lies';
    expect(verifyExport(exp, { now_ms: 5000, max_age_ms: 30_000 })).toMatchObject({ ok: false, reason: 'CHAIN_BROKEN' });
  });
  it('AG4-VER-1 a deleted middle row and an inserted row are detected', () => {
    const db = openDb(':memory:');
    allowCreate(db, 3);
    const base = exportLedger(db, 5000);
    const cut = JSON.parse(JSON.stringify(base));
    cut.decisions.splice(1, 1);
    expect(verifyExport(cut, { now_ms: 5000, max_age_ms: 30_000 }).ok).toBe(false);
    const ins = JSON.parse(JSON.stringify(base));
    ins.decisions.splice(1, 0, { ...ins.decisions[1], id: 'd-forged' });
    expect(verifyExport(ins, { now_ms: 5000, max_age_ms: 30_000 }).ok).toBe(false);
  });
  it('AG4-VER-1 tail truncation is caught against a pinned head or count', () => {
    const db = openDb(':memory:');
    allowCreate(db, 3);
    const full = exportLedger(db, 5000);
    const cut = JSON.parse(JSON.stringify(full));
    cut.decisions.pop();
    expect(verifyExport(cut, { now_ms: 5000, max_age_ms: 30_000 }).ok).toBe(false);
    expect(verifyExport(full, { now_ms: 5000, max_age_ms: 30_000, expect_head: 'f'.repeat(64) })).toMatchObject({ ok: false, reason: 'HEAD_MISMATCH' });
    expect(verifyExport(full, { now_ms: 5000, max_age_ms: 30_000, expect_head: full.chain_head })).toEqual({ ok: true });
  });
  it('AG4-VER-1 a stale export is refused', () => {
    const db = openDb(':memory:');
    allowCreate(db);
    const exp = exportLedger(db, 5000);
    expect(verifyExport(exp, { now_ms: 5000 + 60_000, max_age_ms: 30_000 })).toMatchObject({ ok: false, reason: 'STALE' });
    expect(verifyExport({ ...exp, generated_at: undefined } as never, { now_ms: 5000, max_age_ms: 30_000 }).ok).toBe(false);
  });
  it('AG4-VER-1 a resource row rewritten to cite a non-ALLOW decision is detected', () => {
    const db = openDb(':memory:');
    const [a] = allowCreate(db);
    l(db).recordResource(res('i-1', a!.rec.id));
    const exp = JSON.parse(JSON.stringify(exportLedger(db, 5000)));
    exp.resources[0].allow_decision_kind = 'DENY';
    expect(verifyExport(exp, { now_ms: 5000, max_age_ms: 30_000 }).ok).toBe(false);
    const exp2 = JSON.parse(JSON.stringify(exportLedger(db, 5000)));
    exp2.resources[0].allow_decision_id = 'd-nope';
    expect(verifyExport(exp2, { now_ms: 5000, max_age_ms: 30_000 }).ok).toBe(false);
  });
});

describe('AG4-ADP-5 unknown outcomes are visible to reconcile', () => {
  it('AG4-ADP-5 an unknown create is exported until it is resolved', () => {
    const db = openDb(':memory:');
    recordUnknownOutcome(db, { request_id: 'req-9', session_id: 's', method: 'POST', path: '/instances', estimate_usd: 0.007, cause: 'TimeoutError' }, 100);
    expect(listUnknownOutcomes(db)).toHaveLength(1);
    const exp = exportLedger(db, 200);
    expect(exp.unknown_outcomes[0]).toMatchObject({ request_id: 'req-9', path: '/instances' });
    expect(verifyExport(exp, { now_ms: 200, max_age_ms: 30_000 })).toEqual({ ok: true });
    resolveUnknownOutcome(db, 'req-9', 'instance i-1 found by reconcile', 300);
    expect(listUnknownOutcomes(db)).toHaveLength(0);
    expect(exportLedger(db, 400).unknown_outcomes).toHaveLength(0);
  });
});

describe('migration safety', () => {
  it('E-1 an old-schema decisions table gains the new columns and stays append-only', () => {
    const path = `${mkdtempSync(`${tmpdir()}/plumbline-ledger-`)}/old.db`;
    const old = new Database(path);
    old.exec(`CREATE TABLE decisions (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, request_id TEXT NOT NULL, session_id TEXT NOT NULL, task_id TEXT NOT NULL,
      decision TEXT NOT NULL, rule_id TEXT NOT NULL, layer TEXT NOT NULL, verb TEXT NOT NULL, class TEXT NOT NULL, model TEXT, call_hash TEXT NOT NULL, detail_json TEXT NOT NULL);`);
    old.close();
    const db = openDb(path);
    allowCreate(db);
    expect(exportLedger(db).decisions[0]?.plan).toBe('vc2-1c-1gb');
    expect(() => db.prepare("UPDATE decisions SET decision='ALLOW'").run()).toThrow('append-only');
    expect(() => db.prepare('DELETE FROM decisions').run()).toThrow('append-only');
  });
});
