// File: apps/broker/src/canary.ts
// CO-E (L6 wiring): which object keys a session may touch, and which key is its rewind canary.
import { sessionCanaryKey, sessionKeyGuard } from '@plumbline/rewind';
import type { KeyGuard } from '@plumbline/vultr-adapter';

const SESSION_ID = /^[0-9a-f]{8}$/;
const BOND_SCENE_KEY = /^bond-scene\/[A-Za-z0-9._-]{1,64}$/;
const SHARED_CANARY = 'orders.json';

/**
 * The key a call names when it names none. A real session gets its own canary; the broker's own principals
 * (`system`, tests with non-hex ids) fall back to the shared bootstrap object, which a session can never reach
 * because the store's key guard refuses it.
 */
export function canaryKeyFor(sessionId: string): string {
  return SESSION_ID.test(sessionId) ? sessionCanaryKey(sessionId) : SHARED_CANARY;
}

/** The S3Store key guard: sessions stay under `sessions/<id>/`; the bond scene prefix is open only while the bond is enabled. */
export function brokerKeyGuard(bondEnabled: boolean): KeyGuard {
  return (sessionId, key) => {
    if (bondEnabled && BOND_SCENE_KEY.test(key)) return;
    sessionKeyGuard(sessionId, key);
  };
}
