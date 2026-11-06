// File: packages/policy-engine/src/hash.ts
import { createHash } from 'node:crypto';
import type { CallRequest, LedgerRequestFields } from './types.ts';

/**
 * Canonical JSON: keys sorted recursively. Object properties whose value is undefined are dropped (same as
 * JSON serialisation, so an absent and an undefined param hash alike). NaN, +-Infinity, undefined array items,
 * bigint, symbol and function values throw.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('REQUEST_HASH_NON_FINITE');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  throw new Error('REQUEST_HASH_UNSUPPORTED_VALUE');
}

/** sha256 hex of the canonical JSON of { verb, class, target_id, params }. Throws on NaN/Infinity/non-JSON values. */
export function requestHash(req: Pick<CallRequest, 'verb' | 'class' | 'target' | 'params'>): string {
  const body = { verb: req.verb, class: req.class, target_id: req.target?.id ?? null, params: req.params ?? {} };
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export function toLedgerRequestFields(req: CallRequest): LedgerRequestFields {
  const { plan, region } = req.params;
  return { ...(plan !== undefined ? { plan } : {}), ...(region !== undefined ? { region } : {}), request: { verb: req.verb, class: req.class, target: req.target, params: req.params } };
}
