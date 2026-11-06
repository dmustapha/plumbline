import { describe, expect, it } from 'vitest';
import { assertSessionKey, canaryContent, ensureCanaryVersions, sessionCanaryKey, sessionKeyGuard, type CanaryPort } from '../src/index.ts';

const A = 'ab12cd34';
const B = 'ef56ab90';

describe('AG4-PRD-6 per-session virtual canary keys', () => {
  it('AG4-PRD-6 the canary key is session-prefixed and never the shared orders.json', () => {
    expect(sessionCanaryKey(A)).toBe(`sessions/${A}/orders.json`);
    expect(sessionCanaryKey(A)).not.toBe('orders.json');
  });
  it('AG4-PRD-6 a session may only touch its own prefix', () => {
    expect(() => assertSessionKey(A, sessionCanaryKey(A))).not.toThrow();
    expect(() => assertSessionKey(A, 'orders.json')).toThrow('SESSION_KEY_FORBIDDEN');
    expect(() => assertSessionKey(A, sessionCanaryKey(B))).toThrow('SESSION_KEY_FORBIDDEN');
  });
  it('AG4-PRD-6 traversal and prefix tricks are refused', () => {
    for (const k of [`sessions/${A}/../orders.json`, `sessions/${A}/../../orders.json`, `sessions/${A}x/orders.json`, `sessions/${A}`, `/sessions/${A}/orders.json`, `sessions/${A}//orders.json`]) {
      expect(() => assertSessionKey(A, k), k).toThrow('SESSION_KEY_FORBIDDEN');
    }
  });
  it('AG4-PRD-6 a malformed session id cannot build a key', () => {
    for (const s of ['', 'system', 'AB12CD34', 'ab12cd3', 'ab12cd345', '../abcdef']) {
      expect(() => sessionCanaryKey(s), s).toThrow('SESSION_ID_INVALID');
    }
  });
  it('canary content is deterministic and distinct per version', () => {
    expect(canaryContent(A, 1)).toBe(canaryContent(A, 1));
    expect(canaryContent(A, 1)).not.toBe(canaryContent(A, 2));
    expect(JSON.parse(canaryContent(A, 2))).toMatchObject({ session: A, revision: 2 });
  });
});

describe('sessionKeyGuard (the S3Store guard)', () => {
  it('AG4-PRD-6 confines sandbox sessions, lets broker principals through, refuses unknown principals', () => {
    expect(() => sessionKeyGuard(A, sessionCanaryKey(A))).not.toThrow();
    expect(() => sessionKeyGuard(A, 'orders.json')).toThrow('SESSION_KEY_FORBIDDEN');
    expect(() => sessionKeyGuard('system', 'orders.json')).not.toThrow();
    expect(() => sessionKeyGuard('mallory', 'orders.json')).toThrow('SESSION_ID_INVALID');
  });
});

describe('ensureCanaryVersions', () => {
  const fake = (existing: number): { port: CanaryPort; puts: { key: string; body: string }[] } => {
    const puts: { key: string; body: string }[] = [];
    let n = existing;
    const port: CanaryPort = {
      versionCount: async () => n,
      put: async (key, body) => { puts.push({ key, body }); n += 1; return `v${n}`; },
    };
    return { port, puts };
  };
  it('seeds up to two versions under the session key', async () => {
    const { port, puts } = fake(0);
    await expect(ensureCanaryVersions(port, A)).resolves.toEqual({ seeded: 2, versions: 2 });
    expect(puts.map((p) => p.key)).toEqual([sessionCanaryKey(A), sessionCanaryKey(A)]);
    expect(new Set(puts.map((p) => p.body)).size).toBe(2);
  });
  it('writes nothing when two versions already exist', async () => {
    const { port, puts } = fake(2);
    await expect(ensureCanaryVersions(port, A)).resolves.toEqual({ seeded: 0, versions: 2 });
    expect(puts).toHaveLength(0);
  });
  it('a store that cannot report its version count fails closed, writes nothing', async () => {
    const { port, puts } = fake(0);
    port.versionCount = async () => { throw new Error('S3 down'); };
    await expect(ensureCanaryVersions(port, A)).rejects.toThrow('S3 down');
    expect(puts).toHaveLength(0);
  });
  it('a store that does not grow after put is reported, not looped forever', async () => {
    const port: CanaryPort = { versionCount: async () => 0, put: async () => 'v' };
    await expect(ensureCanaryVersions(port, A)).rejects.toThrow('CANARY_SEED_FAILED');
  });
});
