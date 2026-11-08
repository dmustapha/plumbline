// FALSIFY (c): a tampered ledger export breaks the verifier's chain check.
// Make walk()/verifyExport always return ok and these go RED. The verifier's reconcile path calls this same verifyExport.
import { describe, expect, it } from 'vitest';
import { exportLedger, openDb, recordDecision, verifyExport, type LedgerExport } from '../../packages/ledger/src/index.ts';
import { createReq, decide } from '../../packages/ledger/test/support/engine.ts';

const OPTS = { now_ms: 5000, max_age_ms: 30_000 };

function fixture(): LedgerExport {
  const db = openDb(':memory:');
  for (let i = 0; i < 4; i += 1) {
    const r = createReq(`plumbline-wk-${i + 1}`);
    const d = decide(r);
    recordDecision(db, d, { session_id: r.session_id, task_id: r.task_id, model: null, call: null, vultr_ids: [], request: r }, 1000 + i);
  }
  return exportLedger(db, 5000);
}
const clone = (e: LedgerExport): LedgerExport => JSON.parse(JSON.stringify(e));

describe('FALSIFY (c) tampered ledger export is refused', () => {
  it('control: the untouched export verifies and the pinned head matches', () => {
    const e = fixture();
    expect(verifyExport(e, OPTS)).toEqual({ ok: true });
    expect(verifyExport(e, { ...OPTS, expect_head: e.chain_head })).toEqual({ ok: true });
  });
  it('one flipped character in a row field breaks the chain', () => {
    const e = clone(fixture());
    e.decisions[1]!.rule_id = e.decisions[1]!.rule_id.slice(0, -1) + (e.decisions[1]!.rule_id.endsWith('x') ? 'y' : 'x');
    expect(verifyExport(e, OPTS)).toMatchObject({ ok: false, reason: 'CHAIN_BROKEN' });
  });
  it('flipping a DENY into an ALLOW in a row is detected', () => {
    const e = clone(fixture());
    e.decisions[2]!.decision = e.decisions[2]!.decision === 'ALLOW' ? 'DENY' : 'ALLOW';
    expect(verifyExport(e, OPTS).ok).toBe(false);
  });
  it('removing a row (middle) is detected', () => {
    const e = clone(fixture());
    e.decisions.splice(1, 1);
    expect(verifyExport(e, OPTS).ok).toBe(false);
  });
  it('removing the tail row is detected against the pinned head', () => {
    const full = fixture();
    const e = clone(full);
    e.decisions.pop();
    e.decision_count = e.decisions.length;
    expect(verifyExport(e, { ...OPTS, expect_head: full.chain_head }).ok).toBe(false);
  });
  it('editing the head hash is detected', () => {
    const e = clone(fixture());
    e.chain_head = 'f'.repeat(64);
    expect(verifyExport(e, OPTS)).toMatchObject({ ok: false, reason: 'HEAD_MISMATCH' });
  });
  it('editing a row hash is detected', () => {
    const e = clone(fixture());
    e.decisions[0]!.row_hash = '0'.repeat(63) + '1';
    expect(verifyExport(e, OPTS).ok).toBe(false);
  });
  it('a stale export is refused', () => {
    expect(verifyExport(fixture(), { now_ms: 5000 + 120_000, max_age_ms: 30_000 })).toMatchObject({ ok: false, reason: 'STALE' });
  });
});
