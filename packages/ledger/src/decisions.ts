// File: packages/ledger/src/decisions.ts
import { createHash, randomBytes } from 'node:crypto';
import { isGenuineDecision, type Decision } from '@plumbline/policy-engine';
import type { Db } from './db.ts';

export interface DecisionMeta {
  session_id: string;
  task_id: string;
  model: string | null;
  call: unknown;
  vultr_ids: string[];
}

export interface DecisionRow {
  id: string;
  ts: number;
  request_id: string;
  session_id: string;
  task_id: string;
  decision: 'ALLOW' | 'ESCALATE' | 'DENY';
  rule_id: string;
  layer: string;
  verb: string;
  class: string;
  model: string | null;
  call_hash: string;
  detail_json: string;
}

export function recordDecision(db: Db, d: Decision, meta: DecisionMeta, now: number = Date.now()): { id: string; ts: number } {
  if (!isGenuineDecision(d)) throw new Error('NOT_AN_ENGINE_DECISION');
  const id = `d-${now.toString(36)}-${randomBytes(4).toString('hex')}`;
  const callHash = createHash('sha256').update(JSON.stringify(meta.call ?? null)).digest('hex');
  const detail = JSON.stringify({ reason: d.reason, layers: d.layers, policy_version: d.policy_version, projected_cost_usd: d.projected_cost_usd, call: meta.call, vultr_ids: meta.vultr_ids });
  db.prepare(
    'INSERT INTO decisions(id,ts,request_id,session_id,task_id,decision,rule_id,layer,verb,class,model,call_hash,detail_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(id, now, d.request_id, meta.session_id, meta.task_id, d.decision, d.rule_id, d.layer, d.verb, d.class, meta.model, callHash, detail);
  return { id, ts: now };
}

export function recordEvent(db: Db, kind: string, sessionId: string, detail: unknown, now: number = Date.now()): number {
  const r = db.prepare('INSERT INTO events(ts,kind,session_id,detail_json) VALUES(?,?,?,?)').run(now, kind, sessionId, JSON.stringify(detail ?? null));
  return Number(r.lastInsertRowid);
}

export function listDecisions(db: Db, opts: { session_id?: string; limit?: number; before_ts?: number } = {}): DecisionRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.session_id) { where.push('session_id = ?'); args.push(opts.session_id); }
  if (opts.before_ts) { where.push('ts < ?'); args.push(opts.before_ts); }
  const sql = `SELECT * FROM decisions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ${limit}`;
  return db.prepare(sql).all(...args) as DecisionRow[];
}

export function getDecision(db: Db, id: string): DecisionRow | undefined {
  return db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as DecisionRow | undefined;
}

export interface ProofCounts {
  attacks: number;
  allow: number;
  escalate: number;
  deny: number;
  tasks: number;
  first_ts: number | null;
  last_ts: number | null;
}

export function proofCounts(db: Db): ProofCounts {
  const row = db.prepare(
    "SELECT COUNT(*) AS attacks, SUM(decision='ALLOW') AS allow, SUM(decision='ESCALATE') AS escalate, SUM(decision='DENY') AS deny, COUNT(DISTINCT task_id) AS tasks, MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM decisions WHERE session_id != 'system'",
  ).get() as { attacks: number; allow: number | null; escalate: number | null; deny: number | null; tasks: number; first_ts: number | null; last_ts: number | null };
  return { attacks: row.attacks, allow: row.allow ?? 0, escalate: row.escalate ?? 0, deny: row.deny ?? 0, tasks: row.tasks, first_ts: row.first_ts, last_ts: row.last_ts };
}

export function exportLedger(db: Db, now: number = Date.now()) {
  return {
    generated_at: now,
    resources: db.prepare('SELECT id,class,label,plan,created_at_ms,destroyed_at_ms,allow_decision_id,protected FROM resources').all(),
    decisions: db.prepare('SELECT id,ts,decision,rule_id,layer,session_id,verb,class FROM decisions ORDER BY ts').all(),
    counts: proofCounts(db),
  };
}
