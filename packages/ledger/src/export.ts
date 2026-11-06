// File: packages/ledger/src/export.ts
// AG4-VER-1 (ledger side) + CO-2 E-1: the verifier's input. Every row is tied to a recorded decision, carries the full
// normalized request (so the policy engine can be re-run on live state), and rows are hash-chained so insertion,
// deletion or edit of any row is detectable. A chain with no external anchor cannot stop a party that recomputes the whole
// chain: the verifier pins `chain_head` (expect_head) and checks `generated_at` freshness.
import { createHash } from 'node:crypto';
import { canonicalJson, type LedgerRequestFields } from '@plumbline/policy-engine';
import type { Db } from './db.ts';
import { proofCounts, type ProofCounts } from './decisions.ts';

export const GENESIS_HASH = '0'.repeat(64);

type Req = LedgerRequestFields['request'];

export interface ExportDecision {
  seq: number;
  id: string;
  ts: number;
  decision: 'ALLOW' | 'ESCALATE' | 'DENY';
  rule_id: string;
  layer: string;
  session_id: string;
  verb: string;
  class: string;
  target_id: string | null;
  request_hash: string | null;
  plan: string | null;
  region: string | null;
  request: Req | null;
  prev_hash: string;
  row_hash: string;
}

export interface ExportResource {
  id: string;
  class: string;
  label: string;
  plan: string | null;
  region: string | null;
  created_at_ms: number;
  destroyed_at_ms: number | null;
  protected: boolean;
  allow_decision_id: string;
  allow_decision_kind: string | null;
  allow_request_hash: string | null;
  request: Req | null;
  prev_hash: string;
  row_hash: string;
}

export interface UnknownOutcome {
  request_id: string;
  session_id: string;
  method: string;
  path: string;
  estimate_usd: number;
  cause: string;
}

export interface ExportUnknown extends UnknownOutcome {
  ts: number;
  prev_hash: string;
  row_hash: string;
}

export interface LedgerExport {
  schema: 'plumbline-ledger-export/v2';
  generated_at: number;
  decision_count: number;
  decisions: ExportDecision[];
  resources: ExportResource[];
  unknown_outcomes: ExportUnknown[];
  counts: ProofCounts;
  chain_head: string;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const rowHash = (prev: string, body: object): string => sha(`${prev}\n${canonicalJson(body)}`);

function chain<T extends object>(rows: T[], start: string): { rows: (T & { prev_hash: string; row_hash: string })[]; head: string } {
  let prev = start;
  const out = rows.map((r) => {
    const hash = rowHash(prev, r);
    const row = { ...r, prev_hash: prev, row_hash: hash };
    prev = hash;
    return row;
  });
  return { rows: out, head: prev };
}

const parseReq = (j: string | null): Req | null => (j ? (JSON.parse(j) as Req) : null);

function unknownRows(db: Db): Omit<ExportUnknown, 'prev_hash' | 'row_hash'>[] {
  return listUnknownOutcomes(db).map((u) => ({ ...u.outcome, ts: u.ts }));
}

export function exportLedger(db: Db, now: number = Date.now()): LedgerExport {
  const dRows = (db.prepare(
    'SELECT rowid AS seq,id,ts,decision,rule_id,layer,session_id,verb,class,target_id,request_hash,plan,region,request_json FROM decisions ORDER BY rowid',
  ).all() as (Omit<ExportDecision, 'request' | 'prev_hash' | 'row_hash'> & { request_json: string | null })[])
    .map(({ request_json, ...r }) => ({ ...r, request: parseReq(request_json) }));
  const dChain = chain(dRows, GENESIS_HASH);
  const rRows = (db.prepare(
    `SELECT r.id,r.class,r.label,r.plan,d.region AS region,r.created_at_ms,r.destroyed_at_ms,r.protected,r.allow_decision_id,
            d.decision AS allow_decision_kind,d.request_hash AS allow_request_hash,d.request_json AS request_json
     FROM resources r LEFT JOIN decisions d ON d.id = r.allow_decision_id ORDER BY r.created_at_ms, r.id`,
  ).all() as (Omit<ExportResource, 'request' | 'protected' | 'prev_hash' | 'row_hash'> & { protected: number; request_json: string | null })[])
    .map(({ request_json, protected: p, ...r }) => ({ ...r, protected: p === 1, request: parseReq(request_json) }));
  const rChain = chain(rRows, dChain.head);
  const uChain = chain(unknownRows(db), rChain.head);
  return {
    schema: 'plumbline-ledger-export/v2',
    generated_at: now,
    decision_count: dRows.length,
    decisions: dChain.rows,
    resources: rChain.rows,
    unknown_outcomes: uChain.rows,
    counts: proofCounts(db),
    chain_head: uChain.head,
  };
}

export type ExportVerdict = { ok: true } | { ok: false; reason: 'STALE' | 'CHAIN_BROKEN' | 'SEQ_GAP' | 'COUNT_MISMATCH' | 'HEAD_MISMATCH' | 'RESOURCE_NOT_ALLOW_TIED'; detail?: string };

export interface VerifyOptions {
  now_ms: number;
  max_age_ms: number;
  /** the chain head the verifier pinned earlier (or got out of band); detects tail truncation and wholesale re-chaining */
  expect_head?: string;
}

const strip = <T extends { prev_hash: string; row_hash: string }>(r: T): Omit<T, 'prev_hash' | 'row_hash'> => {
  const { prev_hash: _p, row_hash: _h, ...rest } = r;
  return rest;
};
const fail = (reason: Extract<ExportVerdict, { ok: false }>['reason'], detail?: string): ExportVerdict => ({ ok: false, reason, ...(detail ? { detail } : {}) });

function walk(rows: { prev_hash: string; row_hash: string }[], start: string): { head: string; ok: boolean } {
  let prev = start;
  for (const r of rows) {
    if (r.prev_hash !== prev || r.row_hash !== rowHash(prev, strip(r))) return { head: prev, ok: false };
    prev = r.row_hash;
  }
  return { head: prev, ok: true };
}

export function verifyExport(exp: LedgerExport, o: VerifyOptions): ExportVerdict {
  const age = o.now_ms - exp.generated_at;
  if (typeof exp.generated_at !== 'number' || !Number.isFinite(exp.generated_at) || age > o.max_age_ms || age < -5000) return fail('STALE');
  const d = walk(exp.decisions, GENESIS_HASH);
  if (!d.ok) return fail('CHAIN_BROKEN', 'decisions');
  if (exp.decisions.some((r, i) => r.seq !== (exp.decisions[i - 1]?.seq ?? 0) + 1)) return fail('SEQ_GAP');
  if (exp.decision_count !== exp.decisions.length) return fail('COUNT_MISMATCH');
  const r = walk(exp.resources, d.head);
  if (!r.ok) return fail('CHAIN_BROKEN', 'resources');
  const u = walk(exp.unknown_outcomes, r.head);
  if (!u.ok) return fail('CHAIN_BROKEN', 'unknown_outcomes');
  if (exp.chain_head !== u.head) return fail('HEAD_MISMATCH');
  if (o.expect_head !== undefined && o.expect_head !== u.head) return fail('HEAD_MISMATCH', 'pinned head differs');
  const byId = new Map(exp.decisions.map((x) => [x.id, x]));
  for (const res of exp.resources) {
    const dec = byId.get(res.allow_decision_id);
    if (!dec || dec.decision !== 'ALLOW' || res.allow_decision_kind !== 'ALLOW' || dec.request_hash !== res.allow_request_hash) return fail('RESOURCE_NOT_ALLOW_TIED', res.id);
  }
  return { ok: true };
}

const UNKNOWN = 'OUTCOME_UNKNOWN';
const RESOLVED = 'OUTCOME_RESOLVED';

/** A mutation whose result was never seen (timeout/5xx after send). The broker records it; reconcile and the verifier see it. */
export function recordUnknownOutcome(db: Db, u: UnknownOutcome, now: number = Date.now()): void {
  db.prepare('INSERT INTO events(ts,kind,session_id,detail_json) VALUES(?,?,?,?)').run(now, UNKNOWN, u.session_id, JSON.stringify(u));
}

export function resolveUnknownOutcome(db: Db, requestId: string, note: string, now: number = Date.now()): void {
  db.prepare('INSERT INTO events(ts,kind,session_id,detail_json) VALUES(?,?,?,?)').run(now, RESOLVED, 'system', JSON.stringify({ request_id: requestId, note }));
}

export function listUnknownOutcomes(db: Db): { ts: number; outcome: UnknownOutcome }[] {
  const rows = db.prepare('SELECT ts,kind,detail_json FROM events WHERE kind IN (?,?) ORDER BY id').all(UNKNOWN, RESOLVED) as { ts: number; kind: string; detail_json: string }[];
  const open = new Map<string, { ts: number; outcome: UnknownOutcome }>();
  for (const r of rows) {
    const detail = JSON.parse(r.detail_json) as UnknownOutcome;
    if (r.kind === UNKNOWN) open.set(detail.request_id, { ts: r.ts, outcome: detail });
    else open.delete(detail.request_id);
  }
  return [...open.values()];
}
