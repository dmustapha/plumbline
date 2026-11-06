// File: packages/policy-engine/src/brand.ts
// Internal to the engine: NOT re-exported from index.ts, so only engine modules can mint a genuine Decision.
import type { Decision } from './types.ts';

const genuine = new WeakSet<object>();

export function mint<T extends Decision>(d: Omit<T, never>): T {
  const frozen = Object.freeze({ ...d }) as T;
  genuine.add(frozen);
  return frozen;
}

export function isGenuineDecision(d: unknown): d is Decision {
  return typeof d === 'object' && d !== null && genuine.has(d);
}
