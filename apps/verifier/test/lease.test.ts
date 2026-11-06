import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LeaseReceiver, assertSharedDir, leaseSignature, leaseState, readLease } from '../src/lease.ts';

const SECRET = 'lease-secret';
const NOW = 5_000_000;
const dir = (mode = 0o700): string => {
  const d = mkdtempSync(join(tmpdir(), 'plb-lease-'));
  chmodSync(d, mode);
  return d;
};
const beat = (r: LeaseReceiver, ts: number, nonce: string, ttl: number, secret = SECRET) => r.accept({ ts, nonce, ttl_s: ttl }, leaseSignature(secret, ts, nonce, ttl));

describe('LeaseReceiver', () => {
  it('accepts a signed heartbeat and writes lease.json mode 0640 (AG4-VER-3)', () => {
    const d = dir();
    const r = new LeaseReceiver(SECRET, d, () => NOW);
    expect(beat(r, NOW, 'aaaaaaaa1', 120)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(d, 'lease.json'), 'utf8'))).toEqual({ last_ts: NOW, ttl_s: 120, received_at: NOW });
    expect(statSync(join(d, 'lease.json')).mode & 0o777).toBe(0o640);
  });

  it('AG4-VER-2: ttl_s above the bound is refused and never extends the lease', () => {
    const d = dir();
    const r = new LeaseReceiver(SECRET, d, () => NOW);
    expect(beat(r, NOW, 'aaaaaaaa1', 60)).toEqual({ ok: true });
    expect(beat(r, NOW + 1, 'aaaaaaaa2', 3_153_600_000)).toEqual({ ok: false, why: 'ttl-too-large' });
    expect(beat(r, NOW + 2, 'aaaaaaaa3', 121)).toEqual({ ok: false, why: 'ttl-too-large' });
    expect(readLease(d)?.ttl_s).toBe(60);
  });

  it('AG4-VER-2: the bound is configurable downward', () => {
    const r = new LeaseReceiver(SECRET, dir(), () => NOW, 60);
    expect(beat(r, NOW, 'aaaaaaaa1', 61).why).toBe('ttl-too-large');
    expect(beat(r, NOW, 'aaaaaaaa2', 60).ok).toBe(true);
  });

  it('refuses malformed bodies: negative, fractional, NaN ttl, short nonce, no signature', () => {
    const r = new LeaseReceiver(SECRET, dir(), () => NOW);
    for (const b of [{ ts: NOW, nonce: 'aaaaaaaa1', ttl_s: -1 }, { ts: NOW, nonce: 'aaaaaaaa1', ttl_s: 1.5 }, { ts: NOW, nonce: 'aaaaaaaa1', ttl_s: NaN }, { ts: NOW, nonce: 'short', ttl_s: 5 }]) {
      expect(r.accept(b, leaseSignature(SECRET, b.ts, b.nonce, b.ttl_s)).why).toBe('malformed');
    }
    expect(r.accept({ ts: NOW, nonce: 'aaaaaaaa1', ttl_s: 5 }, undefined).why).toBe('malformed');
  });

  it('refuses skew, bad signature, replay', () => {
    const r = new LeaseReceiver(SECRET, dir(), () => NOW);
    expect(beat(r, NOW - 31_000, 'aaaaaaaa1', 5).why).toBe('skew');
    expect(beat(r, NOW, 'aaaaaaaa2', 5, 'wrong-secret').why).toBe('signature');
    expect(beat(r, NOW, 'aaaaaaaa3', 5).ok).toBe(true);
    expect(beat(r, NOW + 5, 'aaaaaaaa3', 5).why).toBe('replay');
  });

  it('a captured older heartbeat cannot revive the lease after a kill-switch ttl 0, even after a restart (stale-ts)', () => {
    const d = dir();
    let r = new LeaseReceiver(SECRET, d, () => NOW + 10_000);
    expect(beat(r, NOW + 1000, 'oldbeat01', 120).ok).toBe(true);
    expect(beat(r, NOW + 5000, 'killbeat1', 0).ok).toBe(true);
    r = new LeaseReceiver(SECRET, d, () => NOW + 10_000);
    expect(beat(r, NOW + 1000, 'oldbeat02', 120).why).toBe('stale-ts');
    expect(readLease(d)?.ttl_s).toBe(0);
  });

  it('ttl_s 0 is accepted and means expire now', () => {
    const d = dir();
    const r = new LeaseReceiver(SECRET, d, () => NOW);
    expect(beat(r, NOW, 'aaaaaaaa1', 0).ok).toBe(true);
    expect(leaseState(readLease(d), NOW)).toBe('LAPSED');
  });
});

describe('AG4-VER-3: the shared dir is enforced', () => {
  it('refuses a world-accessible dir', () => {
    expect(() => new LeaseReceiver(SECRET, dir(0o755))).toThrow('BOOT_REFUSED');
    expect(() => assertSharedDir(dir(0o770 | 0o001))).toThrow('world-accessible');
  });
  it('refuses a group-writable dir without the sticky bit and accepts 1770', () => {
    expect(() => assertSharedDir(dir(0o770))).toThrow('sticky');
    expect(() => assertSharedDir(dir(0o1770))).not.toThrow();
  });
  it('creates a missing dir as 1770', () => {
    const d = join(dir(), 'shared');
    new LeaseReceiver(SECRET, d);
    expect(statSync(d).mode & 0o7777).toBe(0o1770);
  });
});

describe('readLease fails closed', () => {
  const put = (d: string, body: string, mode = 0o640): string => {
    const f = join(d, 'lease.json');
    writeFileSync(f, body, { mode });
    chmodSync(f, mode);
    return d;
  };
  const good = JSON.stringify({ last_ts: NOW, ttl_s: 60, received_at: NOW });

  it('reads a good file', () => expect(readLease(put(dir(), good))).toEqual({ last_ts: NOW, ttl_s: 60, received_at: NOW }));
  it('null for missing, garbage, mistyped, negative or over-bound ttl', () => {
    expect(readLease(dir())).toBeNull();
    expect(readLease(put(dir(), '{not json'))).toBeNull();
    expect(readLease(put(dir(), JSON.stringify({ last_ts: 'x', ttl_s: 60, received_at: NOW })))).toBeNull();
    expect(readLease(put(dir(), JSON.stringify({ last_ts: NOW, ttl_s: -1, received_at: NOW })))).toBeNull();
    expect(readLease(put(dir(), JSON.stringify({ last_ts: NOW, ttl_s: 3_000_000, received_at: NOW })))).toBeNull();
  });
  it('null for a group- or world-writable file (anyone could have written it)', () => {
    expect(readLease(put(dir(), good, 0o660))).toBeNull();
    expect(readLease(put(dir(), good, 0o602))).toBeNull();
  });
  it('null for a symlink and for a file owned by another uid', () => {
    const d = dir();
    const real = join(dir(), 'real.json');
    writeFileSync(real, good, { mode: 0o640 });
    symlinkSync(real, join(d, 'lease.json'));
    expect(readLease(d)).toBeNull();
    const own = put(dir(), good);
    expect(readLease(own, { uid: process.getuid!() })).not.toBeNull();
    expect(readLease(own, { uid: process.getuid!() + 1 })).toBeNull();
  });
  it('never throws on a directory that does not exist', () => {
    const missing = join(dir(), 'nope');
    mkdirSync(join(dir(), 'x'));
    expect(readLease(missing)).toBeNull();
  });
});

describe('leaseState', () => {
  const l = (over = {}) => ({ last_ts: NOW, ttl_s: 60, received_at: NOW, ...over });
  it('ALIVE inside the ttl, LAPSED after', () => {
    expect(leaseState(l(), NOW + 59_000)).toBe('ALIVE');
    expect(leaseState(l(), NOW + 61_000)).toBe('LAPSED');
  });
  it('ttl 0 and a received_at far in the future are LAPSED', () => {
    expect(leaseState(l({ ttl_s: 0 }), NOW)).toBe('LAPSED');
    expect(leaseState(l({ received_at: NOW + 3_600_000 }), NOW)).toBe('LAPSED');
  });
  it('null lease: NEVER only inside the first-contact grace, then LAPSED (fail closed)', () => {
    expect(leaseState(null, NOW + 100_000, { startedAt: NOW })).toBe('NEVER');
    expect(leaseState(null, NOW + 121_000, { startedAt: NOW })).toBe('LAPSED');
    expect(leaseState(null, NOW + 20_000, { startedAt: NOW, graceMs: 10_000 })).toBe('LAPSED');
  });
  it('null lease with no context, or after the lease was ever seen alive, is LAPSED at once', () => {
    expect(leaseState(null, NOW)).toBe('LAPSED');
    expect(leaseState(null, NOW + 1000, { startedAt: NOW, everSeen: true })).toBe('LAPSED');
  });
});
