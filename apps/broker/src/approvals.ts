// File: apps/broker/src/approvals.ts
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { Db } from '@plumbline/ledger';
import { NonceStore, approvalDecisionId, approvalMessage, approveEscalation, type AllowDecision, type EscalateDecision } from '@plumbline/policy-engine';
import type { ParsedCall } from './pipeline.ts';

const TTL_MS = 10 * 60_000;

/** What the human approved (AG4-BRK-5): this escalation, this rule, this request hash, this resolved target. */
export interface Binding {
  request_id: string;
  rule_id: string;
  request_hash: string;
  target_fp: string;
}

export type TakeResult =
  | { kind: 'ok'; call: ParsedCall; binding: Binding }
  | { kind: 'denied' | 'bad_nonce' | 'not_found' };

interface Envelope {
  call: ParsedCall;
  binding: Binding;
}

/**
 * Signs approvals for the engine's signature check. The key is generated in broker memory at boot and never leaves it:
 * it stands for the authenticated session owner (range-api route, session-bound, single-use nonce). The offline owner
 * key stays reserved for production-policy changes. The engine still verifies signature, nonce single-use and the
 * (request id, rule id, request hash) binding, so a stale or foreign escalation cannot be turned into an ALLOW.
 */
export class ApprovalAuthority {
  readonly nonces = new NonceStore();
  readonly publicKeyB64: string;
  readonly #priv: KeyObject;

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    this.#priv = privateKey;
    this.publicKeyB64 = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64');
  }

  approve(escalation: EscalateDecision, b: Binding, nonce: string): AllowDecision {
    const msg = approvalMessage(approvalDecisionId({ request_id: b.request_id, rule_id: b.rule_id }), nonce, b.request_hash);
    const signature = sign(null, Buffer.from(msg, 'utf8'), this.#priv).toString('base64');
    return approveEscalation(escalation, { nonce, signature }, { publicKey: this.publicKeyB64, nonceStore: this.nonces });
  }
}

export class Approvals {
  constructor(private readonly db: Db) {}

  create(decisionId: string, sessionId: string, call: ParsedCall, now: number, binding: Binding): string {
    const nonce = randomBytes(12).toString('hex');
    this.db.prepare("INSERT INTO approvals(decision_id, session_id, request_json, nonce, status, created_at_ms) VALUES (?,?,?,?, 'pending', ?)")
      .run(decisionId, sessionId, JSON.stringify({ call, binding } satisfies Envelope), nonce, now);
    return nonce;
  }

  pending(sessionId: string, now: number): { decision_id: string; nonce: string; call: ParsedCall }[] {
    const rows = this.db.prepare("SELECT decision_id, nonce, request_json FROM approvals WHERE session_id = ? AND status = 'pending' AND created_at_ms > ?")
      .all(sessionId, now - TTL_MS) as { decision_id: string; nonce: string; request_json: string }[];
    return rows.map((r) => ({ decision_id: r.decision_id, nonce: r.nonce, call: (JSON.parse(r.request_json) as Envelope).call }));
  }

  take(decisionId: string, sessionId: string, nonce: string, approve: boolean, now: number): TakeResult {
    const row = this.db.prepare('SELECT * FROM approvals WHERE decision_id = ? AND session_id = ?').get(decisionId, sessionId) as
      | { nonce: string; status: string; request_json: string; created_at_ms: number } | undefined;
    if (!row || row.status !== 'pending' || now - row.created_at_ms > TTL_MS) return { kind: 'not_found' };
    if (row.nonce !== nonce) return { kind: 'bad_nonce' };
    const next = approve ? 'approved' : 'denied';
    this.db.prepare('UPDATE approvals SET status = ?, decided_at_ms = ? WHERE decision_id = ?').run(next, now, decisionId);
    const env = JSON.parse(row.request_json) as Envelope;
    return approve ? { kind: 'ok', call: env.call, binding: env.binding } : { kind: 'denied' };
  }
}
