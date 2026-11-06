// File: apps/broker/src/ledgerExport.ts
// CO-2 H-2 / E-1: the FROZEN contract the verifier reads. The row types live with the ledger writer
// (packages/ledger/src/export.ts); this module re-exports them as the broker's public type and documents the route.
// Documentation: apps/broker/docs/ledger-export.schema.md. Any change to the key set is a new schema id, never an edit.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { exportLedger, type Db, type LedgerExport } from '@plumbline/ledger';

export type { LedgerExport, ExportDecision, ExportResource, ExportUnknown } from '@plumbline/ledger';

export const LEDGER_EXPORT_SCHEMA = 'plumbline-ledger-export/v2' as const;

/** Every key of the frozen v2 export (the key SET is the contract; JSON object order is not). The freeze test pins these exactly. */
export const LEDGER_EXPORT_KEYS = {
  top: ['schema', 'generated_at', 'decision_count', 'decisions', 'resources', 'unknown_outcomes', 'counts', 'chain_head'],
  decision: ['seq', 'id', 'ts', 'decision', 'rule_id', 'layer', 'session_id', 'verb', 'class', 'target_id', 'request_hash', 'plan', 'region', 'request', 'prev_hash', 'row_hash'],
  resource: ['id', 'class', 'label', 'plan', 'region', 'created_at_ms', 'destroyed_at_ms', 'protected', 'allow_decision_id', 'allow_decision_kind', 'allow_request_hash', 'request', 'prev_hash', 'row_hash'],
} as const;

export function exportSignature(secret: string, ts: number): string {
  return createHmac('sha256', secret).update(`export.${ts}`).digest('hex');
}

export function verifyExportRequest(secret: string, tsHeader: string | undefined, sigHeader: string | undefined, now: number): boolean {
  const ts = Number(tsHeader);
  if (!sigHeader || !Number.isFinite(ts) || Math.abs(now - ts) > 30_000) return false;
  const want = Buffer.from(exportSignature(secret, ts));
  const got = Buffer.from(sigHeader);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function buildExport(db: Db, now: number): LedgerExport {
  return exportLedger(db, now);
}
