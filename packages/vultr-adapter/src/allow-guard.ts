// File: packages/vultr-adapter/src/allow-guard.ts
// AG4-ADP-2: the single place an executor checks a decision. Bound to the exact call, usable once.
import { assertAllow, type AllowDecision, type CallRequest, type ResourceClass, type Verb } from '@plumbline/policy-engine';
import type { Ctx } from './resources.ts';

const consumed = new Set<string>();

/** Throws unless `allow` is the engine ALLOW minted for exactly `req` (verb, class, target id, params), then burns it. */
export function guard(allow: AllowDecision, req: CallRequest, verb: Verb, cls: ResourceClass): Ctx {
  if (req.verb !== verb || req.class !== cls) throw new Error(`ALLOW_MISMATCH: ${req.verb} ${req.class} != ${verb} ${cls}`);
  assertAllow(allow, req);
  if (allow.request_id !== req.request_id) throw new Error('ALLOW_REQUEST_MISMATCH: request_id');
  if (consumed.has(allow.request_id)) throw new Error('ALLOW_REPLAY');
  consumed.add(allow.request_id);
  return { session_id: req.session_id };
}

export function targetId(req: CallRequest): string {
  const id = req.target?.id;
  if (typeof id !== 'string' || id === '') throw new Error('TARGET_ID_REQUIRED');
  return id;
}

export function need(value: string | number | undefined, name: string): string {
  if (value === undefined || value === '') throw new Error(`PARAM_REQUIRED: ${name}`);
  return String(value);
}
