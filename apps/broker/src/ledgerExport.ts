// File: apps/broker/src/ledgerExport.ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import { exportLedger, type Db } from '@plumbline/ledger';

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

export function buildExport(db: Db, now: number) {
  return exportLedger(db, now);
}
