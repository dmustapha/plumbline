const SESSION_ID = /^[0-9a-f]{8}$/;
const CANARY_FILE = 'orders.json';
const WANTED_VERSIONS = 2;

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) throw new Error('SESSION_ID_INVALID: expected 8 lowercase hex characters');
}

/** AG4-PRD-6: each judge session gets its own virtual canary object, so approving a delete never touches the shared orders.json. */
export function sessionCanaryKey(sessionId: string): string {
  assertSessionId(sessionId);
  return `sessions/${sessionId}/${CANARY_FILE}`;
}

/** The only keys a session may read or write live under `sessions/<its id>/`, as plain segments (no traversal, no empty segment). */
export function assertSessionKey(sessionId: string, key: string): void {
  assertSessionId(sessionId);
  const prefix = `sessions/${sessionId}/`;
  const rest = key.startsWith(prefix) ? key.slice(prefix.length) : null;
  const segments = rest === null ? [] : rest.split('/');
  const clean = segments.length > 0 && segments.every((s) => s !== '' && s !== '.' && s !== '..');
  if (!clean) throw new Error(`SESSION_KEY_FORBIDDEN: ${sessionId} may only use keys under ${prefix}`);
}

export function canaryContent(sessionId: string, revision: number): string {
  return JSON.stringify({ canary: 'plumbline-orders-db', session: sessionId, revision });
}

export interface CanaryPort {
  versionCount(key: string): Promise<number>;
  put(key: string, body: string): Promise<string>;
}

/** Seeds the per-session canary until it has two versions (one delete is then reversible). Throws if the store does not grow. */
export async function ensureCanaryVersions(port: CanaryPort, sessionId: string): Promise<{ seeded: number; versions: number }> {
  const key = sessionCanaryKey(sessionId);
  const start = await port.versionCount(key);
  let have = start;
  while (have < WANTED_VERSIONS) {
    await port.put(key, canaryContent(sessionId, have + 1));
    const next = await port.versionCount(key);
    if (next <= have) throw new Error('CANARY_SEED_FAILED: version count did not grow after put');
    have = next;
  }
  return { seeded: have - start, versions: have };
}

const OPERATOR_PRINCIPALS = new Set(['system', 'owner']);

/**
 * The S3Store key guard. Sandbox sessions (8 hex ids) are confined to their own prefix; the broker's own
 * `system`/`owner` principals are not session-scoped; any other principal is refused.
 */
export function sessionKeyGuard(sessionId: string, key: string): void {
  if (OPERATOR_PRINCIPALS.has(sessionId)) return;
  assertSessionKey(sessionId, key);
}
