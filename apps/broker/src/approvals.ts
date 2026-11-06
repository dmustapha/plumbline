// File: apps/broker/src/approvals.ts
import { randomBytes } from 'node:crypto';
import type { Db } from '@plumbline/ledger';
import type { ParsedCall } from './pipeline.ts';

const TTL_MS = 10 * 60_000;

export type TakeResult =
  | { kind: 'ok'; call: ParsedCall }
  | { kind: 'denied' | 'bad_nonce' | 'not_found' };

export class Approvals {
  constructor(private readonly db: Db) {}

  create(decisionId: string, sessionId: string, call: ParsedCall, now: number): string {
    const nonce = randomBytes(12).toString('hex');
    this.db.prepare("INSERT INTO approvals(decision_id, session_id, request_json, nonce, status, created_at_ms) VALUES (?,?,?,?, 'pending', ?)")
      .run(decisionId, sessionId, JSON.stringify(call), nonce, now);
    return nonce;
  }

  pending(sessionId: string, now: number): { decision_id: string; nonce: string; call: ParsedCall }[] {
    const rows = this.db.prepare("SELECT decision_id, nonce, request_json FROM approvals WHERE session_id = ? AND status = 'pending' AND created_at_ms > ?")
      .all(sessionId, now - TTL_MS) as { decision_id: string; nonce: string; request_json: string }[];
    return rows.map((r) => ({ decision_id: r.decision_id, nonce: r.nonce, call: JSON.parse(r.request_json) as ParsedCall }));
  }

  take(decisionId: string, sessionId: string, nonce: string, approve: boolean, now: number): TakeResult {
    const row = this.db.prepare('SELECT * FROM approvals WHERE decision_id = ? AND session_id = ?').get(decisionId, sessionId) as
      | { nonce: string; status: string; request_json: string; created_at_ms: number } | undefined;
    if (!row || row.status !== 'pending' || now - row.created_at_ms > TTL_MS) return { kind: 'not_found' };
    if (row.nonce !== nonce) return { kind: 'bad_nonce' };
    const next = approve ? 'approved' : 'denied';
    this.db.prepare('UPDATE approvals SET status = ?, decided_at_ms = ? WHERE decision_id = ?').run(next, now, decisionId);
    return approve ? { kind: 'ok', call: JSON.parse(row.request_json) as ParsedCall } : { kind: 'denied' };
  }
}
