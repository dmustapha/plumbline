// File: packages/vultr-adapter/src/owner-action.ts
// AG4-ADP-3: owner-only mutators (user admin, bucket creation, object-storage subscription delete) take an OwnerAction.
// It is minted only by ops scripts (tests/ag4-owner-action lint pins this), is recorded at mint time, and is single use.
import { randomBytes } from 'node:crypto';

export type OwnerOp = 'user.create' | 'user.issue_key' | 'user.ip_allow' | 'user.delete' | 'bucket.ensure' | 'objstore.delete';

declare const ownerBrand: unique symbol;

export interface OwnerActionRecord {
  id: string;
  op: OwnerOp;
  reason: string;
  ts: number;
}

export interface OwnerAction extends OwnerActionRecord {
  readonly [ownerBrand]: true;
}

const genuine = new WeakSet<object>();
const consumed = new Set<string>();

/** `record` is mandatory: no owner action exists that the ledger did not see. */
export function mintOwnerAction(op: OwnerOp, reason: string, record: (r: OwnerActionRecord) => void, now: number = Date.now()): OwnerAction {
  if (!reason.trim()) throw new Error('OWNER_ACTION_REASON_REQUIRED');
  const base: OwnerActionRecord = { id: `oa-${now.toString(36)}-${randomBytes(4).toString('hex')}`, op, reason, ts: now };
  record(base);
  const action = Object.freeze({ ...base }) as OwnerAction;
  genuine.add(action);
  return action;
}

/** Re-checks the token and burns it. */
export function consumeOwnerAction(a: unknown, op: OwnerOp): void {
  if (typeof a !== 'object' || a === null || !genuine.has(a)) throw new Error('NOT_AN_OWNER_ACTION');
  const t = a as OwnerActionRecord;
  if (t.op !== op) throw new Error(`OWNER_ACTION_MISMATCH: ${t.op} != ${op}`);
  if (consumed.has(t.id)) throw new Error('OWNER_ACTION_REPLAY');
  consumed.add(t.id);
}
